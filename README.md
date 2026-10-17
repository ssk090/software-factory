# software-factory

<img width="2315" height="1313" alt="image" src="https://github.com/user-attachments/assets/a0b5a1d5-e585-4ba0-a899-105e863b22f4" />


Turn a tracker ticket, or a production error, into a reviewed pull request. The factory's core is
built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable): every ticket is
a durable task, every agent step is a durable conversation, and all of it lives in one session file.
Kill the process at any moment and the next start continues each ticket where it was, mid agent step.

    Sentry issue ─┐
                  ├─> ticket -> spec -> plan -> (you approve) -> tests (red) -> code (green) -> docs
    sprint task ──┘      -> PR summary -> draft PR -> review <-> fix -> PR summary again -> judge -> PR ready

It is spec-driven: the spec's numbered acceptance criteria become failing tests before any code
exists, the coder makes them pass, and the reviewer and the judge check every criterion. The factory
never merges. A human merges.

One dashboard shows what needs you:
- **Fix first:** production issues from Sentry, ranked by how much they need a fix. *Fix this* makes a
  ClickUp ticket from the issue (with the latest stack trace) and plans its spec. *Dismiss* hides it
  until Sentry marks it regressed.
- **My sprint:** your tasks in the current ClickUp sprint. *Plan spec* runs the spec writer and the
  planner; you read the spec on the dashboard and *Approve and build* (a note goes to the coder).
- **Factory runs:** every ticket, its steps and models, its spec, plan and reviews, a live view of the
  agent at work, and a box to *steer* it while it runs.

Needs: Node 22.19 or newer, git 2.31 or newer, gh, Docker (for the sandbox), a ClickUp token, and an
API key for at least one model provider (Anthropic, OpenAI, ...). Sentry is optional.

Ideas taken from:
- [Pi Durable](https://earendil.com/posts/pi-durable/): the runtime. Tasks with checkpoints, conversations owned by tasks, documents committed with them, steering, watches.
- [super-board](https://github.com/EricTechPro/super-board): the board status is the ticket's public state, the orchestrator never writes code, each step is a fresh agent, the reviewer is a separate agent, one worktree per ticket, nothing merges without a gate.
- [jroute](https://github.com/ssk090/jroute): an ordered model chain per role.
- [sandcastle](https://github.com/mattpocock/sandcastle): agents' commands run in a container.
- [fluent](https://github.com/mrinalwadhwa/fluent): the orchestrator runs the checks itself instead of trusting an agent, and records a baseline so failures already on the base branch are not blamed on the coder.
- [conveyor](https://github.com/kidus-tiliksew/conveyor): fail closed when a branch is checked out in two places, and clean up a worktree once its PR is merged.
- [sdlc](https://github.com/bbsnly/sdlc): spec tests are frozen by hash once written, readers may not write, and a pool of parallel workers.
- [Superpowers](https://github.com/obra/superpowers) (obra), [ponytail](https://github.com/dietrichgebert/ponytail) and [mattpocock/skills](https://github.com/mattpocock/skills): skills for the agents.

---

## How it is built: Pi Durable

`ff serve` is one Node process that owns the factory's session, `state/factory.sqlite`, and runs
everything in it. Pi Durable has one owner per session, so the CLI and the dashboard talk to this
process; they never open the file themselves.

| What | As Pi Durable | Code | Example it follows |
|---|---|---|---|
| A ticket's pipeline | one durable task; each stage is a phase that saves a checkpoint | `durable/src/pipeline.ts` | 12-tasks, 13-recovery, 24-child-tasks |
| An agent step | a conversation owned by the pipeline task, created in the same commit as the checkpoint that records it; its prompt is submitted with a request ID | `pipeline.ts` (`startStep`, `awaitStep`) | 03-owned-conversations, 22-subagent-foreground, 23-subagent-background |
| A ticket's state | a session document per ticket, changed in the same commits as the task | `durable/src/docs.ts` | 01-documents, 11-extension-state |
| An agent | the coding tools, the factory's prompt section, and a guard hook | `durable/src/roles.ts` | 15-system-prompt, 27-plan-mode, 28-reviewer, Hooks |
| Where tools run | an environment per step conversation, looked up from its step document | `durable/src/env.ts`, `host.ts` | 29-sandbox-per-conversation, 30-tool-override |
| Model per role, fallback | each step conversation is configured with its role's model | `durable/src/lanes.ts`, `lanes.json` | 07-configuration, 26-coding-agent |
| Your approval | a phase that waits durably and checks for it | `pipeline.ts` (`gate`) | 13-recovery |
| Steering | your message submitted to the running step with `whenBusy: "steer"` | `host.ts` (`steer`) | 20-inbox |
| Live view | the step's agent events streamed to the dashboard; a late viewer gets the current state first | `durable/src/server.ts` | 19-json, 21-late-join |
| Task graph | every live task: pipelines, generations, tool calls, loops | `host.ts` (`graph`) | 24-child-tasks |
| Sentry sync, auto pickup | background tasks that loop on a timer kept in their checkpoint | `durable/src/sentry.ts`, `host.ts` | 13-recovery |
| Restart | reopen the session, install the same extensions, `resume()` | `host.ts` (`Factory.open`) | 06-harness, 31-reload-and-restart |
| Long steps | background compaction keeps a step's context within the model's window | Pi Durable's default policy | 25-compaction |

### What survives a crash
Everything is committed before it is shown. When the process dies (crash, `kill -9`, `docker stop`)
and starts again:
- every ticket continues from its last phase;
- an agent step continues **in the same conversation**: a model turn that was cut off is sent again,
  and a tool call that was cut off is reported to the model as interrupted (the model decides what to
  do, typically to run it again). No step starts over and no second conversation is made;
- commands an agent left running when the process died are ended before anything resumes (each
  agent command records its process group in `runs/<ticket>/exec.pids`);
- the approval gate keeps waiting; a paused ticket stays paused; the Sentry and pickup loops keep their timers;
- today's model spend is read back from `state/usage.json`.

Effects outside the session are made safe to repeat: ticket statuses and pushes are idempotent, the
PR is looked up before one is created, and comments are recorded before they are posted (a crash in
between loses a comment rather than posting it twice).

---

## The pipeline

The ticket's status in ClickUp shows where it is; the factory's own state is in its session.

| Status (config name) | Meaning | Who moves it |
|---|---|---|
| `S_TODO` | ready to be worked | you |
| `S_WORKING` | the factory works on it | factory |
| `S_SPEC_REVIEW` | spec and plan ready, waiting for you | factory |
| `S_APPROVED` | spec approved, build may start | you (or *Approve* on the dashboard) |
| `S_IN_REVIEW` | PR open, ready for a human (set as soon as the PR exists, again at the end of the run) | factory |
| `S_BLOCKED` | failed or needs answers, reason on the dashboard (and as a comment with `TRACKER_COMMENTS=1`) | factory |

- **The coordinator repairs what the checks find:** when a check the factory runs fails on the branch (the push is refused by the repo's pre-push hooks, the secret scan stops the push, VERIFY_CMD still fails after the coder's second try, VERIFY_CMD is killed for memory, or the coder stops with `blocked.md`), the coordinator agent (`agents/coordinate.md`, Sonnet 5.5 first) gets the failure in `failure-N.md`. It reproduces it, finds whether this branch caused it or the base already has it, fixes it on the branch (never by silencing a check or bypassing a hook), proves the fix, and writes `repair-N.md`. Then the phase runs again. At most `MAX_REPAIRS` (default 2) per phase and run; a failure that is not the ticket's (the environment, the base) stops with the coordinator's explanation in `blocked.md`.
- **Lessons (self-improving):** each repair ends with a one-line lesson about the repo. The factory keeps them in `state/lessons.md` (at most 40, no secrets) and puts them into the prompt of every agent that changes code from then on. `ff lessons` prints them; edit or delete a line freely.
- **Pushes, from the sandbox's point of view:** with `SANDBOX=docker` the repo's pre-push hook runs in the ticket's container, where the dependencies were installed (their native binaries are built for it, not for this machine), with the refs on its stdin (`pre-push.log`); then this machine pushes without running the hook a second time. `PRE_PUSH=0` turns the hook off: the factory pushes without it, and the timeline says it was skipped. A failing hook stops the push and goes to the coordinator. `ORIGIN_URL` points the factory's own git (fetch, push, ls-remote) at another URL for origin, such as an SSH host alias with the right key, and leaves the checkout's remote as it is.
- **Only what the ticket needs:** before a push, the files the branch adds or changes are checked: build output, caches, logs, editor and OS files, merge leftovers, factory run-folder files, and a lockfile changed without a package.json stop the push (unless the base already tracks them), and the coordinator takes them out of the unpushed commits, or keeps one on purpose by naming it with a reason in `RUN_DIR/scope-keep.txt`. Files the plan does not name are reported on the timeline, not stopped.
- **No secrets in the PR:** before every push the factory scans everything it would send: the added lines, the added files and the commit messages. It looks for the factory's own secrets by value (every TOKEN, KEY, SECRET or PASSWORD variable) and for well-known token shapes (cloud and git host keys, private keys, connection strings with a password, high-entropy values given to secret names; the noisier patterns skip test files), and for files that hold secrets by nature (`.env`, `*.pem`, `id_rsa`, `credentials.json`). A finding stops the push and goes to the coordinator, which takes the secret out of every unpushed commit. The PR title and body, PR and ticket comments and attachments are redacted before they are posted. The agent guard refuses commands that turn off git hooks (`--no-verify`, `-n`, `HUSKY=0`, `core.hooksPath`) or read secret files (`config.env`, `~/.ssh`, the factory's state). Agents' shells never get the factory's keys, and with `SANDBOX=docker` they see only the worktree and the run folder.
- **A killed check is not a red base:** when VERIFY_CMD is killed (out of memory, SIGKILL), the factory never treats the base as already failing. The coordinator finds a way to run the same check that fits the sandbox (less parallelism, say) and names it with a `VERIFY:` line; the factory keeps it for this repo in `state/verify.json` when it still runs every script VERIFY_CMD names and cannot pass by itself (`ff doctor` shows it; delete the file to go back). Better still, give Docker more memory (Docker Desktop, Resources) and the sandbox `SANDBOX_ARGS="--memory 8g"`.
- **A stopped sandbox starts again:** when the system kills a ticket's container (out of memory), the next command starts it again (the files are on this machine) and tells the agent. A coder that stopped because a tool failed goes to the coordinator, which finishes its work; a real question about the spec still stops the ticket.
- **Ask for a change at the gate:** in the dashboard's reader, select text in spec.md or plan.md and say what should change. The agent that wrote the file changes it, in its own conversation (no new step): a spec change goes to the spec writer, then the planner updates plan.md to match. The gate takes the changes in order before your approval, the new versions are attached to the ticket again, and every change is in the log.
- **Simplified Technical English (ASD-STE100):** the spec writer and the planner (`STE_ROLES`, default `spec,plan`) write in STE, with [agent-ste](https://github.com/ctotheameron/agent-ste) (MIT). Its rules go into their prompt, a write that breaks a hard rule is blocked with each fault named, and the factory lints spec.md and plan.md after the step: faults left (a write through bash is not gated) go back to the same agent once, and what still fails is logged, not blocked. Code and Mermaid blocks are not checked.
- **Diagrams:** spec.md has a Mermaid diagram of the behaviour the ticket changes, and plan.md one of criteria, tests and files. The dashboard draws them.
- **Spec and plan on the ticket:** when you approve (on the dashboard, with `ff approve`, or by moving the ticket to S_APPROVED), the approved `spec.md` and `plan.md` are attached to the ClickUp ticket as `<ticket>-spec.md` and `<ticket>-plan.md`, once per approval. Without the gate (`SPEC_GATE=0`) they are attached when the plan is done. `TRACKER_ATTACH=0` turns it off.
- **Spec gate (`SPEC_GATE=1`):** after the plan, the pipeline waits. Approve on the dashboard, with `ff approve <ticket> [note]`, or move the ticket to `S_APPROVED`. Your note and the ticket's comments go to the coder and override the spec.
- **Needs input:** if the spec writer ends spec.md with `STATUS: NEEDS_INPUT`, its questions are posted and the ticket is blocked. No code is written.
- **Verify gate (`VERIFY_CMD`):** the factory runs it itself, in the ticket's sandbox. It runs once on the untouched base branch first; if that already fails, the gate only reports. After the coder: a failure gets the coder one more fresh session with the failure (`verify-failed.md`), then the ticket is blocked. After each fix: a failure goes to the next reviewer, who must count it as a P1.
- **Frozen tests:** the test writer's tests are frozen by hash. If the coder or fixer deletes one, or changes one without naming it with the reason in `test-changes.md`, the ticket is blocked.
- **Readers do not write:** the spec writer, planner, reviewer and judge may write only into the run folder (a tool hook refuses writes into the repo), and if HEAD moves during their step the ticket is blocked.
- **The PR:** the factory opens it as a draft and puts `PR_LABEL` on it (the label is created when the repo does not have it). A PR that already exists for the branch is used, not opened twice.
- **Review loop:** each review goes on the PR as one review (a comment, never an approval): `review-N.md` is its body, and the reviewer's `review-N.comments.json` holds up to 5 inline comments, only for a root cause or a bug it verified, or a question about intent. Each starts with its severity (`🔴 issue (blocking):`, `🟡 issue:`, `❓ question:`), and a fix of a few lines comes as a GitHub `suggestion` block the author applies in one click. When GitHub refuses a comment's line (outside the diff), the comments go into the review body instead. The repo's own review skill (`review-a`, for example) sets the checklist. On `VERDICT: PASS` the PR is marked ready; otherwise it stays a draft after `MAX_REVIEW_ROUNDS`.
- **Judge (best effort):** grades the run (`judge.json`: criteria met, hallucinations, a 1 to 5 score) and posts the score on the PR.
- **A failing model:** after the provider's own retries, the step moves to the next model in its role's lane (a new attempt, e.g. `code-1-2`); when none is left the ticket is blocked. A model that failed is skipped only for the rest of that run. `AGENT_TIMEOUT` bounds each step.
- **Parallel:** up to `MAX_PARALLEL` tickets at once; the others wait for a free cell.
- **Running a ticket again:**
  - after a stop or a block, the next run continues at the phase where the last one stopped (the step that was cut off runs again as a new attempt; finished steps do not run again);
  - after a finished run (PR in review), or with `--fresh`, it starts over from the spec. A branch that was already pushed is never rewritten (the factory never force-pushes): the new run gets the next free name, `<branch>-2`, and its own PR.

The coder and the fixer follow [ponytail](https://github.com/dietrichgebert/ponytail) (vendored in `skills/ponytail/`): the smallest complete change. Tests and code follow [Superpowers](https://github.com/obra/superpowers) (vendored in `skills/superpowers/`): the test writer, the coder and the fixer use `test-driven-development` and `verification-before-completion`, the coder and the fixer `systematic-debugging`, the planner `writing-plans`, and the fixer `receiving-code-review`.

Agents (`agents/*.md`, see `agents/README.md`): spec writer, planner, test writer, coder, docs writer (delete `docs.md` to turn it off), PR summary writer, code reviewer, fixer, judge. Each writes the files its prompt names into the run folder (`runs/<ticket>/`); the pipeline checks them before it moves on.

### Ticket cells: what keeps tickets apart
| Shared thing | What keeps tickets apart |
|---|---|
| working files | one git worktree per ticket (`worktrees/<ticket>`, branch `{type}/<ticket>/<short-desc>`), cut from the latest `origin/BASE`. Your own checkout is never touched. |
| the repo's `.git` | a `reference-transaction` hook (`runs/<ticket>/git-hooks`, set for agent commands only) refuses any ref change except the ticket's own branch: other tickets' branches, the base branch, new branches, tags and `git stash` (shared by every worktree; only lint-staged's own automatic backup, made and dropped by a pre-commit hook, is allowed). Refusals are logged in `runs/<ticket>/guard.log`. The repo's own hooks still run. |
| git housekeeping | the factory's own fetch, worktree add/remove, push and gc run one at a time. Agents run with `gc.auto=0`. |
| pushing | only the factory pushes, and only the ticket's branch (a tool hook refuses `git push`). |
| agent memory | each step is a new conversation; agents of one ticket share only the run folder. |
| secrets | an agent's shell gets no tokens or API keys (the model is called by the factory, not by the agent). |
| ports, compose projects | each running ticket takes a cell slot: `PORT_BASE` = `CELL_PORT_START + slot × CELL_PORT_SPAN`, `PORT`, and `COMPOSE_PROJECT_NAME=factory-<ticket>`. |
| the machine (`SANDBOX=docker`) | each ticket's agent commands run in its own container of `SANDBOX_IMAGE`, which sees only its worktree, its run folder and the repo's `.git`. The container goes when the run ends. With `SANDBOX=none` the commands run on this machine. |

- **Fail closed:** if the ticket's branch is checked out in another folder, the ticket is blocked instead of mixing two runs on one branch.
- **Cleanup:** `ff gc` removes a worktree once its PR is merged or closed (and the local branch once merged), or after `GC_DAYS` idle.

### Code index (what the agents search)
Before an agent walks files, it can search the codebase: `ff index search "<what you need>"` answers with `path:line` hits, and the step prompt tells it so. The index is refreshed in the background while tickets run: the repo's own after a worktree is cut (from the checkout, or from `INDEX_REF` such as `origin/main`, read through a hidden snapshot worktree), each ticket's own at every step start.
- **A ticket's index starts as the repo's:** it is seeded from that store once and then follows the worktree, so only the ticket's changes are read, chunked and embedded. A read that finds no ticket index yet falls back to the repo's and says so.
- **Containers see it read-only:** `state/index` is mounted at the same path with `INDEX_DIR` (and `INDEX_SCOPE` for the ticket's own store). Agents search it, never write it; builds and refreshes run outside the sandbox.
- **Offline by default:** the built-in embedder is deterministic feature hashing — no network, no model download. Keyword (BM25) and vector results are fused (reciprocal rank fusion). `INDEX_EMBED=http` points the embedder at any OpenAI-compatible `/embeddings` endpoint (a local Ollama, say). An index built with one embedder is never queried with another: the search says so and falls back to keywords; switching `INDEX_EMBED` re-embeds the store on its next update.
- **The sandbox's own rules:** git's ignore rules decide, binary files and files over `INDEX_MAX_FILE_BYTES` (10 MiB, the cap Cursor's client uses) are skipped, and the secret paths agents may never read (`.env` and friends) never enter it.
- **By hand:** `ff index build|update|status|search|map|bench|clean`; `ff index map` prints the generated code map, `ff index bench` measures a search against reading the whole tree. `INDEX_AUTO=0` turns the background refreshes off.

### Skills
Every agent file starts with a header such as `skills: implement, tdd, ponytail`. A ticket can add skills with a `Skills: a, b` line in its description.
- **Vendored sets:** `skills/superpowers/` ([Superpowers](https://github.com/obra/superpowers)), `skills/ponytail/` ([ponytail](https://github.com/dietrichgebert/ponytail)) and `skills/mattpocock/` ([mattpocock/skills](https://github.com/mattpocock/skills)), all MIT. Each has a SOURCE.md: what was copied, what was left out and why, and how to update it.
- **The repo's own skills win:** the ticket's repo is searched first (`REPO_SKILL_DIRS`: `.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`, `.opencode/skills`, then command folders such as `.claude/commands`; single `<name>.md` files count too), then `SKILLS_PATH`.
- **Delivery:** the skill is copied into the run folder (a sandboxed agent can read it) and the agent is told to read and follow it. `runs/<ticket>/skills.log` shows which copy each agent got. Missing skills are logged and skipped; names other than `name` or `set/name` are skipped.

### Models (`durable/lanes.json`)
Each role has an ordered chain of `<provider>/<model>` from pi-ai's catalog, preferred first. An entry without a login (its provider's API key) is skipped; a model that fails a step (after the provider's own retries) moves the step to the next entry. The reviewer and the judge do not use the coder's model family, so code is never graded by its author; when no other family has a login they use the coder's family and say so in `route.log` (`ff doctor` warns). `runs/<ticket>/route.log` shows what was skipped and why.

---

## Intake

### Sentry: production issues
Set `SENTRY_AUTH_TOKEN` (a token with `event:read`), `SENTRY_ORG` and optionally `SENTRY_PROJECTS`. Every `SENTRY_POLL_INTERVAL` (and on *Sync now*) the factory lists unresolved issues of `SENTRY_ENVIRONMENT` (default `production`; several allowed, comma-separated, e.g. `prod,production`) from the last `SENTRY_PERIOD`. `SENTRY_PROJECTS` takes project ids.
- **Fix first** ranks them: Sentry's priority × level × log(events) × (1 + log(users)) × how recently it was seen, ×1.5 when unhandled.
- **Your decisions are kept:** a sync updates Sentry's fields, never your triage. An issue Sentry no longer lists is shown as resolved. A dismissed issue that Sentry newly marks as regressed comes back.
- **Fix this** creates one ClickUp ticket per issue in `SENTRY_CLICKUP_LIST_ID` (assigned to you, `S_TODO`, tag `sentry`) with the issue, its counts and the latest event's exception and in-app stack, and starts its pipeline: the spec writer finds the root cause, and the test writer reproduces it first.

### ClickUp: your sprint
Set `CLICKUP_SPRINT_FOLDER_ID` (the Sprints folder; the sprint whose dates cover today is used, else the latest started) or `CLICKUP_SPRINT_LIST_ID`. *My sprint* lists every task assigned to you in it, including tasks whose home list is elsewhere, with what the factory did with each. With `AUTO_PICKUP=1` the factory also starts, every `POLL_INTERVAL`, the tickets assigned to you in `S_TODO` (spec) or `S_APPROVED` (build): from the sprint when one is set, else from `CLICKUP_LIST_ID`, else from the whole team. Tickets that are blocked or in review are left alone.

---

## Dashboard (`ff serve`)
`http://127.0.0.1:8090` by default (`DASH_HOST`, `DASH_PORT`).
- **Who may call it:** it listens on loopback only. A request must name an allowed host (no DNS rebinding; `DASH_ALLOWED_HOSTS` adds names), and every action carries the token this start wrote to `state/dash.token` (mode 600), so another web page cannot act through your browser. Listening on another address requires `DASH_PASSWORD` (basic auth).
- **Timeline:** on top, the run's stages (Received, Spec or Root cause, Approval, Tests, Fix, Pull request in three parts: the PR, the review, the second review, Ready) with the one in progress animated; below, the latest run phase by phase: when each started and how long it took, its agent steps (model, time, tokens, cost), and what happened in it (verify results, review verdicts, the PR, pauses, URLs as links). Each run of the pre-push hook is a row of its own: running, passed, failed, killed, skipped (`PRE_PUSH=0`) or cut off by a restart; click it for `pre-push.log`. The run ends with a card: the PR link, the AI review verdict and the judge's score. Phases still ahead are shown faded.
- **Pause, Continue, Stop:** *Pause* holds the ticket: its pipeline waits before its next phase, and its running step finishes the model request and tool call it is in, then waits. *Continue* goes on from there; nothing is lost and paused time does not count toward `AGENT_TIMEOUT`. *Stop* ends the run (*Run again* continues where it stopped). A pause is durable: it survives a restart.
- **Logs:** every event of the ticket, newest first, filtered by level and kind and searchable. Events are committed in the same commit as the change they describe, so the log matches what the factory did, also after a crash. `ff logs <ticket>` prints them.
- **Streamed, not polled:** the server pushes the overview and the open ticket the moment they change (`/api/stream`); the dashboard polls only while the stream is down. An approval, a continue or a free slot wakes the waiting pipeline at once.
- **Live view:** pick a step to see its transcript as it happens, one box per message or tool call, each kind in its own shade: the agent's text, bash (with its output, a time, and a flag on risky commands), reads, writes and edits (an edit shown as a small diff), grep results grouped by file, your steers, model errors.
- **What a step changed:** click a step of the test writer, coder, fixer, docs writer or coordinator: a drawer opens on its diff (the commits it made, and while it runs its uncommitted edits and new files): a file list, line numbers, the changed words marked, live while the step runs. Each step records the commit it started and ended on.
- **What a reviewer wrote:** click a finished review or judge step: the reader opens `review-N.md` or `judge.txt`, with the run's other reviews as tabs.
- **Live preview of the spec and plan:** click a spec or plan step: the reader opens the file, and while the step runs it shows the file as the agent types it (the write call is streamed from the model, argument by argument).
- **Steer:** your message joins the running step after its current tool round.
- **Spend:** today's model spend against the daily budget, in the sidebar and a stat card, and any request waiting for a rate limit.

### Rate limits and the daily budget
Every model request of every agent goes through one throttle (`durable/src/throttle.ts`), per provider (one API key each):
- `RATE_LIMIT_RPM` (default 50): requests a minute. A request over it waits for the window.
- `RATE_LIMIT_TPM` (default 0, no limit): tokens a minute, counted when responses arrive.
- `DAILY_BUDGET_USD` (default 0, no budget): spend per local day, at pi-ai's catalog prices. When it is reached the factory pauses every running ticket (`budget` in the log) and holds their requests; they continue by themselves the next day. To go on today, raise it and restart `ff serve`. Today's spend is kept in `state/usage.json`, so a restart does not reset it.

`ff usage` prints today's spend per provider and the limits; `ff doctor` shows the limits.

## Commands
`ff` is `durable/bin/ff`: link it onto your PATH (see Setup). It sources `config.env`.

    ff serve                   the factory and its dashboard
    ff spec <ticket>           plan the spec, then wait for your approval
    ff run <ticket> [--fresh] [--gate] [--build]
                               the whole pipeline without the spec gate (--gate: with it; --build: from an approved spec)
    ff approve <ticket> [note] approve a spec; the note goes to the coder
    ff steer <ticket> <text>   a message into the ticket's running agent step
    ff stop <ticket>           stop a ticket (worktree and branch stay; ff run continues it)
    ff pause | resume <ticket> hold a running ticket before its next phase and model request | continue it
    ff status | show <ticket>  what every ticket is doing | one ticket's steps
    ff logs <ticket>           everything that happened to a ticket, oldest first
    ff lessons                 what the coordinator learned from failures (state/lessons.md)
    ff usage                   today's model spend per provider, the rate limits, what is waiting
    ff sentry [sync] | fix <issue id> | sprint
    ff gc [days]               remove worktrees of merged or closed PRs, or idle ones
    ff index <cmd>             the code index agents search: build, update, status, search, map, bench, clean
    ff doctor                  check tools, repo, base branch, gh, ClickUp, sprint, Sentry, sandbox, models
    ff health                  exit 0 when the factory serves (container healthcheck)
    ff login [KEY]             save a key in config.env (hidden input) and show the model logins
    ff whoami                  your ClickUp user and team ids

A ticket is a key (`CHP-1234`), an id or a URL; with `CLICKUP_ID_PREFIX=CHP`, a bare number (`1234`) too. A ticket ClickUp does not have is refused before it gets a row. A ticket deleted in ClickUp blocks with that reason: *New ClickUp ticket* makes a new one for a Sentry issue (so does *Fix this*); *Remove* (the bin icon on a row; click twice) takes a ticket that is not running off the runs list and deletes the worktree the factory made for it; the ClickUp ticket, the branch and the run folder stay, so running it again picks the branch up.
- `approve`, `steer`, `stop`, `pause`, `resume`, `usage`, `sentry`, `fix`, `sprint` and `health` talk to the serving factory, so `ff serve` must be running.
- `status`, `show`, `logs` and `gc` use the serving factory when there is one, else open the session read-only.
- `run` and `spec` without a serving factory host the run themselves (they also continue any other unfinished ticket) and return when the ticket finishes or waits at the gate.
- `config.env` is read from the repo root, or from `FACTORY_CONFIG` when set.

## Setup (laptop)

    cd durable && npm ci && cd ..          # Pi Durable and pi-ai, pinned by package-lock.json (Docker and CI use npm too)
    ln -s "$PWD/durable/bin/ff" ~/.local/bin/ff
    cp config.example.env config.env       # the one file for settings and secrets (mode 600)
    ff whoami                              # copy the ClickUp ids into config.env
    ff login ANTHROPIC_API_KEY             # and/or OPENAI_API_KEY, SENTRY_AUTH_TOKEN, ...
    docker build -t software-factory .     # the sandbox image (skip with SANDBOX=none)
    ff doctor
    ff serve                               # then open http://127.0.0.1:8090

Create the tracker statuses named in `config.env`, or map them to existing ones. Then, in `config.env`:
- **Your sprint:** `CLICKUP_SPRINT_FOLDER_ID` (the Sprints folder) or `CLICKUP_SPRINT_LIST_ID`.
- **Sentry:** `SENTRY_ORG`, `SENTRY_PROJECTS`, `SENTRY_CLICKUP_LIST_ID`, and `ff login SENTRY_AUTH_TOKEN`.
- **The repo:** `REPO`, `BASE`, `SETUP_CMD` (e.g. `npm ci`) and `VERIFY_CMD` (e.g. `npm test`).
- **A second model provider** (e.g. `ff login OPENAI_API_KEY`), so code is reviewed by another model family.

Every setting, with its default, is in `config.example.env`.

### Your first ticket
1. `ff serve`, and open the dashboard.
2. *My sprint* → *Plan spec* on a task (or *Factory runs* → enter a ticket key → *Plan spec*). The spec writer and the planner run; watch them under *Live*.
3. The ticket shows *spec ready: approve*. Read `spec.md` and `plan.md` in its panel, add a note if needed, and *Approve and build*.
4. Tests, code, docs, the PR and the review loop run. The ticket ends *PR ready* with the PR linked (or *blocked*, with the reason).
5. Review and merge the PR yourself. `ff gc` later removes its worktree.

## Setup (server, EC2 or any Docker host)

    git clone <this repo> && cd software-factory
    sudo mkdir -p /srv/factory
    sudo cp config.example.env /srv/factory/config.env   # fill it in, plus GH_TOKEN, GH_REPO and DASH_PASSWORD
    docker compose up -d --build
    docker compose exec factory ff doctor
    ssh -L 8090:127.0.0.1:8090 <server>                  # the dashboard, on your machine

`docker stop` closes the session; every ticket continues from its checkpoint when the container starts again.

## Where things live
| Path | What |
|---|---|
| `config.env` | settings and secrets (gitignored, mode 600) |
| `state/factory.sqlite` | the Pi Durable session: every ticket, task, conversation and document |
| `state/factory.pid`, `state/dash.url`, `state/dash.token` | the serving factory: its pid (one owner), its address, this start's token |
| `state/usage.json` | today's model spend, per provider (the daily budget) |
| `state/lessons.md` | lessons from repaired failures, read by the agents that change code |
| `state/index/<repo>/` | the code index: the Merkle manifest, chunks and vectors (a ticket's own store is `<repo>-<scope>`, seeded from it) |
| `runs/<ticket>/` | the run folder agents share: `ticket.md`, `comments.md`, `spec.md`, `plan.md`, `tests.md`, `review-N.md`, `review-N.comments.json`, `judge.json`, `pre-push.log`, `verify-N.log`, `failure-N.md`, `repair-N.md`, `route.log`, `skills.log`, `guard.log`, `git-hooks/`, `skills/` |
| `worktrees/<ticket>/` | the ticket's git worktree |
| `agents/*.md` | the agents' prompts |
| `durable/lanes.json` | which model each role runs on |
| `skills/` | vendored skills |

`DATA_DIR` moves `state/`, `runs/` and `worktrees/` elsewhere (the server keeps them in `/srv/factory`).

### The code (`durable/`)
| File | What |
|---|---|
| `src/cli.ts` | `ff`: the commands; `ff serve` starts the host and the server |
| `src/host.ts` | the host: opens the session, installs the extensions, resumes; start, approve, stop, pause, resume, steer, Fix this, gc; pauses tickets when the budget is spent |
| `src/pipeline.ts` | the ticket pipeline task: its phases, agent steps, checks and effects |
| `src/roles.ts`, `src/skills.ts` | the agents: prompt, skills, guard hook |
| `src/env.ts`, `src/git.ts` | where agent commands run (this machine or a container), worktrees, the ticket guard |
| `src/docs.ts` | the documents: tickets (with their events), step identity, the Sentry inbox |
| `src/lanes.ts` | model choice per role |
| `src/secrets.ts` | the secret scan before every push, and redaction of what the factory posts |
| `src/lessons.ts` | lessons the coordinator learns from failures, for the agents that change code |
| `src/index/` | the code index: the walk (gitignore, binary, size, secret paths), the Merkle manifest, chunking, embedders, search, the store, the sync engine; `ff index` |
| `src/ste.ts` | Simplified Technical English for STE_ROLES: the prompt rules, the write gate, the file check (agent-ste) |
| `src/throttle.ts` | every model request: rate limits per provider, the daily budget, paused tickets' requests |
| `src/tracker.ts`, `src/github.ts`, `src/sentry.ts`, `src/http.ts` | ClickUp, GitHub (`gh`), Sentry |
| `src/server.ts`, `dashboard/index.html` | the dashboard and its API; `dashboard/DESIGN.md` is its design guide (shadcn/ui tokens and components) |
| `test/` | the tests and their fakes (`support.ts`) |

## Troubleshooting
- **Start with `ff doctor`.** Every FAIL line names what to fix.
- **"origin has no branch BASE":** `git ls-remote origin` failed: check the remote, your SSH key or `GH_TOKEN`, and `BASE`.
- **"another factory owns state/factory.sqlite":** one `ff serve` per data folder. Use `ff status`, or stop the other one.
- **"no model left for the ... agent":** no model in that role's lane has a login (`ff login`), or every one failed this run; see `runs/<ticket>/route.log`.
- **A blocked ticket:** the reason is on the dashboard and in `ff show <ticket>`. Fix the cause, then *Run again* (it continues where it stopped) or *Start fresh*.
- **The dashboard says "missing or wrong X-Factory-Token":** the factory restarted; reload the page.
- **Docker sandbox:** `docker build -t software-factory .` after pulling changes; a running ticket's container is `factory-<ticket>`.
- **`ff gc` cannot delete a worktree (permission denied):** on a Linux host the agents' files are root-owned (see Known limits); `sudo rm -rf worktrees/<ticket>`, then `git worktree prune`.

## Tests

    cd durable && npm run check && npm test
    # with Docker: the whole pipeline in the docker sandbox
    docker build -t software-factory . && cd durable && SF_DOCKER_PIPELINE=1 SANDBOX_TEST_IMAGE=software-factory npm test

No network: a scratch repo with an origin, a fake tracker and git host, and pi-ai's faux model playing every agent from its prompt (`durable/test/support.ts`). They cover the whole pipeline to a reviewed PR; the gate and your note; a restart mid tool call (the same conversation continues and hears its call was interrupted); `kill -9` of the factory mid step (it continues, and the command it left running is ended); frozen tests; the verify gate's second try; steering; stopping; pausing mid-step (the step's next request waits, its paused time is not its own) and the timeline it leaves; the daily budget pausing tickets; the throttle's rate windows, budget ledger and holds; the reviewer's family rule; Sentry paging, merging, ranking and *Fix this*; the sprint; a failing model moving to the next one; running a ticket again after a stop and after a finished run; the dashboard's host, token and password rules and its API; and, with Docker, the sandbox container (variables, no host secrets, killing a process group, reaping) and a ticket container's `ff index search` against the read-only index mount. The code index has its own suite: the Merkle tree, the chunker's line ranges, what the walk skips (ignored, binary, oversized, secret), the delta update, search and its filters, the ticket's seeded scope, and `INDEX_REF` through a snapshot. CI also builds the image and runs a whole pipeline in the docker sandbox (`SF_DOCKER_PIPELINE=1`).

## Roadmap
Planned, not built: agents that choose their skills from Superpowers and mattpocock/skills, Jev (a decision model) for the factory's choices, and models routed by the ticket, the spec and the plan, after [jroute](https://github.com/ssk090/jroute). See [ROADMAP.md](ROADMAP.md).

## Known limits
- **Pi Durable is experimental:** its API may change between releases. Versions are pinned in `durable/package-lock.json`; upgrade on purpose and run the tests.
- **Models through API keys:** agents run on pi-ai with providers' API keys (metered), not through agent CLIs or their subscription quotas. Spend is counted at pi-ai's catalog prices, so the budget is close to, not exactly, your bill.
- **Tracker:** ClickUp only. **Git host:** GitHub only, through `gh`.
- **One process per session:** run one `ff serve` per data folder (it refuses a second one).
- **`SANDBOX=none`:** file tools are confined to the worktree and run folder, but an agent's shell can read the rest of the machine. Use docker for untrusted tickets.
- **`SANDBOX=docker` on Linux, as a non-root user:** agent commands run as root in their containers, so the files they write into the shared mounts — their edits, the dependencies `SETUP_CMD` installed, the git objects of their commits — are owned by root on this machine. Runs work (the factory reads those files and pushes them), but `ff gc` cannot delete such a worktree: `sudo rm -rf worktrees/<ticket>`, then `git worktree prune`. Docker Desktop (macOS, Windows) maps file ownership to your user, so this does not happen there.

# software-factory

Turn a tracker ticket into a reviewed pull request. Small agents do the work, and a script
orchestrates them.

    ticket -> spec -> plan -> (you approve) -> tests (red) -> code (green) -> docs -> PR summary
           -> draft PR -> review <-> fix -> PR summary again -> PR ready for you

It is spec-driven: the spec's numbered acceptance criteria become failing tests before any code
exists, the coder makes them pass, and the reviewer and PR summary check every criterion.

Every ticket runs in its own **cell**: its own git worktree and branch, its own run folder, its own
port range, and agent sessions that start empty and keep nothing. Tickets run in parallel, and a
ticket's agents cannot see or change another ticket's work (see 2b).

The factory never merges. A human merges. It works with any git repo, uses ClickUp as its
tracker today, and runs Codex, Claude Code, OpenCode, Cursor or pi as the agents. It can run on
a laptop, inside Herdr, or on a server.

Ideas taken from:
- [super-board](https://github.com/EricTechPro/super-board): the board status is the state machine, the orchestrator never writes code, each step is a fresh agent, the reviewer is a separate agent, one worktree per ticket, and nothing merges without a gate.
- [jroute](https://github.com/ssk090/jroute): the model is picked per step from task difficulty (Jev) and live subscription quota.
- [sandcastle](https://github.com/mattpocock/sandcastle): every agent step runs in its own container.
- [zoetrope](https://github.com/furkankly/zoetrope): a live graph of the agents at work.
- [fluent](https://github.com/mrinalwadhwa/fluent): the orchestrator runs the checks itself instead of trusting an agent, records a baseline so failures already on the base branch are not blamed on the coder, and takes file locks the kernel releases when a process dies.
- [conveyor](https://github.com/kidus-tiliksew/conveyor): fail closed when a branch is checked out in two places, and clean up a worktree once its PR is merged.
- [sdlc](https://github.com/bbsnly/sdlc): spec tests are frozen by hash once written, readers may not write, and a parallel worker pool.
- [pstack](https://github.com/cursor/plugins/tree/main/pstack) (poteto): skills for the agents (see 3).

Needs: bash, git (2.31 or newer), gh, jq, curl, python3, perl, Docker (for the sandbox) and at least one agent CLI.
For development also: shellcheck (CI runs it; `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable ...` works without installing it).

---

## Features

### 1. Ticket workflow (status is the state machine)
The ticket's status in the tracker is the only state. Any run can stop, and the next run resumes from the board.

| Status (config name) | Meaning | Who moves it |
|---|---|---|
| `S_TODO` | ready to be worked | you |
| `S_WORKING` | claimed, an agent is working | factory |
| `S_SPEC_REVIEW` | spec + plan posted as a ticket comment, waiting for you | factory |
| `S_APPROVED` | spec approved, build may start | you |
| `S_IN_REVIEW` | PR open, ready for human review | factory |
| `S_BLOCKED` | failed or needs answers, reason in a ticket comment | factory |

- **Curation:** only tickets assigned to you in `S_TODO` or `S_APPROVED` are taken. Approved tickets go first.
- **Spec gate (`SPEC_GATE=1`):** the factory stops after the plan. You comment and move the ticket to `S_APPROVED`. Your comments go to the coder and override the spec.
- **Needs input:** if the spec writer finds blocking questions, it posts them and sets `S_BLOCKED`. No code is written.
- **Failures:** every failure posts a ticket comment (reason, log folder, retry command) and sets `S_BLOCKED`. The ticket is skipped until `ff retry <id>`.

### 2. Agents (`agents/`)
One Markdown file per agent. Each agent is a fresh headless run of an agent CLI, and agents talk only through files in the ticket's run folder.

| Agent | Writes |
|---|---|
| orchestrator (`factory.sh`, a script, not an LLM) | ticket status, comments, worktree, push, PR |
| spec writer | `spec.md` with numbered acceptance criteria (AC-1, AC-2, ...), ending in STATUS: READY or NEEDS_INPUT |
| planner | `plan.md`: for each AC, the test that proves it and the code to change |
| test writer | failing tests for every AC, committed before any code (red), and `tests.md` (AC to test) |
| coder | commits that make the tests pass (green), or `blocked.md` |
| docs writer (optional: delete `docs.md` to turn it off) | docs commits, `docs.md` |
| PR summary writer | `pr-title.txt`, `pr-body.md`, written again after fixes |
| code reviewer | `review-N.md`: every AC marked met or not met, P1/P2/P3 findings, ending in VERDICT: PASS or FIX |
| fixer | commits, `fix-notes.md` |
| judge (best effort) | `judge.json`: each AC met / partial / not met with evidence, spec gaps, hallucinations, out-of-scope changes, a 1 to 5 score, and prompt fixes per agent |

- **Worktree per ticket:** each ticket gets its own git worktree on `{type}/<ticket>/<short-desc>` (for example `feature/CHP-1253/add-login-menu`, type guessed from the title or set with `BRANCH_TYPE`), cut from the latest `origin/$BASE`. Your own checkout is never touched. See 2b for what keeps tickets apart.
- **Pull request:** a draft PR always targets `$BASE` and gets the `PR_LABEL` label (for example `created by agent-shiv`).
- **Review loop:** each review is posted as a PR comment. On PASS the PR is marked ready. Otherwise it stays a draft with a "needs a human" ticket comment after `MAX_REVIEW_ROUNDS`.
- **Spec-driven guard:** the test writer's tests are frozen by hash (`test-files.sha256`). If the coder or fixer deletes one, or changes one without naming it with the reason in `test-changes.md`, the run stops.
- **Verify gate (`VERIFY_CMD`):** the factory runs `VERIFY_CMD` itself, in the ticket's sandbox, and does not take an agent's word that it passed.
  - It runs once on the untouched base branch first. If the base already fails, the gate only reports, so the coder is not blamed for old failures.
  - After the coder: if it fails, the coder gets one more fresh session with the failure (`verify-failed.md`). If it still fails, the run stops.
  - After each fix: a failure goes to the next reviewer, who must count it as a P1.
  - Logs: `verify-<round>.log` (1 = base, 2 = after the coder, 3 = the coder's retry, 3+N = after fix N).
- **Readers do not write:** if the spec writer, planner or reviewer commits, the run stops.
- **Guards in the script:** agents must stay on the ticket branch. The script refuses empty builds and missing PR text. It never force-pushes and never pushes to the base branch. Agents commit, and only the script pushes.

### 2b. Ticket cells: one worktree per ticket, nothing shared (`cell.sh`)
Agents of different tickets never talk to each other, and agents of one ticket talk only through files in that ticket's run folder.

| Shared thing | What keeps tickets apart |
|---|---|
| working files | one git worktree per ticket (`worktrees/<ticket>`). In the docker sandbox an agent sees only its own worktree and run folder. |
| the repo's `.git` (branches, tags, stash) | a `reference-transaction` hook (`runs/<ticket>/git-hooks`, set through `core.hooksPath` for agent steps only) refuses any ref change except the ticket's own branch. Other tickets' branches, the base branch, new branches, tags and `git stash` (one stash is shared by every worktree) are refused, and the refusal is logged in `runs/<ticket>/guard.log`. The repo's own hooks (husky and similar) still run. |
| git housekeeping | fetch, `worktree add` and `remove`, branch delete, push and gc take the repo lock (`state/repo.lock`, a flock released by the kernel if the holder dies). Agents run with `gc.auto=0`; `ff gc` runs `git gc --auto` under the lock. |
| agent sessions and memory | every step is a new session that saves nothing: `codex exec --ephemeral`, `claude -p --no-session-persistence` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `pi --no-session`. In the docker sandbox each step is also a new container. |
| ports, compose projects | each running ticket takes a cell slot (`state/slot-N`, up to `SLOTS`). Its steps get `PORT_BASE` = `CELL_PORT_START + N × CELL_PORT_SPAN`, `PORT` (the same value), `COMPOSE_PROJECT_NAME=factory-<ticket>` and `FACTORY_TICKET`. Agents are told to use only their own range. |
| package downloads | docker sandbox only: one volume (`CACHE_VOLUME`, default `factory-cache`) holds the npm, pnpm, yarn, pip, go and bun caches, so a new worktree does not download everything again. It holds packages, never sessions. |

- **Fail closed:** if the ticket's branch is checked out in another folder, the run stops instead of mixing two runs on one branch.
- **Parallel:** the daemon runs up to `MAX_PARALLEL` tickets at once, each a separate `factory.sh run` process. Each ticket has its own lock and cell, so separate `ff run`s for different tickets do not wait on each other (the parallel test covers the daemon path only). `ff status` lists running tickets with their slot and ports.
- **Cleanup:** `ff gc` removes a worktree once its PR is merged or closed (and the local branch once merged), or after `GC_DAYS` idle.
- **With `SANDBOX=none`:** the guard hook, the repo lock, the sealed sessions and the port ranges still apply, but an agent can read other worktrees on disk. Use docker for untrusted tickets.

See `agents/README.md` to add or change an agent.

### 3. Skills
Every agent file starts with a header such as `skills: implement, tdd, ponytail`. A ticket can add skills with a `Skills: a, b` line in its description (the super-board convention).
- **Supabase's skills** ([supabase/agent-skills](https://github.com/supabase/agent-skills), MIT) are in `skills/supabase/`: `supabase` and `supabase-postgres-best-practices`. Add them to a ticket with `Skills: supabase-postgres-best-practices` when it touches a database.
- **Matt Pocock's skills** ([mattpocock/skills](https://github.com/mattpocock/skills), MIT) are in `skills/mattpocock/`, mapped the way super-board does:
  - `to-spec` for the spec writer, `codebase-design` for the planner,
  - `tdd` for the test writer, `implement` with `tdd` for the coder,
  - `domain-modeling` for the docs writer, `pr` for the PR summary writer,
  - `code-review` with `codebase-design` for the reviewer, `diagnosing-bugs` with `tdd` for the fixer.

  Interactive steps in skills (issue tracker, grilling, setup) are mapped to the run folder by one note in every prompt.
- **pstack** by poteto ([cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack), MIT) is in `skills/pstack/`. Agents name these skills with the `pstack/` prefix, because `tdd` exists in both sets:
  - spec writer: `sharpen`, `principle-never-block-on-the-human`,
  - planner: `principle-sequence-verifiable-units`, `principle-subtract-before-you-add`,
  - test writer: `principle-test-behavior-not-implementation`,
  - coder and fixer: `principle-prove-it-works`, `principle-fix-root-causes`,
  - reviewer: `blast-radius`,
  - docs and PR summary writers: `technical-writing`, `unslop`,
  - judge: `principle-prove-it-works`.

  Only skills that work in one headless session are copied. pstack's orchestration skills (`poteto-mode`, `arena`, `architect`, `interrogate`, `swarm`, and others) start Cursor subagents and are left out. `skills/pstack/SOURCE.md` lists what was left out, and why. A ticket can add any copied skill, for example `Skills: pstack/typescript-best-practices` or `Skills: pstack/correct`.
- **Skill names are checked:** a name must be `name` or `set/name`. Other names in a ticket's `Skills:` line are skipped, because the name becomes a path.
- **The repo's own skills win.** The ticket's repo is searched first, in `REPO_SKILL_DIRS` (`.claude/skills`, `.agents/skills`, `.codex/skills`, `.cursor/skills`, `.opencode/skills`, then command folders such as `.claude/commands`). Single `<name>.md` files count too.

  For example, in chip1-webui the reviewer gets the repo's `.claude/commands/review-a.md`, with chip1's checklist and confidence score. Its 🚨/🔴 findings count as P1, 🟡 as P2 and 🟢 as P3. The reviewer also gets the PR link in its context.
- **Then the factory's:** `SKILLS_PATH`, first match wins. The default order is `./skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`. Broken repo symlinks fall back here.
- **Which copy each agent got:** see `runs/<ticket>/skills.log`.
- **Delivery:** the skill folder is copied into the ticket's run folder, so a sandboxed agent can read it. The agent is then told to read and follow it. This works the same with every CLI.
- **Missing skills:** a missing skill is logged and skipped.
- **Team skills:** put them in `skills/` so they ship with the factory and the Docker image.

### 4. Agent CLIs and logins (`router.json` → `clis`)
Codex, Claude Code, OpenCode, Cursor and pi are defined in config. Adding another CLI is a config entry, not code.

A CLI counts as logged in when any of these is true:
1. its own login file exists under `AUTH_HOME` (for example `~/.codex/auth.json`), or
2. an API key or token is set: `ff login ANTHROPIC_API_KEY` saves it in `config.env`, the one file for settings and secrets (mode 600, never in git or the image), or
3. its own login check passes (for example `claude auth status`).

`ff login` shows which CLIs are ready, the live quota, and which keys you can set.

### 5. Model router (`router.py` + `router.json`)
Each agent has an ordered chain of `<cli>:<model>` entries, cheapest or preferred first (for example `opencode:opencode-go/deepseek-v4.1-flash`).

A chain position can also be a **list of routes to the same model** through different subscriptions, for example `["codex:gpt-6-luna", "opencode:opencode-go/gpt-6-luna"]`. The router takes the route whose subscription has the most quota left, so it moves off a subscription before it runs out. Across different models, quota still only removes and never ranks (jroute's rule), so low quota never pushes work to a weaker model.

An entry is removed when:
- it failed earlier in this run, or
- it is the coder's model family (reviewer only, so code is never graded by its author), or
- its CLI is not installed or not logged in, or
- its subscription quota is low or unknown (see 6).

**Jev** (optional, `TYPESAFE_API_KEY`) scores the ticket once. A hard or risky ticket starts further down the chain. Jev never names a model. Spec, plan, docs and PR summary are pinned to their first entry.

Ticket text is stripped of anything credential-shaped before it goes to Jev (jroute's `redact`). Every decision is logged in `state/decisions.jsonl` (agent, route, subscription, start point), like jroute.

If a model crashes or times out, the agent retries once on the next model. `ff route <ticket>` shows each agent's pick, and `runs/<ticket>/route.log` records why entries were skipped.

### 6. Quota-aware routing
Checked live before every routing decision, like jroute. Quota only removes entries, it never ranks them.

| Subscription | Check | Skipped when |
|---|---|---|
| Codex (ChatGPT plan, codex CLI or pi) | 5h and 7d usage, per-model availability | at `gates.codex.5h_max` / `7d_max` (70% / 85%), at the limit, or quota unknown |
| OpenCode Go | live model catalog, plus a local meter: the factory's own calls in the last 5h (no usage endpoint exists) | model not in the catalog, or `gates.opencode-go.5h_budget` calls reached |
| Cursor | auto and api buckets | bucket at `gates.cursor.bucket_max` (85%), or quota unknown |
| Claude via API key, other API keys | none (paid per token) | never |

The same numbers give each route's "quota left" for choosing between routes to the same model. A route whose quota cannot be measured ranks at 50%. Each subscription is one small class in `router.py` (`probe`, `blocked`, `headroom`). To support another one, add a class and a `QUOTAS` entry.

### 7. Per-agent sandbox (`sandbox/`, `SANDBOX=docker`)
Every agent step, and the dependency install, runs in its own throwaway container, removed afterwards.
- **What it can see:** the ticket's worktree, its run folder, the repo's `.git` (needed to commit), and only that agent's login files and keys.
- **What it cannot see:** your home folder, SSH keys, GitHub token, other tickets.
- **Time limit:** a watchdog kills the container at `AGENT_TIMEOUT`.
- **Limits:** `SANDBOX_ARGS` adds docker flags, for example `--cpus 2 --memory 6g`.
- **Turning it off:** `SANDBOX=none` runs agents directly on the host.

### 8. Where you watch (`display/`, `DISPLAY_UI`)
- **`herdr`** (chosen automatically when run inside Herdr): the live graph opens in a split pane next to the factory. Each ticket gets its own Herdr workspace (`factory <ticket>`), and each agent step gets its own tab, named after the agent and its model, so you can watch every agent work. Tabs stay open afterwards.
- **`headless`:** steps run in the background, and output goes to `runs/<ticket>/<agent>-<round>.log`.

### 9. Live view (`factory-view.py`)
A terminal graph: the orchestrator at the top, and each ticket's agents as boxes joined by arrows.
- **Each box** shows a spinner, ✓, ▲ (review found P1/P2) or ✗, how long the step took, and the CLI and model.
- **Input box:** type a ticket key, id or URL, then press Enter to run the full pipeline. Esc quits.
- **Click a step** (in Herdr) to open it in a pane on the right: it tails the step's log. The pane is reused on the next click. Outside Herdr the status line prints the command to run.
- **Opening it:** `ff view`, or the optional Herdr plugin in `integrations/herdr/` (`prefix+shift+w`).

### 10. Observability (`observe/`)
- **Local:** `ff trace <ticket>` prints each agent of the latest run: model, duration, success or failure, verdict, PR link, and why models were skipped.
- **OpenTelemetry:** set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS`). Every run is then sent as one trace:
  - one span per agent step, with the agent, CLI, model, round, exit code, prompt and output (trimmed), and router skips,
  - the ticket id as `session.id`.

  It works with LangSmith, Langfuse, Phoenix or Jaeger. It uses the Python standard library only.

### 11. Dashboard database: every ticket, its output and its grade (`observe/db.py`)
`ff db up` starts a local MySQL 8.4 container (`factory-mysql`, data in the `factory-mysql-data` volume, port `127.0.0.1:3307`), saves `DB=mysql` and a generated `DB_PASSWORD` in `config.env`, and from then on every run is stored in database `factory`. No MySQL client is needed on the host: the sync runs through `docker exec`.

| Table | One row per |
|---|---|
| `tickets` | ticket, with its description |
| `runs` | run: status, PR, verdict, judge score, diff size, spec, plan, tests, PR text |
| `agent_steps` | agent step: CLI, model, duration, exit code, router skips, skills used, prompt and output |
| `reviews` | review round |
| `judgements` | the judge's report |

| View | Answers |
|---|---|
| `v_runs` | the overall picture: every ticket, status, PR, judge score, criteria met, hallucinations |
| `v_agent_stats` | how many steps each agent and model ran, failures, average time |
| `v_criteria` | every acceptance criterion and whether it was met, with evidence |
| `v_hallucinations` | claims the diff does not support |
| `v_prompt_suggestions` | prompt fixes per agent: input for improving `agents/*.md` |

- **Schema:** `observe/schema.sql` creates or updates the tables on every sync (indexed foreign keys, checked values; safe to run again).
- **Re-send a run:** `ff sync <ticket>`.
- **Browsing:** `ff db ui` opens Adminer on `http://localhost:8081`; `ff db sql "<query>"` runs one query. Or point Metabase or Grafana at `127.0.0.1:3307` for charts.
- **Stopping:** `ff db down` stops the containers and keeps the data.

### 12. Intake: manual or automatic
- **V1 is manual (`AUTO_PICKUP=0`):** tickets run only when you start them, with the view, `run`, `enqueue` or `poll --now`.
- **Automatic (`AUTO_PICKUP=1`):** every `POLL_INTERVAL`, `schedule` (macOS launchd) runs up to `MAX_PER_RUN` assigned tickets one by one, or the daemon queues them and runs up to `MAX_PARALLEL` at once.
- **A manual `run`** does the full pipeline whatever the ticket's status, and skips the spec gate.

### 13. Server mode (Docker Compose)
The orchestrator runs as a long-lived container, and each agent runs in a sibling container on the host's Docker.
- **Startup:** it sets up GitHub access from `GH_TOKEN`, clones `GH_REPO` once, then works through a queue.
- **Ports:** outbound calls only, so no inbound ports.
- **Hosts:** any Linux VM or EC2 instance with Docker.

### 13b. Operations (server)
- **Preflight:** the daemon runs `ff doctor` at start and does not start on a FAIL, so a bad token or missing branch shows at deploy time, not halfway through a ticket.
- **Restarts:** a queued ticket is claimed (moved to `state/queue/running/`) and removed only when its run ends. `docker stop` stops the running ticket and its agent containers within seconds; on the next start the claim is queued again and the run resumes from its journal. Locks left by the old container are cleared.
- **One daemon per data folder:** a second daemon refuses to start.
- **Health:** the Compose healthcheck runs `ff health` (daemon alive, Docker reachable).
- **Parallel:** up to `MAX_PARALLEL` tickets run at once, each in its own cell (2b). `docker stop` stops all of them; each one's claim is kept and resumes on the next start.
- **Disk:** the daemon runs `ff gc` once a day. Worktrees whose PR is merged or closed are removed, and so are worktrees idle for `GC_DAYS` (14). For an idle one, the branch and run folder stay, so `ff run` rebuilds the worktree. Old lines leave `state/events.jsonl` and `state/decisions.jsonl`.
- **Logs:** the container's log is rotated by Docker (5 × 10 MB). Per-ticket logs are in `runs/<ticket>/`.
- **Timeouts:** tracker calls time out after 60s and retry transient errors 3 times. Agent steps are bounded by `AGENT_TIMEOUT`.
- **Secrets on disk:** a step script holds the agent's API keys only until bash has opened it; it deletes itself first.
- **Image:** agent CLI versions are pinned in the `Dockerfile` (`AGENT_PACKAGES`). Bump them on purpose, then check that the session flags the cells rely on still exist (`claude --help | grep no-session-persistence`, `codex exec --help | grep ephemeral`) and run `tests/e2e.sh docker headless parallel`.

### 14. Extension points
Each extension point is a folder of files that share one small contract. Adding a new implementation is one new file, with no edit to `factory.sh`.

| Folder | Chosen by | Contract | Included |
|---|---|---|---|
| `tracker/` | `TRACKER` | 7 functions (top of `tracker/clickup.sh`) | clickup |
| `sandbox/` | `SANDBOX` | `sandbox_check`, `sandbox_cmd` (top of `sandbox/none.sh`) | docker, none |
| `display/` | `DISPLAY_UI` | 4 functions (top of `display/headless.sh`) | headless, herdr |
| `agents/` | file name | prompt + `skills:` header | 9 agents |
| `router.json` | `clis`, `lanes` | config only | 5 CLIs |
| `router.py` `QUOTAS` | provider name | `probe`, `blocked`, `headroom` | codex, opencode-go, cursor |

---

## Commands

`ff` is a link to `factory.sh` (created with `ln -s ~/software-factory/factory.sh ~/.local/bin/ff`), so it works from any folder. In Docker use `./factory.sh`.

    ff login [KEY]        CLI logins + quota; with a key name, store that key
    ff whoami             tracker ids for config.env
    ff run KEY-123        full pipeline for one ticket (key, id or URL)
    ff view               live graph + ticket input box
    ff route KEY-123      dry run: which CLI and model each agent would get now
    ff trace KEY-123      what each agent did in the latest run (--send: export again)
    ff sync KEY-123       store the latest run in the dashboard database again
    ff poll --now         take one assigned ticket now
    ff enqueue KEY-123    queue a ticket for the daemon
    ff daemon [--once]    server loop: queue (MAX_PARALLEL at once), plus polling if AUTO_PICKUP=1 (--once: run the queue and exit)
    ff doctor             preflight: tools, repo, base branch, gh, tracker, sandbox, agent CLIs, disk
    ff health             exit 0 when the daemon is up and Docker is reachable (container healthcheck)
    ff gc [days]          remove worktrees of merged or closed PRs, and worktrees and log lines idle for N days (default GC_DAYS=14)
    ff db up|down|status|ui|sql   the local dashboard database
    ff status             running tickets (slot, ports), queue, failed tickets, recent runs
    ff retry <id> | schedule [secs] | unschedule

## Setup (laptop)

    cp config.example.env config.env      # the one file for settings and secrets
    ff whoami                   # copy the tracker ids into config.env
    ff login                    # check CLI logins; add keys with: ff login <KEY>
    docker build -t software-factory .    # sandbox image (skip if SANDBOX=none)
    ff route KEY-123            # check routing
    ff run KEY-123

Create the tracker statuses named in `config.env`, or map them to existing ones. Inside Herdr, `run` opens the live graph and a workspace for the ticket by itself.

## Setup (server, EC2 or any Docker host)

    git clone <this repo> && cd software-factory
    sudo mkdir -p /srv/factory/secrets/home
    sudo cp config.example.env /srv/factory/config.env   # fill it in, plus GH_TOKEN and GH_REPO
    # login files, laid out like a home folder:
    #   /srv/factory/secrets/home/.codex/auth.json, .../.local/share/opencode/auth.json, ...
    docker compose up -d --build
    docker compose exec factory ./factory.sh login ANTHROPIC_API_KEY
    docker compose exec factory ./factory.sh enqueue KEY-123
    docker compose exec factory ./factory.sh view

Before the first `up`, run `docker compose run --rm factory doctor` and fix any FAIL line: the daemon runs the same
checks at start and refuses to start on a FAIL.

`FACTORY_DATA=/some/path` moves the data folder. It is mounted at the same path inside and outside on purpose, because the agent containers are started on the host's Docker.

## Tests

    python3 -m unittest test_router              # router, logins, quota, same-model routes, redact (20 tests)
    tests/e2e.sh [none|docker] [headless|herdr] [pass|fail|deltests|edittests|verify|parallel]
                                                 # whole pipeline, no network: fake tracker, gh and agents.
                                                 # Without a mode argument: pass
    tests/e2e.sh none headless pass              # one ticket through every agent, PR, judge, then the daemon resuming a claimed ticket, and gc
    tests/e2e.sh none headless fail              # the coder crashes: ticket blocked, trace marks the failure
    tests/e2e.sh none headless deltests          # the coder deletes spec tests: run blocked
    tests/e2e.sh none headless edittests         # the coder edits a frozen spec test without saying so: run blocked
    tests/e2e.sh none headless verify            # VERIFY_CMD fails after the coder, the coder's second session fixes it
    tests/e2e.sh none headless parallel          # the daemon runs two tickets at once, each in its own cell
    DB=mysql DB_CONTAINER=<scratch> DB_PASSWORD=... tests/e2e.sh   # also checks the stored rows (never the real database)

In every mode where the coder runs, it also tries to escape its cell: move `main`, create a branch, tag, and
stash. The `pass` mode checks that the guard hook refused all four and that the base branch and the shared
stash are unchanged.

Run the same modes with `docker` in place of `none` to use the sandbox image (build it first with
`docker build -t software-factory .`). Each agent step then runs in its own container. All six modes
above pass with `docker`.

CI (`.github/workflows/ci.yml`) runs shellcheck on `factory.sh`, `cell.sh` and the other scripts, the unit
tests, and every `none` mode on each push. The docker job builds the image, runs `pass` and `parallel` in the
Docker sandbox, and checks the session flags in the image.

---

## Compared with super-board

| super-board | here |
|---|---|
| Board columns are the state, the human curates `Ready` | yes: tracker statuses, only assigned `S_TODO` / `S_APPROVED` tickets |
| Orchestrator never codes, one headless worker per lane | yes, with 9 specialist agents |
| Spec-driven, Matt Pocock skill map (`to-spec`, `tdd`, `implement`, `code-review`, ...) | yes, plus a test writer that turns acceptance criteria into failing tests first |
| Worktree per issue, branch from the base branch | yes |
| Builder never merges, separate reviewer | yes, and a human merges (no auto-merge gate) |
| Review findings remembered across rounds | yes: the reviewer re-checks earlier `review-N.md` |
| `Skills:` line on a card | yes, plus per-agent skills |
| Model ladder by difficulty | yes, plus quota gates and Jev |
| Stop and resume from board state | resume yes. No `stop` command: stop the process or container |
| QA lane (Playwright evidence) | no |
| Skip labels, `Depends on:` lines, P1 to P4 ordering | no |
| Parallel workers | yes: `MAX_PARALLEL`, one worktree and cell per ticket |
| `lint` (vague acceptance criteria) | partly: the spec writer stops with NEEDS_INPUT |
| Worktree cleanup | yes: `ff gc` removes worktrees of merged or closed PRs |
| Guard hooks | yes: a git hook keeps each agent on its own branch |
| Auto merge gate, `super-collect` | no |

## Known limits
- **Tracker:** only the ClickUp adapter exists. **Git host:** GitHub only, through `gh`.
- **Keychain logins:** Claude Code and Cursor keep their logins in the macOS Keychain, which containers cannot see. For the sandbox set `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) and `CURSOR_API_KEY` with `ff login <KEY>`.
- **Dashboard database:** a single local MySQL container, not a managed database. Back up the `factory-mysql-data` volume if the history matters.
- **Running a finished ticket again:** it starts over from the base branch, so the push of the new branch is rejected while the old remote branch exists (the factory never force-pushes). To redo a finished ticket, close its PR and delete the remote branch first.
- **OpenCode Go meter:** it counts only this factory's calls, not your other OpenCode use. Set `5h_budget` below your plan's real limit.
- **Sandbox network:** agents can reach the network (they need the model APIs).
- **Shared `.git`:** an agent can write the repo's `.git`, which holds every branch. The guard hook stops git commands from changing other refs, but an agent that deliberately writes files under `.git`, or turns the hook off, gets past it. The guard stops mistakes, not attacks. The script never force-pushes, so other tickets' pushed work is safe either way.
- **Conflicts between parallel tickets:** each PR is cut from `origin/$BASE` when its ticket starts. Two tickets that change the same lines conflict when the second is merged; the factory does not rebase.
- **OpenCode sessions:** `opencode run` has no flag to skip saving sessions (checked against `opencode run --help`), so the "keeps nothing" rule does not hold for it. With `SANDBOX=docker` each step's container is removed afterwards, so its sessions go with it. With `SANDBOX=none` they stay in `~/.local/share/opencode`. This is not tested yet.
- **Server mode:** it mounts the Docker socket, which gives the factory container root-level control of the host. Use a dedicated VM.
- **Herdr display:** for laptop use. A launchd job or the server has no Herdr session.
- **Token and cost tracking:** agent CLIs do not report tokens in one common format, so traces carry no tokens or cost yet.
- **`schedule`:** macOS only. Use cron on Linux, or the daemon.

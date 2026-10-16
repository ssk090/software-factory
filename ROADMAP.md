# Roadmap

Planned work, not built yet. Each item says what it is, why, how it fits the factory, and what is
still open. The order is the suggested order: each item uses the one before it.

## 1. Agents choose their skills from Superpowers and mattpocock/skills

**Now.** Each agent file lists fixed skills in its `skills:` header. Both sets are vendored
(`skills/superpowers/`, `skills/mattpocock/`), but the test writer, coder and fixer were moved to
Superpowers (`test-driven-development`, `systematic-debugging`, `verification-before-completion`)
in place of mattpocock's `tdd` and `diagnosing-bugs`, so the agents follow one standard.

**Next.** Keep both sets and let the agent pick what fits the ticket.
- Each role keeps a short **required** list (what the pipeline depends on, such as
  `writing-plans` for the planner).
- The prompt also gets a **catalog**: every skill of both sets that suits the role, one line each
  (name and the `description` from its SKILL.md front matter), not the whole file. The agent reads
  only the skills it decides to use, from `RUN_DIR/skills/`, and names them in one line of its
  output (for example `skills used: test-driven-development, mattpocock/tdd`).
- Where two skills cover the same ground (`test-driven-development` and `tdd`), the catalog says
  so, and the agent picks one. Two TDD guides in one step must not happen.
- `skills.log` records what was offered and what was used, per step.
- Later: compare the judge's score and the review rounds by the skills used, and drop a skill
  that never helps.

**Open.** How many catalog lines a role gets before the prompt costs more than it saves (both sets
together hold over 40 skills). Whether the catalog is fixed per role or filtered by Jev (item 2).

## 2. Jev: a decision model for the factory's choices

[Jev](https://typesafe.ai) (typesafe.ai) answers questions about a task with calibrated
probabilities. jroute calls it once per task (`POST https://api.typesafe.ai/v1/systemone`, model
`jev-1.13.0`) with questions such as:

| Question | Kind | Answer |
| --- | --- | --- |
| `family` | choice | plan, implement, debug, review or chore |
| `complexity` | score | trivial, routine, moderate, hard, frontier |
| `consequence` | probability | expensive to undo: production, security, money, data loss |
| `needs_design` | probability | decisions to make before code, or the approach is known |
| `is_question` | probability | asks for information, not a change |

`config.env` already holds a `TYPESAFE_API_KEY`.

**Where the factory asks.**
- At `fetch`: on the ticket (and the Sentry issue, if it came from one).
- After the plan, before the gate: on the spec and the plan, which say much more than the ticket.

**What its answers decide** (code decides, with Jev's answers as input, never Jev alone):
- the models (item 3);
- the shape of the run: a chore skips the docs writer and the judge; a high `consequence` keeps
  the spec gate on even when `SPEC_GATE=0`, and adds a review round;
- the skill catalog (item 1): a `debug` family offers `systematic-debugging` first;
- later, the order of *Fix first* for Sentry issues.

**Rules.**
- Optional. No key, a failure or a timeout means the factory works as now (lanes in order).
- One batched call per decision point, through the throttle (item 3 counts its cost).
- Text leaves the machine: redact credential-shaped strings first, as jroute does, and send only
  the ticket, spec and plan, never code or `config.env`.
- Every answer is a ticket event (the timeline shows "Jev: debug, hard, consequence 0.8") and a
  line in `route.log`, so a routing choice can be explained afterwards.
- Tests replay a recorded answer from a file (jroute's `JROUTE_JEV_FIXTURE`), with no key and no
  network.

**Open.** Whether to call Jev again after a failed verify or a FIX review, and what it may change
then. The price per call.

## 3. Models routed by the ticket, the spec and the plan

Reference: [jroute](https://github.com/ssk090/jroute), which this factory already follows for the
ordered model chain per role (`durable/lanes.json`).

**Now.** Each role has a chain, preferred first; a step takes the first usable model and moves to
the next on a failure. The reviewer and the judge never use the coder's family.

**Next.** jroute's rule: *Jev never picks a model, it picks where to start in the chain.*
- Each chain is ordered cheap to strong (or a role gets two chains). Jev's `complexity` and
  `consequence` give a start offset: routine work starts at the cheap end; hard work, or work that
  is expensive to undo, starts further along and does not waste a failed attempt on a cheap model.
- The spec writer and the planner are routed by the ticket. The test writer, coder and fixer are
  routed again by the spec and plan (the second Jev call), since they say how big the change is.
- Quota and spend: a provider at its daily budget or rate limit (the throttle knows) leaves the
  candidate set before a step starts, rather than after it fails, like jroute's quota check.
- The family rule stays: the reviewer and the judge never run on the coder's family.
- A failure still moves along the chain from where the step started.

**Open.** Whether a role needs two chains (fast and deep) or one ordered chain is enough.
Per-provider quota for subscriptions (jroute reads Codex, Cursor and OpenCode usage) versus API keys
and spend only, as the factory uses now.

## 4. A Changes tab: the agents' code, live, in the ticket panel

Today the code shows only in the PR's "Files changed", so only once the PR is open. A **Changes**
tab shows the worktree's diff against `refs/remotes/origin/<base>` (also uncommitted edits) while
the test writer and the coder work: a file list with +/− counts, unified diffs with line numbers,
the commits, and links to VS Code, the PR and github.dev. Read-only, rendered as text only, redrawn
only when the diff changes. Later: syntax colouring and side-by-side with diff2html, and selecting
lines to steer the running step. Issue: https://github.com/ssk090/software-factory/issues/2

## Not planned

- Running agents through vendor CLIs and their subscription quotas (jroute does this with Herdr
  panes). The factory runs every agent on pi-ai with API keys inside one durable session, and that
  stays.

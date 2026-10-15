# Agents

One file per agent. Each agent is a fresh headless run of a CLI and model picked by `router.py`
(the router looks up the agent's file name under `lanes` or `aliases` in `router.json`). Agents
talk only through files in the ticket's run folder, never to each other.

| Agent | File | Reads | Writes |
|---|---|---|---|
| orchestrator | `.ff` (a script, not an LLM) | tracker, agent outputs | ticket status, comments, worktree, push, PR |
| spec writer | `spec.md` | ticket, comments | `spec.md` (ends with STATUS: READY or NEEDS_INPUT) |
| planner | `plan.md` | spec | `plan.md` (AC to test to code) |
| test writer | `test.md` | spec, plan | failing tests committed first, `tests.md` |
| coder | `code.md` | spec, plan, tests, comments | commits that make the tests pass, or `blocked.md` |
| docs writer | `docs.md` (optional) | diff, spec | docs commits, `docs.md` |
| PR summary writer | `pr-summary.md` | commits, diff, spec, reviews | `pr-title.txt`, `pr-body.md` |
| code reviewer | `review.md` | diff, spec, earlier reviews | `review-N.md` (ends with VERDICT: PASS or FIX) |
| fixer | `fix.md` | latest review | commits, `fix-notes.md` |
| judge | `judge.md` | everything, plus the real diff | `judge.json`: criteria met, hallucinations, score, prompt fixes |

Flow: spec -> planner -> (human gate) -> test writer -> coder -> docs -> PR summary -> draft PR -> review <-> fix -> PR summary again -> judge -> ready.

Each file starts with a header:

    ---
    name: review
    skills: ponytail-review
    ---

- **Skills:** list skill names in `skills:` (comma separated). A ticket can add skills with a line `Skills: a, b` in its description. Each skill is looked up in the ticket's repo first (`REPO_SKILL_DIRS`, so a repo's own `review-a` or `tdd` wins), then on `SKILLS_PATH`, copied into the ticket's run folder so a sandboxed agent can read it, and the agent is told to read and follow it. Works the same with every CLI. A missing skill is logged and skipped. Put team skills in `../skills/` so they ship with the factory and the Docker image.
- **Change an agent:** edit its file.
- **Turn off the docs agent:** delete `docs.md`.
- **Change which models an agent uses:** edit `router.json`.
- **Add an agent:** add its file, give it a chain or alias in `router.json`, and call `agent <name> <cwd>` in the stage of `factory.sh` where it belongs.

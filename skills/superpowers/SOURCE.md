Superpowers skills by Jesse Vincent (obra), copied from https://github.com/obra/superpowers at commit bb92a77 (MIT, see LICENSE).

Copied, for one headless agent each:
- `test-driven-development`: the test writer, the coder and the fixer (in place of `tdd`, so the agents follow one standard);
- `verification-before-completion`: the test writer, the coder and the fixer;
- `systematic-debugging`: the coder and the fixer (in place of `diagnosing-bugs` for the fixer); its files that test the skill itself (`test-*.md`, `CREATION-LOG.md`) are left out;
- `writing-plans`: the planner;
- `receiving-code-review`: the fixer.

Left out: `brainstorming` (it asks a person), `dispatching-parallel-agents`, `subagent-driven-development` and `executing-plans` (they start other agents), `using-git-worktrees`, `finishing-a-development-branch` and `requesting-code-review` (the factory makes the worktree, pushes, opens the PR and runs the reviewer), and `using-superpowers`, `writing-skills`, `diagnosing-superpowers` (about the skills themselves).

The skills talk to "your human partner" and name files to save (docs/superpowers/plans/...). The factory's skill note tells the agent that nobody answers during a run and that it writes only the files its instructions name (durable/src/skills.ts, SKILLS_NOTE).

Agents name them by their own names (`test-driven-development`, ...); no other set has these names.

Update:

    git clone --depth 1 https://github.com/obra/superpowers /tmp/sp
    for d in test-driven-development verification-before-completion systematic-debugging writing-plans receiving-code-review; do rm -rf "skills/superpowers/$d"; cp -R "/tmp/sp/skills/$d" skills/superpowers/; done
    rm -f skills/superpowers/systematic-debugging/test-*.md skills/superpowers/systematic-debugging/CREATION-LOG.md
    cp /tmp/sp/LICENSE skills/superpowers/LICENSE

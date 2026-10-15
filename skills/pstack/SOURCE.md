pstack skills by Lauren Tan (poteto), copied from https://github.com/cursor/plugins/tree/main/pstack at commit e5136d8 (pstack 0.15.25, MIT, see LICENSE).

Only the skills that run in a single headless agent are copied: the principle skills, `sharpen`, `tdd`, `blast-radius`, `technical-writing`, `unslop`, `correct` and `typescript-best-practices`. Left out:
- skills that spawn Cursor `Task` subagents with Cursor model slugs (`poteto-mode`, `arena`, `architect`, `swarm`, `interrogate`, `how`, `why`, `recall`, `reflect`, `show-me-your-work`, and others), because the factory runs each agent as one session on any CLI;
- skills that ask the user questions (`setup-pstack`, `automate-me`);
- skills written for a person reading a chat (`ketchup`, `bro`, `in-your-own-words`, `teach`, `poteto-help`).

`blast-radius` can suggest running an `arena` for a wide change. The factory prompt tells agents to skip a skill that is not in their run folder, so they skip that step.

Agents name these skills with the `pstack/` prefix (for example `skills: pstack/blast-radius`), because `tdd` also exists in `skills/mattpocock/`.

Update:

    git clone --depth 1 https://github.com/cursor/plugins /tmp/cp
    for d in skills/pstack/*/; do rm -rf "$d"; cp -R "/tmp/cp/pstack/skills/$(basename "$d")" skills/pstack/; done
    cp /tmp/cp/pstack/LICENSE skills/pstack/LICENSE

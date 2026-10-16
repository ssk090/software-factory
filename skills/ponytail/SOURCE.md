Ponytail skills by Dietrich Gebert, copied from https://github.com/dietrichgebert/ponytail at commit 6f1c2bf (MIT, see LICENSE).

Copied: `ponytail` (the smallest complete change; the coder and the fixer use it) and `ponytail-review` (a review checklist, not used by an agent yet). Left out: `ponytail-help`, `ponytail-gain`, `ponytail-debt` and `ponytail-audit`, because they talk to a person in a chat or report on a whole repository, and the plugin files for other hosts.

Agents name it `ponytail` (no other set has a skill of that name).

Update:

    git clone --depth 1 https://github.com/dietrichgebert/ponytail /tmp/pt
    for d in ponytail ponytail-review; do rm -rf "skills/ponytail/$d"; cp -R "/tmp/pt/skills/$d" skills/ponytail/; done
    cp /tmp/pt/LICENSE skills/ponytail/LICENSE

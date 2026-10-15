#!/usr/bin/env bash
# Container start: give git/gh credentials, clone the repo once, then hand over to factory.sh.
set -euo pipefail
# settings and secrets come from the same config file factory.sh reads
set -a; [ -f "${FACTORY_CONFIG:-}" ] && . "$FACTORY_CONFIG"; set +a
: "${GH_TOKEN:?set GH_TOKEN (a GitHub token that can push branches and open PRs)}"
: "${GH_REPO:?set GH_REPO (owner/name)}"
git config --global user.name "${GIT_USER_NAME:-software-factory}"
git config --global user.email "${GIT_USER_EMAIL:-factory@localhost}"
gh auth setup-git
[ -d "$REPO/.git" ] || gh repo clone "$GH_REPO" "$REPO"
exec /factory/factory.sh "$@"

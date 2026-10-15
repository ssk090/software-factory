# shellcheck shell=bash
# The ticket cell: what keeps one ticket's agents apart from every other ticket's agents.
# Sourced by factory.sh.
#
# Every ticket runs in its own git worktree, on its own branch, with its own run folder, its
# own port range and its own compose project. Tickets share one .git, so:
#   - git commands that change the shared repo (fetch, worktree add and remove, branch delete,
#     push, gc) hold the repo lock (repo_locked): git's own ref locks fail instead of waiting;
#   - a reference-transaction hook stops an agent from changing any ref except its own branch.
#     Other tickets' branches, the base branch, tags and the shared stash are off limits;
#   - automatic git gc is off inside agent steps. `ff gc` runs it under the repo lock.
# Each agent step is a new session that keeps nothing: the CLIs run without session files and
# without auto-memory (router.json flags, CLAUDE_CODE_DISABLE_AUTO_MEMORY), so nothing one
# ticket's agent learns reaches another ticket. Agents of one ticket talk only through files in
# its run folder.

: "${SLOTS:=8}"                                  # cells that can run at once on this machine
: "${CELL_PORT_START:=20000}" "${CELL_PORT_SPAN:=100}"   # cell N gets ports START+N*SPAN ... +SPAN-1

# repo_locked <command...>: run a command that changes the shared .git while holding the repo
# lock. It is a flock, so the kernel releases it when the holder dies: a crash leaves no stale
# lock. Do not nest calls.
repo_locked() {
  local rc
  exec 9>>"$STATE/repo.lock"
  perl -MFcntl=:flock -e '$SIG{ALRM} = sub { exit 1 }; alarm shift; open(my $f, ">&=", 9) or exit 2; flock($f, LOCK_EX) or exit 1' \
    "${REPO_LOCK_TIMEOUT:-600}" || { exec 9>&-; log "repo lock: still busy after ${REPO_LOCK_TIMEOUT:-600}s"; return 1; }
  "$@" 9>&-; rc=$?
  exec 9>&-
  return $rc
}

# take_slot: claim a free cell slot (state/slot-N holds the pid). Sets SLOT.
take_slot() {
  local i
  for i in $(seq 0 $((SLOTS - 1))); do take_lock "$STATE/slot-$i" && { SLOT=$i; return 0; }; done
  return 1
}

# cell_enter: set the variables every step of this ticket gets (CELL_ENV names them; step()
# exports them in the step script and the sandbox passes them in). They are not exported here,
# so the orchestrator's own git commands do not run the guard hook.
# shellcheck disable=SC2034  # read through ${!name} when step() writes the step script
cell_enter() {
  FACTORY_TICKET=$CID FACTORY_SLOT=$SLOT
  PORT_BASE=$((CELL_PORT_START + SLOT * CELL_PORT_SPAN)); PORT=$PORT_BASE
  COMPOSE_PROJECT_NAME="factory-$(lc "$CID" | tr -c 'a-z0-9\n' '-')"
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
  GIT_CONFIG_COUNT=4
  GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$RUN/git-hooks"
  GIT_CONFIG_KEY_1=gc.auto        GIT_CONFIG_VALUE_1=0
  GIT_CONFIG_KEY_2=maintenance.auto GIT_CONFIG_VALUE_2=false
  GIT_CONFIG_KEY_3=safe.directory GIT_CONFIG_VALUE_3='*'
  CELL_ENV="FACTORY_TICKET FACTORY_SLOT PORT_BASE PORT COMPOSE_PROJECT_NAME CLAUDE_CODE_DISABLE_AUTO_MEMORY GIT_CONFIG_COUNT"
  local i; for i in 0 1 2 3; do CELL_ENV="$CELL_ENV GIT_CONFIG_KEY_$i GIT_CONFIG_VALUE_$i"; done
  cell_hooks
}

# cell_hooks: write RUN/git-hooks. reference-transaction is the guard. Every other hook, and the
# guard once it allows a change, runs the repo's own hook (husky and similar keep working).
cell_hooks() {
  local d="$RUN/git-hooks" h common
  common=$(cd "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)" && pwd -P) || return 1
  rm -rf "$d"; mkdir -p "$d"
  cat >"$d/forward" <<'EOF'
#!/bin/sh
# Run the repo's own hook <name>: core.hooksPath without the factory's override, else .git/hooks.
name=$1; shift
dir=$(GIT_CONFIG_COUNT=0 git config core.hooksPath)
[ -n "$dir" ] || dir="$(git rev-parse --git-common-dir)/hooks"
case $dir in /*) ;; *) dir="$(git rev-parse --show-toplevel)/$dir" ;; esac
[ -x "$dir/$name" ] || exit 0
exec "$dir/$name" "$@"
EOF
  for h in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg \
           commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-auto-gc post-rewrite \
           push-to-checkout post-index-change sendemail-validate; do
    printf '#!/bin/sh\nexec "$(dirname "$0")/forward" %s "$@"\n' "$h" >"$d/$h"
  done
  { printf '#!/bin/sh\n# Ticket guard (written by the factory): an agent of %s may change only its own branch.\n' "$CID"
    printf 'BR=%s\nCOMMON=%s\nLOG=%s\n' "'$BR'" "'$common'" "'$RUN/guard.log'"
    cat <<'EOF'
in=$(cat)
# another repository (an agent cloned something): not ours to guard
here=$(cd "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
if [ "$1" = prepared ] && [ "$here" = "$COMMON" ]; then
  bad=
  while read -r old new ref; do
    [ -n "$ref" ] || continue
    case $ref in
      "refs/heads/$BR"|refs/remotes/*|refs/rewritten/*|refs/worktree/*|refs/bisect/*) ;;
      refs/*|worktrees/*|main-worktree/*) bad="$bad $ref" ;;
      *) ;;   # HEAD, ORIG_HEAD and other pseudo refs of this worktree
    esac
  done <<EOT
$in
EOT
  if [ -n "$bad" ]; then
    echo "software-factory: refused to change$bad. This agent works only on branch $BR: other tickets' branches, the base branch, tags and git stash are off limits (the stash is shared by every worktree). Commit on $BR instead." >&2
    echo "$(date '+%F %T')$bad" >>"$LOG"
    exit 1
  fi
fi
printf '%s' "$in${in:+
}" | "$(dirname "$0")/forward" reference-transaction "$@"
EOF
  } >"$d/reference-transaction"
  chmod +x "$d"/*
}

# cell_leave: give the slot back.
cell_leave() { [ -n "${SLOT:-}" ] && rm -rf "$STATE/slot-$SLOT"; SLOT=; }

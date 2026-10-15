# shellcheck shell=bash
# Sandbox: docker. Each step gets a fresh container, removed afterwards. It sees only this
# ticket's worktree, its run dir, the repo's .git (needed to commit) and the step's agent login
# files and keys. No home dir, no SSH keys, no GitHub token, no other tickets.
# Paths are the same inside and outside. Contract: see sandbox/none.sh.
: "${SANDBOX_IMAGE:=software-factory}" "${SANDBOX_ARGS:=}"

sandbox_check() {
  docker info >/dev/null 2>&1 || { log "Docker is not running. Start Docker Desktop, or set SANDBOX=none"; return 1; }
  docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 && return 0
  # Docker Desktop can clean up images, so build it again rather than stopping (a few minutes).
  log "sandbox image $SANDBOX_IMAGE missing, building it (a few minutes)" >&2
  docker build -q -t "$SANDBOX_IMAGE" "$HERE" >"$STATE/image-build.log" 2>&1 && return 0
  log "building the sandbox image failed, see $STATE/image-build.log"; return 1
}

sandbox_cmd() {
  local name=$1 cwd=$2 cmd=$3 who mail p e
  who=$(git -C "$REPO" config user.name || echo software-factory)
  mail=$(git -C "$REPO" config user.email || echo factory@localhost)
  local args=(docker run --rm --name "$name" -w "$cwd"
    -v "$cwd:$cwd" -v "$RUN:$RUN" -v "$REPO/.git:$REPO/.git"
    -e PROMPT -e IS_SANDBOX=1
    -e GIT_AUTHOR_NAME="$who" -e GIT_COMMITTER_NAME="$who" -e GIT_AUTHOR_EMAIL="$mail" -e GIT_COMMITTER_EMAIL="$mail"
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*')
  for p in $AGENT_AUTH; do [ -e "$AUTH_HOME/$p" ] && args+=(-v "$AUTH_HOME/$p:/root/$p"); done
  for e in $AGENT_ENV; do args+=(-e "$e"); done
  # shellcheck disable=SC2206  # SANDBOX_ARGS holds extra docker flags, e.g. "--cpus 2 --memory 6g"
  args+=($SANDBOX_ARGS --entrypoint bash "$SANDBOX_IMAGE" -c "$cmd")
  # The docker client ignores signals, so a watchdog kills the container at the time limit.
  printf 'perl -e %q %q docker kill %q >/dev/null 2>&1 &\n' 'sleep shift; exec @ARGV' "$AGENT_TIMEOUT" "$name"
  printf '%q ' "${args[@]}"
  printf '\nrc=$?; kill $! 2>/dev/null; exit $rc\n'
}

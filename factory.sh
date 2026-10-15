#!/usr/bin/env bash
# software-factory orchestrator: tracker ticket -> agents -> pull request.
# The ticket status is the state. This script never writes product code: agents do (agents/).
# Extension points, each a folder of files that share one small contract:
#   tracker/<TRACKER>.sh     where tickets come from      (clickup)
#   sandbox/<SANDBOX>.sh     how an agent step is isolated (docker, none)
#   display/<DISPLAY_UI>.sh  where you watch the steps     (headless, herdr)
#   agents/<name>.md         what each agent does
#   router.json              which CLI and model each agent uses
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"   # works through the `ff` link too
CONFIG="${FACTORY_CONFIG:-$HERE/config.env}"
# config file is optional: in Docker the same settings can come from environment variables
set -a; [ -f "$CONFIG" ] && . "$CONFIG"; set +a

: "${BASE:=develop}" "${SETUP_CMD:=}" "${VERIFY_CMD:=}" "${REPO:=$PWD}"
: "${S_TODO:=to do}" "${S_SPEC_REVIEW:=spec review}" "${S_APPROVED:=approved}"
: "${S_WORKING:=in progress}" "${S_IN_REVIEW:=in review}" "${S_BLOCKED:=blocked}"
: "${SPEC_GATE:=1}" "${MAX_REVIEW_ROUNDS:=2}" "${MAX_PER_RUN:=1}" "${AGENT_TIMEOUT:=3600}"
: "${GC_DAYS:=14}"                               # ff gc: worktrees and logs idle this many days are removed
: "${MAX_PARALLEL:=1}"                           # the daemon runs this many tickets at once, each in its own worktree
: "${CACHE_VOLUME:=factory-cache}"               # docker sandbox: package download cache shared by all worktrees (empty = off)
: "${TRACKER:=clickup}" "${SANDBOX:=docker}" "${DISPLAY_UI:=auto}"
: "${AUTH_HOME:=$HOME}"; export AUTH_HOME   # where agent CLI login files live
: "${PR_LABEL:=}"                                # label put on every PR the factory opens
: "${TRACKER_COMMENTS:=0}"                       # 1 = also post spec, failures and PR links as ticket comments
# Dashboard database: a local MySQL container (DB=mysql turns it on). See `ff db`.
: "${DB:=}" "${DB_CONTAINER:=factory-mysql}" "${DB_IMAGE:=mysql:8.4}" "${DB_VOLUME:=factory-mysql-data}"
: "${DB_NETWORK:=factory-net}" "${DB_PORT:=3307}" "${DB_UI_PORT:=8081}" "${DB_PASSWORD:=}"
export DB_CONTAINER DB_PASSWORD
# Skills: the ticket's repo is searched first (its own skills win), then the factory's SKILLS_PATH.
# A skill is a folder with a SKILL.md, or a single <name>.md file (commands, flat skills).
: "${REPO_SKILL_DIRS:=.claude/skills .agents/skills .codex/skills .cursor/skills .opencode/skills .claude/commands .codex/prompts .cursor/commands .opencode/command}"
: "${SKILLS_PATH:=$HERE/skills:$HOME/.agents/skills:$HOME/.claude/skills:$HOME/.codex/skills:$HOME/.pi/agent/skills:$HOME/.pi/agent/git}"
[ -n "${GH_REPO:-}" ] && export GH_REPO
if [ "$DISPLAY_UI" = auto ]; then
  DISPLAY_UI=headless
  [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null && DISPLAY_UI=herdr
fi
DATA_DIR="${DATA_DIR:-$HERE}"; export DATA_DIR   # all mutable files live here
STATE="$DATA_DIR/state"; RUNS="$DATA_DIR/runs"; TREES="$DATA_DIR/worktrees"
mkdir -p "$STATE/failed" "$STATE/queue" "$RUNS" "$TREES"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill -TERM "$1" 2>/dev/null; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# branch_name: the ticket's branch, {type}/{ticket}/{short-desc} (repo convention, git-pr-summary
# skill), chosen once and kept in RUN/branch. Type: BRANCH_TYPE, else guessed from the title's
# first word, else feature. Runs started before this keep their old feature/<ticket> branch.
branch_name() {
  [ -s "$RUN/branch" ] && { cat "$RUN/branch"; return; }
  local b type slug
  if [ -z "${FRESH:-}" ] && git -C "$REPO" show-ref -q "refs/heads/feature/$CID"; then b="feature/$CID"
  else
    case "$(lc "${TITLE%% *}")" in fix*|bug*) type=fix ;; chore*) type=chore ;; doc*) type=docs ;; refactor*) type=refactor ;; *) type=feature ;; esac
    type=${BRANCH_TYPE:-$type}
    slug=$(lc "$TITLE" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
    # max 40 chars, cut at a word boundary
    [ ${#slug} -gt 40 ] && { slug=${slug:0:41}; slug=${slug%-*}; }
    b="$type/$CID${slug:+/$slug}"
  fi
  echo "$b" >"$RUN/branch"; echo "$b"
}

# TRACKER is a name in tracker/ or a path to an adapter file (tests use their own)
# shellcheck source=/dev/null
case "$TRACKER" in */*) . "$TRACKER" ;; *) . "$HERE/tracker/$TRACKER.sh" ;; esac
# shellcheck source=/dev/null
. "$HERE/sandbox/$SANDBOX.sh"
# shellcheck source=/dev/null
. "$HERE/display/$DISPLAY_UI.sh"
# shellcheck source=cell.sh
. "$HERE/cell.sh"

# live event stream read by factory-view.py
ev() { # event [lane] [round] [msg]
  jq -nc --arg ticket "${CID:-}" --arg ev "$1" --arg lane "${2:-}" --argjson round "${3:-0}" --arg msg "${4:-}" \
    '{t:(now|floor),ticket:$ticket,ev:$ev,lane:$lane,round:$round,msg:$msg}' >>"$STATE/events.jsonl"
}

# Ticket comments are off by default (TRACKER_COMMENTS=0): the input is read and thrown away.
ticket_comment() { if [ "$TRACKER_COMMENTS" = 1 ]; then tracker_comment "$1"; else cat >/dev/null; fi; }

fail() { # id reason
  ev fail "" 0 "$2"
  log "FAIL $1: $2"
  touch "$STATE/failed/$1"
  printf 'Factory stopped: %s\nLogs: %s\nTo retry: move the ticket back and run: ff retry %s\n' "$2" "$RUNS/$1" "$1" | ticket_comment "$1" || true
  tracker_status "$1" "$S_BLOCKED" || true
}

# step <name> <title> <cwd> <command> <log>: run one command, isolated by the sandbox and
# shown by the display. The command can use $PROMPT.
step() {
  local name=$1 title=$2 cwd=$3 cmd=$4 out=$5 script="$RUN/steps/$1.sh" e rc
  mkdir -p "$RUN/steps"
  printf '%s' "${PROMPT:-}" >"$script.prompt"
  ( umask 077
    { printf 'rm -f -- "$0"   # holds API keys: gone once bash has it open\n'
      printf 'export PROMPT="$(cat %q)"\n' "$script.prompt"
      for e in ${AGENT_ENV:-} ${CELL_ENV:-}; do [ -n "${!e:-}" ] && printf 'export %s=%q\n' "$e" "${!e}"; done
      sandbox_cmd "$name" "$cwd" "$cmd"
    } >"$script" )
  display_run "$title" "$script" "$out"; rc=$?
  rm -f "$script"   # it may hold API keys
  return $rc
}

# skill_dir <name>: the skill's folder or file. The ticket's repo first, then SKILLS_PATH.
# <set>/<name> (e.g. pstack/tdd) picks the skill from one vendored set on SKILLS_PATH only.
skill_dir() {
  local d f dirs set=${1%/*} base=${1##*/}
  if [ "$set" = "$1" ]; then
    for d in $REPO_SKILL_DIRS; do
      [ -f "$WT/$d/$1/SKILL.md" ] && { echo "$WT/$d/$1"; return 0; }
      [ -f "$WT/$d/$1.md" ] && { echo "$WT/$d/$1.md"; return 0; }
    done
  fi
  IFS=: read -ra dirs <<<"$SKILLS_PATH"
  for d in "${dirs[@]}"; do
    if [ "$set" = "$1" ]; then
      f=$(find -L "$d" -maxdepth 6 -path "*/$1/SKILL.md" 2>/dev/null | sort | head -1)
    else
      f=$(find -L "$d" -maxdepth 6 \( -path "*/$set/$base/SKILL.md" -o -path "*/$set/*/$base/SKILL.md" \) 2>/dev/null | sort | head -1)
    fi
    [ -n "$f" ] && { dirname "$f"; return 0; }
  done
  return 1
}

# A skill name comes from the ticket text too, and becomes a path: allow only name or set/name.
skill_name_ok() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$ ]] && [[ $1 != *..* ]]; }

# agent_skills <name>: skills named in the agent file's header plus the ticket's "Skills:" line
agent_skills() {
  { awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} /^skills:/ {sub(/^skills:[ ]*/, ""); print}' "$HERE/agents/$1.md"
    grep -im1 '^skills:' "$RUN/ticket.md" 2>/dev/null | sed 's/^[Ss]kills:[ ]*//'
  } | tr ', ' '\n\n' | grep -v '^$' | sort -u
}

# skills_prompt <name>: copy the agent's skills into the run folder (the sandbox sees it) and
# print the prompt lines that point the agent at them. A missing skill is logged and skipped.
skills_prompt() {
  local s dir list=""
  for s in $(agent_skills "$1"); do
    skill_name_ok "$s" || { log "$CID skill name '$s' is not a plain name, skipped" >&2; continue; }
    dir=$(skill_dir "$s") || { log "$CID skill $s not found on SKILLS_PATH, skipped" >&2; continue; }
    mkdir -p "$(dirname "$RUN/skills/$s")"; rm -rf "${RUN:?}/skills/$s"
    if [ -f "$dir" ]; then mkdir "$RUN/skills/$s" && cp "$dir" "$RUN/skills/$s/SKILL.md"; else cp -RL "$dir" "$RUN/skills/$s"; fi
    echo "$1: $s <- ${dir#"$WT/"}" >>"$RUN/skills.log"   # which copy each agent got (repo paths are relative)
    list="$list $RUN/skills/$s/SKILL.md"
  done
  [ -n "$list" ] || return 0
  printf '\nSkills: before you start, read and follow these skill files. Paths inside a skill are relative to its folder:%s\n' "$list"
  # Skills are written for interactive sessions; this maps their steps onto a headless factory run.
  printf '%s\n' "If a skill expects a PR number or \$ARGUMENTS, use PR from the Context line. If gh is not available, git diff BASE...HEAD shows the same change. When a skill says to use or publish to the issue tracker, ask the user, grill, or run a setup skill: do not. The ticket is RUN_DIR/ticket.md, the spec is RUN_DIR/spec.md, and you write only the files your agent instructions name. When a skill says to call, run or apply another skill, read RUN_DIR/skills/<name>/SKILL.md or RUN_DIR/skills/pstack/<name>/SKILL.md (principle skills are named principle-<name>) if it is there, otherwise skip it."
}

# agent <name> <cwd> [round]: run agents/<name>.md. router.py picks the CLI and model. If that
# model crashes or times out, it is excluded and the agent retries once on the next model.
agent() {
  local name=$1 cwd=$2 round=${3:-1} out="$RUN/$1-${3:-1}.log" try entry cmd fam rc=1
  export PROMPT
  # The header (between the --- lines) is for the factory only. A prompt must not start with "-",
  # or the agent CLI reads it as an option.
  PROMPT="$(awk 'NR==1 && $0=="---" {h=1; next} h && $0=="---" {h=0; next} !h' "$HERE/agents/$name.md")
$(skills_prompt "$name")

Isolation: you are one of several agents working on different tickets at the same time, each in its own git worktree. Work only in your cwd (this ticket's worktree on branch $BR) and RUN_DIR. Do not read or change other worktrees. Do not use git stash (one stash is shared by every worktree), and do not create, switch, move or delete branches or tags: a git hook refuses it. A server or container you start must use ports PORT_BASE to PORT_BASE+$((CELL_PORT_SPAN - 1)) (PORT_BASE=${PORT_BASE:-}, PORT is set to it) and the compose project in COMPOSE_PROJECT_NAME, and you must stop it before you finish.

Context: RUN_DIR=$RUN TICKET=$CID BASE=origin/$BASE ROUND=$round PR=${PR:-none yet} VERIFY_CMD=${VERIFY_CMD:-<none, use the repo documented checks>}. Do your job now."
  for try in 1 2; do
    IFS=$'\t' read -r entry cmd fam AGENT_AUTH AGENT_ENV < <(python3 "$HERE/router.py" "$name" "$RUN" 2>>"$RUN/route.log") || return 1
    [ -n "$cmd" ] || return 1
    [ "$AGENT_AUTH" = - ] && AGENT_AUTH=; [ "$AGENT_ENV" = - ] && AGENT_ENV=
    ev lane_start "$name" "$round" "$entry"
    step "factory-$CID-$name-$round-$try" "$name${3:+ #$3} · $entry" "$cwd" "$cmd \"\$PROMPT\"" "$out"; rc=$?
    ev lane_end "$name" "$round" "$rc"
    if [ $rc = 0 ]; then
      [ "$name" = code ] && echo "$fam" >"$RUN/build_family.txt"
      return 0
    fi
    echo "$entry" >>"$RUN/excluded.txt"
    log "$CID $name failed on $entry (rc $rc)"
  done
  return $rc
}

# Record this ticket's run: OpenTelemetry trace and/or database row, whichever is configured.
# Never fails the run.
observe() {
  if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    python3 "$HERE/observe/otlp.py" "$CID" "$STATE/events.jsonl" "$RUN" || log "$CID trace export failed"
  fi
  if [ "$DB" = mysql ]; then
    { db_up >/dev/null && python3 "$HERE/observe/db.py" "$CID" "$STATE/events.jsonl" "$RUN" "$WT" "$BASE"; } \
      || log "$CID database sync failed (ff db status)"
  fi
}

# The judge grades the finished run (criteria met, hallucinations, prompt fixes). Best effort:
# a failed judge is logged and the ticket carries on. Prints the score, or nothing.
judge() {
  rm -f "$RUN/judge.json"
  agent judge "$WT" >/dev/null 2>&1 || { log "$CID judge failed, see judge-1.log" >&2; return 0; }
  jq -e '.score' "$RUN/judge.json" >/dev/null 2>&1 || { log "$CID judge wrote no valid judge.json" >&2; return 0; }
  jq -r '"Judge: \(.score)/5. \(.summary)\nCriteria met: \([.criteria[]? | select(.status == "met")] | length)/\(.criteria | length). Hallucinations: \(.hallucinations | length)."' "$RUN/judge.json" >"$RUN/judge.txt"
  gh pr comment "$PR" -F "$RUN/judge.txt" >/dev/null 2>&1 || true
  jq -r .score "$RUN/judge.json"
}

# What ran, what did not, and what changed, for the person who started the run.
summary() { python3 "$HERE/observe/summary.py" "$CID" "$STATE/events.jsonl" "$RUN" "$WT" "$BASE" "$HERE/agents"; }

# worktree_new: a fresh worktree for the ticket's branch, cut from the latest origin/BASE.
# Run under the repo lock (it changes the shared .git).
worktree_new() {
  # An agent's own git fetch in another worktree can hold refs/remotes for a moment: retry.
  local i; for i in 1 2 3; do git -C "$REPO" fetch -q origin "$BASE" && break; [ $i = 3 ] && return 1; sleep 2; done
  git -C "$REPO" worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"; git -C "$REPO" worktree prune
  # an old feature/<ticket> branch blocks feature/<ticket>/<desc> (git refs are paths)
  [ "$BR" != "feature/$CID" ] && git -C "$REPO" branch -q -D "feature/$CID" 2>/dev/null
  git -C "$REPO" worktree add -q --no-track -B "$BR" "$WT" "origin/$BASE"
}

# worktree_attach: check out the ticket's existing branch again (its worktree folder was removed
# by ff gc). Run under the repo lock.
worktree_attach() { git -C "$REPO" worktree prune; rm -rf "$WT"; git -C "$REPO" worktree add -q "$WT" "$BR"; }

# branch_elsewhere: the folder where BR is checked out, if that is not this ticket's worktree.
# Two worktrees on one branch would mix two runs' commits, so the run stops instead.
branch_elsewhere() {
  local w here; here=$(cd "$WT" 2>/dev/null && pwd -P)
  # worktrees on BR whose folder still exists (git marks a deleted one "prunable")
  git -C "$REPO" worktree list --porcelain | awk -v br="branch refs/heads/$BR" 'BEGIN {RS = ""} {
      w = ""; on = 0; gone = 0; n = split($0, l, "\n")
      for (i = 1; i <= n; i++) { if (l[i] ~ /^worktree /) w = substr(l[i], 10); if (l[i] == br) on = 1; if (l[i] ~ /^prunable/) gone = 1 }
      if (on && !gone) print w }' |
    while IFS= read -r w; do [ "$(cd "$w" 2>/dev/null && pwd -P)" = "$here" ] || { echo "$w"; break; }; done
}

# Durable runs: each finished step is written to the ticket's journal. `ff run` skips journaled
# steps and continues where the last run stopped; `ff run --fresh` starts over.
done_step() { grep -qx "$1" "$RUN/journal" 2>/dev/null; }
mark() { echo "$1" >>"$RUN/journal"; }

# The ticket's worktree: kept when resuming, rebuilt from the base branch on a fresh run.
worktree_ready() { # withsetup(1/0)
  local other; other=$(branch_elsewhere)
  [ -z "$other" ] || { log "$CID branch $BR is checked out in $other: remove that worktree first"; return 1; }
  if [ -s "$RUN/journal" ] && [ "$(git -C "$WT" branch --show-current 2>/dev/null)" = "$BR" ]; then
    :   # resume: keep the checkout and its unpushed commits
  elif [ -s "$RUN/journal" ] && git -C "$REPO" show-ref -q "refs/heads/$BR"; then
    repo_locked worktree_attach || return 1
  else
    repo_locked worktree_new || return 1
  fi
  if [ "$1" = 1 ] && ! done_step setup && [ -n "$SETUP_CMD" ]; then
    AGENT_AUTH= AGENT_ENV= PROMPT= step "factory-$CID-setup" setup "$WT" "$SETUP_CMD" "$RUN/setup.log" || return 1
    mark setup
  fi
  return 0
}

# Stop this ticket's agent steps (containers and Herdr tabs). Used on Ctrl-C and before a resume.
stop_steps() {
  local c; c=$(docker ps -q --filter "name=^factory-$CID-" 2>/dev/null)
  [ -n "$c" ] && docker kill $c >/dev/null 2>&1
  display_stop
  rm -f "$RUN"/steps/*.sh   # step scripts of a killed run may hold API keys
  return 0
}

on_branch() { [ "$(git -C "$WT" branch --show-current)" = "$BR" ] || { fail "$ID" "$1 left branch $BR"; return 2; }; }

# Agents that only read (spec writer, planner, reviewer) must not commit: HEAD stays where it was.
read_only() { # label head-before
  [ "$(git -C "$WT" rev-parse HEAD)" = "$2" ] || { fail "$ID" "$1 committed to $BR, but it may only read"; return 2; }
}

# Spec tests are frozen once the test writer commits them: their hashes go to test-files.sha256.
freeze_tests() {
  local f
  git -C "$WT" diff --name-only --diff-filter=d "origin/$BASE...HEAD" >"$RUN/test-files.txt"   # the tests the coder must keep
  while IFS= read -r f; do [ -n "$f" ] && printf '%s %s\n' "$(git -C "$WT" hash-object "$f")" "$f"; done \
    <"$RUN/test-files.txt" >"$RUN/test-files.sha256"
}
# The frozen tests must still exist after the coder and the fixer, and a changed one must be
# named, with the reason, in RUN/test-changes.md (spec-driven guard).
tests_kept() {
  local f h gone="" changed=""
  while IFS= read -r f; do [ -z "$f" ] || [ -e "$WT/$f" ] || gone="$gone $f"; done <"$RUN/test-files.txt"
  [ -z "$gone" ] || { fail "$ID" "$1 deleted tests written from the spec:$gone"; return 2; }
  [ -f "$RUN/test-files.sha256" ] || return 0   # runs started before tests were frozen
  while read -r h f; do
    [ "$(git -C "$WT" hash-object "$f")" = "$h" ] && continue
    grep -qF "$f" "$RUN/test-changes.md" 2>/dev/null || changed="$changed $f"
  done <"$RUN/test-files.sha256"
  [ -z "$changed" ] || { fail "$ID" "$1 changed tests written from the spec without naming them in test-changes.md:$changed"; return 2; }
}

# verify <round>: the orchestrator runs VERIFY_CMD itself, in the ticket's sandbox, and does not
# take an agent's word that it passed. Writes verify-<round>.log. Rounds: 1 = the base branch
# before any change (baseline), 2 = after the coder, 3 = after the coder's retry, 3+N = after fix N.
verify() {
  [ -n "$VERIFY_CMD" ] || return 0
  local rc
  ev lane_start verify "$1" "factory:VERIFY_CMD"
  AGENT_AUTH= AGENT_ENV= PROMPT= step "factory-$CID-verify-$1" "verify #$1" "$WT" "$VERIFY_CMD" "$RUN/verify-$1.log"; rc=$?
  ev lane_end verify "$1" "$rc"
  if [ $rc = 0 ] || ! verify_blocks; then rm -f "$RUN/verify-failed.md"; else
    { printf 'The factory ran VERIFY_CMD (%s) on HEAD %s and it failed (exit %s). Last lines:\n\n```\n' \
        "$VERIFY_CMD" "$(git -C "$WT" rev-parse --short HEAD)" "$rc"
      tail -n 80 "$RUN/verify-$1.log"; printf '```\n'; } >"$RUN/verify-failed.md"
  fi
  return $rc
}
# The base branch already fails VERIFY_CMD: the gate only reports, it cannot block.
verify_blocks() { [ ! -e "$RUN/verify-baseline-red" ]; }

push() { repo_locked git -C "$WT" push -q -u origin "HEAD:refs/heads/$BR" || { fail "$ID" "push rejected (branch exists?)"; return 2; }; }

stage_spec() {
  tracker_status "$ID" "$S_WORKING" || true
  tracker_fetch "$ID" "$RUN" || return 1
  worktree_ready 0 || return 1
  if ! done_step spec; then
    rm -f "$RUN/spec.md"
    local head; head=$(git -C "$WT" rev-parse HEAD)
    agent spec "$WT" || return 1
    read_only "spec writer" "$head" || return 2
    [ -s "$RUN/spec.md" ] || { fail "$ID" "spec writer wrote no spec.md"; return 2; }
    if [ "$(awk 'NF {l=$0} END {sub(/[ \t\r]+$/, "", l); print l}' "$RUN/spec.md")" = "STATUS: NEEDS_INPUT" ]; then
      { echo "Spec needs input before coding:"; echo; cat "$RUN/spec.md"; } | ticket_comment "$ID"
      tracker_status "$ID" "$S_BLOCKED" || true; return 2
    fi
    mark spec
  fi
  if ! done_step plan; then
    rm -f "$RUN/plan.md"
    local head; head=$(git -C "$WT" rev-parse HEAD)
    agent plan "$WT" || return 1
    read_only planner "$head" || return 2
    [ -s "$RUN/plan.md" ] || { fail "$ID" "planner wrote no plan.md"; return 2; }
    mark plan
  fi
  if ! done_step spec-posted; then
    { echo "SPEC"; echo; cat "$RUN/spec.md"; echo; echo "PLAN"; echo; cat "$RUN/plan.md"; } | head -c 30000 | ticket_comment "$ID"
    mark spec-posted
  fi
  if [ "$SPEC_GATE" = 1 ]; then
    tracker_status "$ID" "$S_SPEC_REVIEW" || true
    ev note "" 0 "spec posted, waiting for your approval"; log "$CID spec posted, waiting for approval"; return 2
  fi
  tracker_status "$ID" "$S_APPROVED" || true
}

pr_summary() { # round: write pr-title.txt and pr-body.md
  done_step "pr-summary-$1" && return 0
  rm -f "$RUN/pr-title.txt" "$RUN/pr-body.md"
  agent pr-summary "$WT" "$1" || return 1
  [ -s "$RUN/pr-title.txt" ] && [ -s "$RUN/pr-body.md" ] || { fail "$ID" "PR summary writer wrote no title or body"; return 2; }
  mark "pr-summary-$1"
}

stage_build() {
  tracker_status "$ID" "$S_WORKING" || true
  tracker_fetch "$ID" "$RUN" || return 1
  [ -s "$RUN/spec.md" ] && [ -s "$RUN/plan.md" ] || { fail "$ID" "no spec.md or plan.md in $RUN, run the spec stage first"; return 2; }
  worktree_ready 1 || { fail "$ID" "worktree or setup failed, see setup.log"; return 2; }

  if ! done_step verify-base; then   # baseline: does the base branch pass VERIFY_CMD at all?
    verify 1 || { touch "$RUN/verify-baseline-red"; rm -f "$RUN/verify-failed.md"
      ev note "" 0 "the base branch already fails VERIFY_CMD: the verify gate only reports"
      log "$CID origin/$BASE already fails VERIFY_CMD (verify-1.log): the verify gate will report, not block"; }
    mark verify-base
  fi
  if ! done_step test; then
    agent test "$WT" || return 1
    [ -s "$RUN/tests.md" ] || { fail "$ID" "test writer wrote no tests.md"; return 2; }
    on_branch "test writer" || return 2
    freeze_tests
    mark test
  fi
  if ! done_step code; then
    # A resumed coder may find uncommitted work from the interrupted attempt; it continues from it.
    agent code "$WT" || return 1
    [ -s "$RUN/blocked.md" ] && { fail "$ID" "coder blocked: $(head -c 1500 "$RUN/blocked.md")"; return 2; }
    on_branch coder || return 2
    tests_kept coder || return 2
    [ "$(git -C "$WT" rev-list --count "origin/$BASE..HEAD")" -gt 0 ] || { fail "$ID" "coder made no commits"; return 2; }
    mark code
  fi
  if ! done_step verify-code; then
    # The coder gets one more fresh session with the failure (RUN/verify-failed.md), then the gate holds.
    if ! verify 2 && verify_blocks; then
      agent code "$WT" 2 || return 1
      [ -s "$RUN/blocked.md" ] && { fail "$ID" "coder blocked: $(head -c 1500 "$RUN/blocked.md")"; return 2; }
      on_branch coder || return 2
      tests_kept coder || return 2
      verify 3 || { fail "$ID" "VERIFY_CMD still fails after the coder's second try, see verify-3.log"; return 2; }
    fi
    mark verify-code
  fi
  if [ -f "$HERE/agents/docs.md" ] && ! done_step docs; then
    agent docs "$WT" || return 1
    on_branch "docs writer" || return 2
    mark docs
  fi
  pr_summary 1 || return $?

  if done_step pr; then
    PR=$(cat "$RUN/pr-url")
  else
    push || return 2
    PR=$(gh pr view "$BR" --json url -q .url 2>/dev/null) \
      || PR=$(gh pr create --draft --base "$BASE" --head "$BR" --title "$(cat "$RUN/pr-title.txt")" --body-file "$RUN/pr-body.md") \
      || { fail "$ID" "gh pr create failed"; return 2; }
    if [ -n "$PR_LABEL" ]; then
      gh label create "$PR_LABEL" --color 5319E7 --description "Pull request opened by the software factory" >/dev/null 2>&1 || true
      gh pr edit "$PR" --add-label "$PR_LABEL" >/dev/null || log "$CID could not add label $PR_LABEL"
    fi
    echo "$PR" >"$RUN/pr-url"; mark pr
  fi
  ev pr "" 0 "$PR"; log "$CID PR $PR"

  local r verdict=FIX fixed=0
  for r in $(seq 1 "$MAX_REVIEW_ROUNDS"); do
    if ! done_step "review-$r"; then
      rm -f "$RUN/review-$r.md"
      local head; head=$(git -C "$WT" rev-parse HEAD)
      agent review "$WT" "$r" || return 1
      read_only reviewer "$head" || return 2
      [ -s "$RUN/review-$r.md" ] || { fail "$ID" "reviewer wrote no review-$r.md"; return 2; }
      gh pr comment "$PR" -F "$RUN/review-$r.md" >/dev/null || true
      mark "review-$r"
    fi
    verdict=$(grep -E '^VERDICT: (PASS|FIX)$' "$RUN/review-$r.md" | tail -n1 | sed 's/VERDICT: //')
    ev verdict review "$r" "$verdict"
    [ "$verdict" = PASS ] && break
    [ "$r" = "$MAX_REVIEW_ROUNDS" ] && break
    if ! done_step "fix-$r"; then
      agent fix "$WT" "$r" || return 1
      on_branch fixer || return 2
      tests_kept fixer || return 2
      verify $((3 + r))   # a failure goes to the next reviewer as RUN/verify-failed.md
      push || return 2
      mark "fix-$r"
    fi
    fixed=1
  done

  if [ "$fixed" = 1 ]; then   # the code changed since the first summary
    pr_summary 2 || return $?
    gh pr edit "$PR" --title "$(cat "$RUN/pr-title.txt")" --body-file "$RUN/pr-body.md" >/dev/null || true
  fi
  local score=""
  if ! done_step judge; then score=$(judge); mark judge; else score=$(jq -r '.score // empty' "$RUN/judge.json" 2>/dev/null); fi
  local graded=""; [ -n "$score" ] && graded=" Judge score: $score/5."
  if ! done_step reported; then
    if [ "$verdict" = PASS ]; then
      gh pr ready "$PR" >/dev/null 2>&1 || true
      printf 'PR ready for human review: %s\nAI review passed (no P1/P2).%s\n' "$PR" "$graded" | ticket_comment "$ID"
    else
      printf 'PR (draft): %s\nAI review still has P1/P2 findings after %s rounds. Needs a human. See PR comments.%s\n' "$PR" "$MAX_REVIEW_ROUNDS" "$graded" | ticket_comment "$ID"
    fi
    mark reported
  fi
  tracker_status "$ID" "$S_IN_REVIEW" || true
  mark finished
}

process_task() { # id status [fresh]
  ID=$1; local st; st=$(lc "$2")
  local info; info=$(tracker_info "$ID") || return 1
  IFS=$'\t' read -r CID TITLE <<<"$info"
  RUN="$RUNS/$CID"; WT="$TREES/$CID"; mkdir -p "$RUN"; rm -f "$RUN/excluded.txt"
  [ "${3:-}" = fresh ] && { rm -f "$RUN/branch"; FRESH=1; }
  BR=$(branch_name)

  # One run per ticket at a time.
  local lock="$STATE/lock-$CID"
  take_lock "$lock" || { log "$CID is already running (pid $(cat "$lock/pid")). Stop it first, or wait."; return 1; }
  # The ticket's cell: a slot (its own port range) and the guard hook. See cell.sh.
  take_slot || { rm -rf "$lock"; log "$CID: all $SLOTS cell slots are busy (SLOTS). Try again when a ticket ends."; return 1; }
  cell_enter || { cell_leave; rm -rf "$lock"; log "$CID: could not write the ticket guard hook"; return 1; }
  # Ctrl-C (or a closed terminal): stop the agents, keep everything, leave the ticket as it is.
  trap 'log "$CID stopped. Run ff run $CID to continue where it stopped."; stop_steps
        ev fail "" 0 "stopped by you (ff run $CID continues)"; ev ticket_end "" 0 130; cell_leave; rm -rf "'"$lock"'"; exit 130' INT TERM HUP
  run_ticket "$st" "${3:-}"; local rc=$?
  trap - INT TERM HUP; cell_leave; rm -rf "$lock"
  return $rc
}

run_ticket() { # status fresh
  local st=$1

  # A finished run, or --fresh, starts over; anything else continues from the journal.
  if [ "$2" = fresh ] || done_step finished; then
    rm -f "$RUN"/journal "$RUN"/spec.md "$RUN"/plan.md "$RUN"/tests.md "$RUN"/test-files.txt "$RUN"/test-changes.md \
          "$RUN"/blocked.md "$RUN"/docs.md "$RUN"/review-*.md "$RUN"/fix-notes.md "$RUN"/pr-url "$RUN"/pr-title.txt \
          "$RUN"/pr-body.md "$RUN"/judge.json "$RUN"/judge.txt "$RUN"/build_family.txt "$RUN"/test-files.sha256 \
          "$RUN"/verify-*.log "$RUN"/verify-failed.md "$RUN"/verify-baseline-red "$RUN"/guard.log
  fi
  if [ -s "$RUN/journal" ]; then
    ev ticket_resume "" 0 "$TITLE"; log "$CID continues after: $(tr '\n' ' ' <"$RUN/journal")"
  else
    ev ticket_start "" 0 "$TITLE"; log "$CID start (status: $st)"
  fi
  # A local setup problem shows in the live graph, but does not touch the ticket.
  local why; why=$(sandbox_check 2>&1) || { echo "$why"; ev fail "" 0 "setup: ${why#* * }"; ev ticket_end "" 0 1; return 1; }
  [ -n "${DISPLAY_STARTED:-}" ] || { display_start; DISPLAY_STARTED=1; }
  display_ticket_start "$CID"
  stop_steps   # leftovers from a run that was stopped
  local rc=0
  if [ "$st" = "$(lc "$S_TODO")" ]; then
    stage_spec; rc=$?
    [ $rc = 0 ] && [ "$SPEC_GATE" != 1 ] && { stage_build; rc=$?; }
  elif [ "$st" = "$(lc "$S_APPROVED")" ]; then
    stage_build; rc=$?
  else
    log "$CID status '$st' has no stage"; return 0
  fi
  [ $rc = 1 ] && fail "$ID" "an agent crashed or timed out, or the tracker or git failed, see logs in $RUN"
  ev ticket_end "" 0 "$rc"; log "$CID done"
  observe
  summary >"$RUN/summary.txt" 2>&1; printf '\n%s\n' "$(cat "$RUN/summary.txt")"
  display_ticket_end "$CID"
}

# poll [--now | --enqueue]: take assigned tickets from the tracker and run them one after the
# other. --enqueue (the daemon) puts them in the queue instead, where the daemon runs up to
# MAX_PARALLEL at once. A ticket that is failed, running or already queued is skipped.
poll() {
  if [ "${AUTO_PICKUP:-0}" != 1 ] && [ "${1:-}" != --now ]; then
    log "auto pickup is off (AUTO_PICKUP=0). Use: ff poll --now, or ff run <ticket>"; return 0
  fi
  mkdir "$STATE/poll.lock" 2>/dev/null || {
    kill -0 "$(cat "$STATE/poll.lock/pid" 2>/dev/null)" 2>/dev/null && { log "poll already running"; return 0; }
    rm -rf "$STATE/poll.lock"; mkdir "$STATE/poll.lock"; }
  echo $$ >"$STATE/poll.lock/pid"; trap 'rm -rf "$STATE/poll.lock"' EXIT
  local tasks n=0 id st
  CID= ev poll
  tasks=$(tracker_list) || { log "tracker fetch failed"; return 1; }
  while IFS=$'\t' read -r id st; do
    [ -n "$id" ] && [ ! -e "$STATE/failed/$id" ] || continue
    [ "$n" -ge "$MAX_PER_RUN" ] && break
    if [ "${1:-}" = --enqueue ]; then
      grep -qsx -- "$id" "$STATE"/queue/* "$STATE"/queue/running/* && continue
      echo "$id" >"$STATE/queue/$(date +%s)-$$-$n"; log "queued $id ($st)"
    else
      process_task "$id" "$st"
    fi
    n=$((n+1))
  done <<<"$tasks"
  [ "$n" = 0 ] && log "nothing to do"
  return 0
}

# queued: how many tickets wait in the queue (queue/running is a folder, not an entry)
queued() { local f n=0; for f in "$STATE"/queue/*; do [ -f "$f" ] && n=$((n + 1)); done; echo "$n"; }

# take_lock <dir>: a pid lock. A lock whose process is gone (or is this process: pids repeat
# after a container restart) is stale and taken over. Fails if another live process holds it.
# Parallel runs race for the same locks (cell slots), so a lock without a pid yet is being taken
# (wait for its pid), and a stale lock is broken only while holding <dir>.break, after checking
# again that it is stale: two processes can never both take it over.
lock_pid() { local i p; for i in 1 2 3 4 5 6 7 8 9 10; do p=$(cat "$1/pid" 2>/dev/null); [ -n "$p" ] && break; [ -d "$1" ] || break; sleep 0.2; done; echo "$p"; }
lock_live() { local p; p=$(lock_pid "$1"); [ -n "$p" ] && [ "$p" != $$ ] && kill -0 "$p" 2>/dev/null; }
take_lock() {
  local rc
  mkdir "$1" 2>/dev/null && { echo $$ >"$1/pid"; return 0; }
  lock_live "$1" && return 1
  if ! mkdir "$1.break" 2>/dev/null; then   # another process is breaking it. A .break left by a crash expires after a minute
    [ -n "$(find "$1.break" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rm -rf "$1.break"
    return 1
  fi
  if lock_live "$1"; then rc=1; else rm -rf "$1"; mkdir "$1" 2>/dev/null && echo $$ >"$1/pid"; rc=$?; fi
  rmdir "$1.break"
  return $rc
}

# Long-running mode for a server: run tickets dropped in the queue, and poll if AUTO_PICKUP=1.
# Up to MAX_PARALLEL tickets run at once, each its own `factory.sh run` process in its own
# worktree and cell (cell.sh). One daemon per data folder. A queued ticket is claimed (moved to
# queue/running) and removed when its run ends, so a restart in the middle runs it again, and
# the journal resumes it.
# daemon --once: run everything queued, wait for it to finish, and exit (cron, tests).
daemon() {
  local last=0 lastgc=0 f k still kids="" lock="$STATE/daemon.lock"
  take_lock "$lock" || { log "a daemon is already running (pid $(cat "$lock/pid"))"; return 1; }
  doctor || { rm -rf "$lock"; log "daemon not started: fix the FAIL lines above (ff doctor)"; return 1; }
  # Locks left by runs that died with the last daemon (a container restart): those runs are gone.
  for f in "$STATE"/lock-*; do [ -d "$f" ] || continue
    { kill -0 "$(cat "$f/pid" 2>/dev/null)" 2>/dev/null && [ "$(cat "$f/pid")" != $$ ]; } || rm -rf "$f"; done
  mkdir -p "$STATE/queue/running"
  for f in "$STATE"/queue/running/*; do [ -f "$f" ] && mv "$f" "$STATE/queue/"; done
  # docker stop: stop the tickets' runs (they kill their agent containers), keep their claims for the restart.
  # kids: "<pid>:<claim file name>" of every running ticket
  trap 'log "daemon stopping"; for k in $kids; do kill -TERM "${k%%:*}" 2>/dev/null; done
        for k in $kids; do wait "${k%%:*}"; done; rm -rf "'"$lock"'"; exit 143' INT TERM
  log "daemon up (queue every 10s, up to $MAX_PARALLEL tickets at once, auto pickup: ${AUTO_PICKUP:-0}, daily gc of items idle ${GC_DAYS} days)"
  while :; do
    still=""   # a finished run drops its claim
    for k in $kids; do
      if kill -0 "${k%%:*}" 2>/dev/null; then still="$still $k"; else wait "${k%%:*}"; rm -f "$STATE/queue/running/${k#*:}"; fi
    done
    kids=$still
    for f in "$STATE"/queue/*; do
      [ "$(wc -w <<<"$kids")" -lt "$MAX_PARALLEL" ] || break
      [ -f "$f" ] && mv "$f" "$STATE/queue/running/" || continue
      log "queue: $(cat "$STATE/queue/running/${f##*/}")"
      "$HERE/factory.sh" run "$(cat "$STATE/queue/running/${f##*/}")" & kids="$kids $!:${f##*/}"
    done
    if [ "${AUTO_PICKUP:-0}" = 1 ] && [ $(( $(date +%s) - last )) -ge "${POLL_INTERVAL:-3600}" ]; then
      "$HERE/factory.sh" poll --enqueue; last=$(date +%s)
    fi
    if [ $(( $(date +%s) - lastgc )) -ge 86400 ]; then gc >/dev/null; lastgc=$(date +%s); fi
    if [ "${1:-}" = --once ]; then
      [ -z "$kids" ] && [ "$(queued)" = 0 ] && break
      sleep 1 & wait $!
    else
      sleep 10 & wait $!   # wait, not sleep: a TERM is handled at once
    fi
  done
  rm -rf "$lock"
}

# health: exit 0 when the daemon is up and can start agents (docker compose healthcheck).
health() {
  kill -0 "$(cat "$STATE/daemon.lock/pid" 2>/dev/null)" 2>/dev/null || { echo "daemon not running"; return 1; }
  [ "$SANDBOX" != docker ] || docker info >/dev/null 2>&1 || { echo "Docker not reachable"; return 1; }
  echo ok
}

# doctor: check everything a run needs, before a run needs it. Exit 1 on any FAIL.
doctor() {
  local bad=0 c why free
  ok()   { printf '  ok    %s\n' "$*"; }
  no()   { printf '  FAIL  %s\n' "$*"; bad=1; }
  warn() { printf '  warn  %s\n' "$*"; }
  for c in git gh jq curl python3 perl; do command -v "$c" >/dev/null && ok "$c" || no "$c not installed"; done
  if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then ok "REPO $REPO"
    git -C "$REPO" ls-remote -q --exit-code origin "refs/heads/$BASE" >/dev/null 2>&1 \
      && ok "origin has branch $BASE" || no "origin has no branch $BASE (BASE), or origin is unreachable"
  else no "REPO $REPO is not a git repository"; fi
  # the ticket guard needs reference-transaction hooks and rev-parse --path-format (git 2.31)
  git version | awk '{split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && v[2] >= 31))}' \
    && ok "$(git version) (ticket guard hooks)" || no "$(git version): the ticket guard needs git 2.31 or newer"
  [ "$MAX_PARALLEL" -le "$SLOTS" ] && ok "up to $MAX_PARALLEL ticket(s) at once, $SLOTS cell slots" \
    || no "MAX_PARALLEL=$MAX_PARALLEL is more than SLOTS=$SLOTS"
  gh auth status >/dev/null 2>&1 && ok "gh logged in" || no "gh not logged in (gh auth login, or GH_TOKEN)"
  tracker_whoami >/dev/null 2>&1 && ok "tracker $TRACKER reachable" || no "tracker $TRACKER: login or network failed (check its token in $CONFIG)"
  why=$(sandbox_check 2>&1) && ok "sandbox $SANDBOX" || no "sandbox $SANDBOX: $why"
  [ "$SANDBOX" = none ] && warn "SANDBOX=none: agents run unconfined on this machine"
  why=$(python3 "$HERE/router.py" status 2>&1)
  grep -q ' ready$' <<<"$why" && ok "agent CLIs ready: $(awk '$NF == "ready" {print $1}' <<<"$why" | xargs)" \
    || no "no agent CLI is installed and logged in (ff login)"
  if [ -f "$CONFIG" ] && [ "$(ls -l "$CONFIG" | cut -c5-10)" != "------" ]; then
    warn "$CONFIG holds secrets but others can read it (chmod 600 $CONFIG)"; fi
  free=$(df -Pk "$DATA_DIR" | awk 'NR == 2 {print int($4 / 1048576)}')
  [ "$free" -ge 5 ] && ok "disk: ${free}G free in $DATA_DIR" || warn "disk: only ${free}G free in $DATA_DIR (ff gc frees worktrees)"
  return $bad
}

# gc [days]: free disk. A worktree is removed when its PR is merged or closed (a merged PR's
# local branch goes too), or when it has been idle for N days (no run activity): then its branch
# and run folder stay, so ff run can rebuild it. Uncommitted changes in it are lost. Log lines of
# tickets idle for N days leave events.jsonl, and routing decisions older than N days leave
# decisions.jsonl (the quota meter only needs 5 hours). Agents run with git's auto gc off, so
# git gc --auto runs here, under the repo lock.
worktree_drop() { git -C "$REPO" worktree remove --force "$1" 2>/dev/null; rm -rf "$1"; }
gc() {
  local days=${1:-$GC_DAYS} d cid pr why n=0
  [[ $days =~ ^[0-9]+$ ]] || { echo "usage: ff gc [days]" >&2; return 1; }
  for d in "$TREES"/*/; do
    [ -d "$d" ] || continue; d=${d%/}; cid=$(basename "$d")
    kill -0 "$(cat "$STATE/lock-$cid/pid" 2>/dev/null)" 2>/dev/null && continue   # running now
    pr=""; [ -s "$RUNS/$cid/pr-url" ] && pr=$(gh pr view "$(cat "$RUNS/$cid/pr-url")" --json state -q .state 2>/dev/null)
    case "$pr" in
      MERGED|CLOSED) why="PR $(lc "$pr")" ;;
      *) [ -n "$(find "$RUNS/$cid" "$d" -maxdepth 1 -mtime "-$days" 2>/dev/null | head -1)" ] && continue
         why="idle more than $days days" ;;
    esac
    repo_locked worktree_drop "$d"; n=$((n+1))
    if [ "$pr" = MERGED ] && [ -s "$RUNS/$cid/branch" ]; then
      repo_locked git -C "$REPO" branch -q -D "$(cat "$RUNS/$cid/branch")" 2>/dev/null && why="$why, local branch deleted"
    fi
    echo "removed worktree $cid ($why)"
  done
  repo_locked git -C "$REPO" worktree prune 2>/dev/null
  repo_locked git -C "$REPO" gc --auto --quiet 2>/dev/null
  python3 "$HERE/observe/prune.py" "$days" "$STATE/events.jsonl" "$STATE/decisions.jsonl"
  echo "gc: $n worktree(s) removed"
}

# set_config KEY VALUE: write one setting into the config file (mode 600) and the environment.
set_config() {
  ( umask 077; touch "$CONFIG"; grep -v "^$1=" "$CONFIG" >"$CONFIG.tmp"; printf '%s=%q\n' "$1" "$2" >>"$CONFIG.tmp" ) \
    && mv "$CONFIG.tmp" "$CONFIG" && chmod 600 "$CONFIG"
  export "$1=$2"
}

# db_up: start the dashboard MySQL container (create it on first use) and create the tables.
db_up() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; return 1; }
  docker network inspect "$DB_NETWORK" >/dev/null 2>&1 || docker network create "$DB_NETWORK" >/dev/null
  if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    [ -n "$DB_PASSWORD" ] || set_config DB_PASSWORD "$(openssl rand -hex 16)"
    echo "creating MySQL container $DB_CONTAINER (data in volume $DB_VOLUME, port 127.0.0.1:$DB_PORT)"
    docker run -d --name "$DB_CONTAINER" --restart unless-stopped --network "$DB_NETWORK" \
      -e MYSQL_RANDOM_ROOT_PASSWORD=yes -e MYSQL_DATABASE=factory -e MYSQL_USER=factory -e MYSQL_PASSWORD="$DB_PASSWORD" \
      -v "$DB_VOLUME:/var/lib/mysql" -p "127.0.0.1:$DB_PORT:3306" "$DB_IMAGE" >/dev/null || return 1
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER")" = true ] || docker start "$DB_CONTAINER" >/dev/null
  for _ in $(seq 1 90); do   # a new container initialises, restarts once, then accepts logins
    docker exec -e MYSQL_PWD="$DB_PASSWORD" "$DB_CONTAINER" mysql -ufactory factory -e 'select 1' >/dev/null 2>&1 && break
    sleep 2
  done
  python3 "$HERE/observe/db.py" --schema
}

db() {
  case "${1:-status}" in
    up)     db_up && echo "MySQL ready: 127.0.0.1:$DB_PORT, database factory, user factory (password: DB_PASSWORD in $CONFIG)"
            [ "$DB" = mysql ] || { set_config DB mysql; echo "DB=mysql saved: every run is now stored"; } ;;
    down)   docker stop "$DB_CONTAINER" "$DB_CONTAINER-ui" >/dev/null 2>&1; echo "stopped (data kept in volume $DB_VOLUME)" ;;
    status) docker ps -a --filter "name=^$DB_CONTAINER" --format '{{.Names}}: {{.Status}}'
            [ "$DB" = mysql ] && echo "syncing runs: on" || echo "syncing runs: off (ff db up turns it on)" ;;
    ui)     db_up >/dev/null || return 1
            docker inspect "$DB_CONTAINER-ui" >/dev/null 2>&1 || docker run -d --name "$DB_CONTAINER-ui" --restart unless-stopped \
              --network "$DB_NETWORK" -e ADMINER_DEFAULT_SERVER="$DB_CONTAINER" -p "127.0.0.1:$DB_UI_PORT:8080" adminer >/dev/null
            docker start "$DB_CONTAINER-ui" >/dev/null
            echo "Dashboard: http://localhost:$DB_UI_PORT  (System MySQL, server $DB_CONTAINER, user factory, database factory, password: DB_PASSWORD in $CONFIG)"
            echo "Start with the views: v_runs, v_criteria, v_hallucinations, v_prompt_suggestions, v_agent_stats" ;;
    sql)    shift; docker exec -i -e MYSQL_PWD="$DB_PASSWORD" "$DB_CONTAINER" mysql --default-character-set=utf8mb4 -ufactory factory ${1:+-e "$*"} ;;
    *)      echo "usage: ff db up | down | status | ui | sql [query]" >&2; return 1 ;;
  esac
}

# login [KEY_NAME]: show which agent CLIs can run; with a key name, store its value in the
# config file first (the one env file for settings and secrets, kept at mode 600).
login() {
  if [ -n "${1:-}" ]; then
    [[ $1 =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "key names look like ANTHROPIC_API_KEY" >&2; return 1; }
    local value; read -rsp "Value for $1 (hidden): " value; echo
    set_config "$1" "$value"; echo "saved $1 in $CONFIG"
  fi
  python3 "$HERE/router.py" status
  echo "  keys you can set: $(jq -r '[.clis[].env[]] | unique | join(" ")' "${ROUTER_CONFIG:-$HERE/router.json}")  (ff login <KEY>)"
}

schedule() { # seconds
  local plist="$HOME/Library/LaunchAgents/com.factory.poll.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.factory.poll</string>
<key>ProgramArguments</key><array><string>$HERE/factory.sh</string><string>poll</string></array>
<key>StartInterval</key><integer>${1:-3600}</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
<key>StandardOutPath</key><string>$STATE/poll.log</string>
<key>StandardErrorPath</key><string>$STATE/poll.log</string>
</dict></plist>
EOF
  launchctl unload "$plist" 2>/dev/null; launchctl load "$plist" && echo "scheduled every ${1:-3600}s, log: $STATE/poll.log"
}

case "${1:-}" in
  whoami)  tracker_whoami ;;
  view)    exec python3 "$HERE/factory-view.py" ;;
  login)   login "${2:-}" ;;
  poll)    poll "${2:-}" ;;   # --now: run them here, one by one. --enqueue: hand them to the daemon
  daemon)  daemon "${2:-}" ;;
  doctor)  doctor ;;
  health)  health ;;
  gc)      gc "${2:-}" ;;
  route)   # route <ticket> [--set agent=cli:model ...] [--clear]: which CLI and model each agent gets.
           # --set saves a per-ticket override that the next `ff run` uses; --clear removes them.
           tid=$(tracker_resolve "${2:?ticket}") && IFS=$'\t' read -r CID TITLE < <(tracker_info "$tid")
           RUN="$RUNS/$CID"; mkdir -p "$RUN"; tracker_fetch "$tid" "$RUN"; export ROUTER_DRY=1   # a dry run is not a real call
           [ -f "$RUN/overrides.json" ] || echo '{}' >"$RUN/overrides.json"
           shift 2
           while [ $# -gt 0 ]; do
             case "$1" in
               --clear) echo '{}' >"$RUN/overrides.json"; echo "overrides cleared" ;;
               --set) ;;
               *=*) a=${1%%=*}; [ -f "$HERE/agents/$a.md" ] || { echo "no agent named $a (see agents/)" >&2; exit 1; }
                    jq --arg a "$a" --arg e "${1#*=}" '.[$a] = $e' "$RUN/overrides.json" >"$RUN/overrides.tmp" && mv "$RUN/overrides.tmp" "$RUN/overrides.json" ;;
               *) echo "usage: ff route <ticket> [--set agent=cli:model ...] [--clear]" >&2; exit 1 ;;
             esac
             shift
           done
           for f in "$HERE"/agents/*.md; do
             a=$(basename "$f" .md); [ "$a" = README ] && continue
             pick=$(python3 "$HERE/router.py" "$a" "$RUN" 2>/dev/null | cut -f1)
             mark=""; [ "$(jq -r --arg a "$a" '.[$a] // empty' "$RUN/overrides.json")" = "$pick" ] && mark="  (you)"
             printf '%-11s %s%s\n' "$a" "${pick:-<no usable model, see: python3 router.py $a $RUN>}" "$mark"
           done
           if [ -f "$RUN/jev.json" ]; then
             jq -r '.answers | "Jev: complexity \(.complexity.score // "?") (confidence \(.complexity.confidence // "?")), risk \(.consequence.noul // "?")"' "$RUN/jev.json"
             echo "     Hard or risky tickets start further down each chain (not for pinned agents: $(jq -r '.pinned | join(", ")' "${ROUTER_CONFIG:-$HERE/router.json}"))."
           fi
           echo "Change one pick: ff route $CID --set code=claude:claude-opus-5-5   Undo: ff route $CID --clear" ;;
  enqueue) [ -n "${2:-}" ] || { echo "usage: ff enqueue <ticket>"; exit 1; }
           echo "$2" >"$STATE/queue/$(date +%s)-$$"; echo "queued $2 (the daemon runs it within 10s)" ;;
  run)     [ -n "${2:-}" ] || { echo "usage: ff run <CHP-1234 | task id | url> [--fresh]"; exit 1; }
           # manual run = full pipeline, no spec gate, whatever the ticket status
           tid=$(tracker_resolve "$2") && [ -n "$tid" ] && [ "$tid" != null ] || { echo "ticket not found: $2" >&2; exit 1; }
           SPEC_GATE=0; rm -f "$STATE/failed/$tid"; process_task "$tid" "$S_TODO" "$([ "${3:-}" = --fresh ] && echo fresh)" ;;
  summary) # summary <ticket key>: the end-of-run report again
           CID=${2:?ticket key, e.g. CHP-1234}; RUN="$RUNS/$CID"; WT="$TREES/$CID"; summary ;;
  sync)    # sync <ticket key>: store the latest run in the database again
           CID=${2:?ticket key, e.g. CHP-1234}; RUN="$RUNS/$CID"; WT="$TREES/$CID"
           db_up >/dev/null && python3 "$HERE/observe/db.py" "$CID" "$STATE/events.jsonl" "$RUN" "$WT" "$BASE" ;;
  db)      shift; db "$@" ;;
  trace)   # trace <ticket key>: what each agent did in the latest run (add --send to export it again)
           CID=${2:?ticket key, e.g. CHP-1234}; RUN="$RUNS/$CID"
           if [ "${3:-}" = --send ]; then observe; else python3 "$HERE/observe/otlp.py" "$CID" "$STATE/events.jsonl" "$RUN" --summary; fi ;;
  retry)   rm -f "$STATE/failed/${2:?task id}"; echo "cleared" ;;
  status)  echo "running (ticket, pid, cell slot, ports):"
           for f in "$STATE"/lock-*; do
             [ -d "$f" ] && kill -0 "$(cat "$f/pid" 2>/dev/null)" 2>/dev/null || continue
             p=$(cat "$f/pid"); s=$(grep -lx "$p" "$STATE"/slot-*/pid 2>/dev/null | head -1 | sed -E 's|.*/slot-([0-9]+)/pid|\1|')
             printf '  %-12s pid %-7s slot %-2s ports %s\n' "${f##*/lock-}" "$p" "${s:--}" "${s:+$((CELL_PORT_START + s * CELL_PORT_SPAN))-$((CELL_PORT_START + (s + 1) * CELL_PORT_SPAN - 1))}"
           done
           echo "queued: $(queued)"
           echo "failed:"; ls "$STATE/failed"; echo "runs:"; ls -t "$RUNS" | head ;;
  schedule) schedule "${2:-3600}" ;;
  unschedule) launchctl unload "$HOME/Library/LaunchAgents/com.factory.poll.plist" && echo off ;;
  *) echo "usage: ff whoami | login [KEY] | view | run <ticket> [--fresh] | route <ticket> [--set agent=cli:model] [--clear] | trace <key> [--send] | summary <key> | sync <key> | db up|down|status|ui|sql | poll [--now] | enqueue <ticket> | daemon [--once] | doctor | health | gc [days] | retry <id> | status | schedule [secs] | unschedule" ;;
esac

# shellcheck shell=bash
# Cursor Cloud handoff: `ff cloud <ticket>` sends the code + self-review step to a Cursor Cloud
# Agent instead of a local container. Cursor works on the ticket branch and pushes to it; the
# factory waits, pulls, checks the spec tests are still there, and opens a draft PR itself
# (the Cursor API cannot open draft PRs). API: https://cursor.com/docs/cloud-agent/api/endpoints
: "${CURSOR_API:=https://api.cursor.com/v1}" "${CURSOR_CLOUD_MODEL:=composer-2.5}"
: "${CURSOR_CLOUD_TIMEOUT:=7200}" "${CURSOR_CLOUD_POLL:=30}"

cursor_api() { # method path [json body]
  curl -sS --fail-with-body --connect-timeout 10 --max-time 120 -X "$1" "$CURSOR_API$2" -u "$CURSOR_API_KEY:" \
    -H 'Content-Type: application/json' ${3:+--data-binary "$3"}
}

# The prompt carries the run folder inline: the cloud VM cannot see this machine.
cursor_prompt() {
  local f
  # No committed spec tests yet (the local test writer was skipped or died): Cursor writes them first.
  done_step test || cat <<EOF
No tests exist yet for this ticket. Before any code: write failing tests for every acceptance
criterion in spec.md, following plan.md and the repo's test conventions, and commit them alone as
"$CID test: AC-1 to AC-n (red)". Then do the coder job below against those tests. Never delete them later.

EOF
  awk 'NR==1 && $0=="---" {h=1; next} h && $0=="---" {h=0; next} !h' "$HERE/agents/code.md" |
    sed -e 's/Never push\./Push your commits to the current branch when done./' -e 's#RUN_DIR/##g'
  cat <<EOF

You run as a Cursor Cloud Agent for ticket $CID on branch $BR (base origin/$BASE).
The run folder is not on this machine; its files are inlined below. There is no RUN_DIR: put
test-changes.md or blocked.md content in your final reply instead of a file.
Verify command: ${VERIFY_CMD:-<none, use the repo documented checks>}.
The branch may hold uncommitted work from an earlier attempt, committed as "wip: handoff". Continue from it.

After the tests pass, review your own diff (git diff origin/$BASE...HEAD) against every acceptance
criterion in spec.md. Mark each AC met or not met, fix anything not met or any P1/P2 bug you find,
then push. End your reply with the AC checklist and a final line: VERDICT: PASS or VERDICT: FIX.
EOF
  for f in ticket comments spec plan tests; do
    [ -s "$RUN/$f.md" ] && printf '\n===== %s.md =====\n%s\n' "$f" "$(cat "$RUN/$f.md")"
  done
}

cursor_start() { # -> writes $RUN/cursor-agent.json
  local body
  body=$(jq -n --arg text "$(cursor_prompt)" --arg model "$CURSOR_CLOUD_MODEL" --arg repo "$CURSOR_REPO_URL" \
    --arg ref "$BR" --arg name "$CID code" \
    '{name:$name, prompt:{text:$text}, model:{id:$model}, repos:[{url:$repo, startingRef:$ref}],
      workOnCurrentBranch:true, autoCreatePR:false, mode:"agent"}')
  cursor_api POST /agents "$body" >"$RUN/cursor-agent.json" || { cat "$RUN/cursor-agent.json" >&2; rm -f "$RUN/cursor-agent.json"; return 1; }
}

# Wait until the run ends. Prints the final status; the run JSON is in $RUN/cursor-run.json.
cursor_wait() {
  local agent run st="" end=$(( $(date +%s) + CURSOR_CLOUD_TIMEOUT ))
  agent=$(jq -r .agent.id "$RUN/cursor-agent.json"); run=$(jq -r .run.id "$RUN/cursor-agent.json")
  while [ "$(date +%s)" -lt "$end" ]; do
    cursor_api GET "/agents/$agent/runs/$run" >"$RUN/cursor-run.json" 2>/dev/null \
      && st=$(jq -r .status "$RUN/cursor-run.json")
    case "$st" in FINISHED|ERROR|CANCELLED|EXPIRED) echo "$st"; return 0 ;; esac
    sleep "$CURSOR_CLOUD_POLL"
  done
  echo TIMEOUT
}

cursor_models() { cursor_api GET /models | jq -r '.items[].id' | sort -f; }

# Pick the model: --model wins, else a numbered list in a terminal (Enter keeps the default).
cursor_pick_model() {
  local list n i pick
  [ -t 0 ] || return 0
  list=$(cursor_models) || { echo "could not list Cursor models, using $CURSOR_CLOUD_MODEL" >&2; return 0; }
  n=$(wc -l <<<"$list" | tr -d ' ')
  awk '{printf "  %2d) %s\n", NR, $1}' <<<"$list" >&2
  read -rp "Cloud model [number or id, Enter = $CURSOR_CLOUD_MODEL]: " pick
  [ -z "$pick" ] && return 0
  if [[ $pick =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "$n" ]; then
    CURSOR_CLOUD_MODEL=$(sed -n "${pick}p" <<<"$list")
  elif i=$(grep -xF "$pick" <<<"$list"); then CURSOR_CLOUD_MODEL=$i
  else echo "unknown model: $pick" >&2; return 1
  fi
}

# cfail <reason>: stop this cloud run; the reason shows in the terminal and in the live graph.
cfail() { echo "$CID: $*" >&2; ev fail "" 0 "$*"; return 1; }

cloud_ticket() { # ticket ref [--model ID]
  [ -n "${CURSOR_API_KEY:-}" ] && [ -n "${CURSOR_REPO_URL:-}" ] || { echo "set CURSOR_API_KEY and CURSOR_REPO_URL (ff login KEY)" >&2; return 1; }
  [ "$1" = --models ] && { cursor_models; return; }
  local ref=$1 model=""; shift
  while [ $# -gt 0 ]; do
    case "$1" in --model) model=${2:?--model needs an id (ff cloud --models)}; shift 2 ;; --model=*) model=${1#*=}; shift ;;
      *) echo "usage: ff cloud <ticket> [--model ID] | ff cloud --models" >&2; return 1 ;; esac
  done
  ID=$(tracker_resolve "$ref") && [ -n "$ID" ] && [ "$ID" != null ] || { echo "ticket not found: $ref" >&2; return 1; }
  IFS=$'\t' read -r CID TITLE < <(tracker_info "$ID")
  RUN="$RUNS/$CID"; WT="$TREES/$CID"; BR=$(branch_name)
  # Same lock as ff run: one run per ticket, and the live graph sees this run as alive.
  local lock="$STATE/lock-$CID" rc
  if ! mkdir "$lock" 2>/dev/null; then
    kill -0 "$(cat "$lock/pid" 2>/dev/null)" 2>/dev/null && { echo "$CID is already running (pid $(cat "$lock/pid"))" >&2; return 1; }
    rm -rf "$lock"; mkdir "$lock"
  fi
  echo $$ >"$lock/pid"
  trap 'log "$CID stopped here; the Cursor agent keeps running. ff cloud $CID waits for it again."
        ev fail "" 0 "stopped by you (Cursor keeps running, ff cloud $CID waits again)"; ev ticket_end "" 0 130; rm -rf "'"$lock"'"; exit 130' INT TERM HUP
  ev ticket_resume "" 0 "$TITLE"
  cloud_run "$model"; rc=$?
  ev ticket_end "" 0 "$rc"
  trap - INT TERM HUP; rm -rf "$lock"
  return $rc
}

cloud_run() { # model ("" = ask)
  local model=$1
  mkdir -p "$RUN"
  tracker_fetch "$ID" "$RUN" || cfail "could not fetch the ticket" || return 1
  # An existing spec or plan is used as is; a missing one is written here by the local agents (light steps).
  [ -s "$RUN/spec.md" ] && ! done_step spec && mark spec
  [ -s "$RUN/plan.md" ] && ! done_step plan && mark plan
  if ! done_step spec || ! done_step plan; then
    local why; why=$(sandbox_check 2>&1) || cfail "setup: $why" || return 1
    display_start; display_ticket_start "$CID"
    SPEC_GATE=0 stage_spec || cfail "spec or plan not written, see $RUN" || return 1
  fi
  worktree_ready 0 || cfail "worktree for $BR failed" || return 1
  [ "$(git -C "$WT" branch --show-current 2>/dev/null)" = "$BR" ] || cfail "$WT is not on $BR" || return 1

  local status agent_url last
  last=$(jq -r '.status // empty' "$RUN/cursor-run.json" 2>/dev/null)
  # A saved agent whose run has not ended is waited on again, not started twice.
  if done_step cloud; then
    log "$CID Cursor already finished, opening the PR"
  elif [ -s "$RUN/cursor-agent.json" ] && ! [[ $last =~ ^(ERROR|CANCELLED|EXPIRED)$ ]]; then
    log "$CID waiting on the Cursor agent started earlier"
  else
    if [ -n "$(git -C "$WT" status --porcelain)" ]; then   # Cursor only sees what is pushed
      git -C "$WT" add -A && git -C "$WT" commit -q --no-verify -m "$CID wip: handoff to Cursor Cloud" || cfail "WIP commit failed" || return 1
    fi
    # --no-verify: repo pre-push hooks run checks on half-done WIP, with sandbox (Linux) node_modules
    git -C "$WT" push -q --no-verify -u origin "HEAD:refs/heads/$BR" || cfail "push of $BR failed" || return 1
    if [ -n "$model" ]; then CURSOR_CLOUD_MODEL=$model; else cursor_pick_model || cfail "no model picked" || return 1; fi
    log "$CID Cursor model: $CURSOR_CLOUD_MODEL"
    rm -f "$RUN/cursor-run.json"
    cursor_start || cfail "Cursor API refused the agent, see the terminal" || return 1
    echo "$CURSOR_CLOUD_MODEL" >"$RUN/cursor-model"
    ev lane_start code 1 "cursor-cloud:$CURSOR_CLOUD_MODEL"
  fi
  agent_url=$(jq -r .agent.url "$RUN/cursor-agent.json")
  [ -s "$RUN/cursor-model" ] && CURSOR_CLOUD_MODEL=$(cat "$RUN/cursor-model")
  ev cloud "" 0 "$agent_url"
  if ! done_step cloud; then
    log "$CID Cursor agent: $agent_url"
    status=$(cursor_wait)
    ev lane_end code 1 "$([ "$status" = FINISHED ] && echo 0 || echo 1)"
    jq -r '.result // empty' "$RUN/cursor-run.json" >"$RUN/cursor-result.md" 2>/dev/null
    [ "$status" = FINISHED ] || { cfail "Cursor run ended $status, see $agent_url (ff cloud $CID retries)"; return 1; }
    git -C "$WT" pull -q --ff-only origin "$BR" || cfail "could not fast-forward $BR, check $WT" || return 1
    if done_step test; then tests_kept "Cursor agent" || return 1   # it logs the fail event itself
    else mark test; fi
    mark code; mark cloud
  fi

  local pr
  pr=$(gh pr view "$BR" --json url -q .url 2>/dev/null) || {
    { printf 'Ticket: %s %s\nBuilt by Cursor Cloud Agent (%s): %s\n\n' "$CID" "$TITLE" "$CURSOR_CLOUD_MODEL" "$agent_url"
      cat "$RUN/cursor-result.md"; } >"$RUN/pr-body.md"
    pr=$(gh pr create --draft --base "$BASE" --head "$BR" --title "$CID: $TITLE" --body-file "$RUN/pr-body.md") \
      || cfail "gh pr create failed" || return 1
    if [ -n "$PR_LABEL" ]; then   # same as ff run: create the label once, then add it
      gh label create "$PR_LABEL" --color 5319E7 --description "Pull request opened by the software factory" >/dev/null 2>&1 || true
      gh pr edit "$pr" --add-label "$PR_LABEL" >/dev/null || log "$CID could not add label $PR_LABEL"
    fi
  }
  echo "$pr" >"$RUN/pr-url"; mark pr
  ev pr "" 0 "$pr"; log "$CID draft PR $pr ($(tail -n1 "$RUN/cursor-result.md"))"
}

# cloud_log <ticket key>: follow the ticket's Cursor run live (assistant text, tool calls, status).
# The live graph opens this in a side pane when you click a cloud step.
cloud_log() {
  RUN="$RUNS/$1"; local agent run url
  [ -s "$RUN/cursor-agent.json" ] || { echo "$1 has no Cursor agent (ff cloud $1 starts one)"; return 1; }
  agent=$(jq -r .agent.id "$RUN/cursor-agent.json"); run=$(jq -r .run.id "$RUN/cursor-agent.json"); url=$(jq -r .agent.url "$RUN/cursor-agent.json")
  printf '\033[1m%s\033[0m on Cursor Cloud (%s)\n%s\n\n' "$1" "$(cat "$RUN/cursor-model" 2>/dev/null || echo "$CURSOR_CLOUD_MODEL")" "$url"
  curl -sSN "$CURSOR_API/agents/$agent/runs/$run/stream" -u "$CURSOR_API_KEY:" -H 'Accept: text/event-stream' | python3 -u -c '
import json, sys
ev, seen = None, set()
for line in sys.stdin:
    line = line.rstrip("\n")
    if line.startswith("event:"): ev = line[6:].strip(); continue
    if not line.startswith("data:"): continue
    try: d = json.loads(line[5:])
    except ValueError: continue
    if ev == "assistant": sys.stdout.write(d.get("text", ""))
    elif ev == "tool_call":
        a = d.get("args") if isinstance(d.get("args"), dict) else {}
        if not a or d.get("callId") in seen: continue   # updates repeat; the first ones carry no args
        seen.add(d.get("callId"))
        what = a.get("command") or a.get("globPattern") or a.get("path") or ""
        if a.get("pattern"): what = repr(a["pattern"]) + (" in " + a["path"] if a.get("path") else "")
        print("\n\033[2m->", d.get("name"), str(what).replace("/workspace/", "")[:160], "\033[0m")
    elif ev == "status": print("\n\033[33m[" + str(d.get("status")) + "]\033[0m")
    elif ev == "result": print("\n\033[32m[" + str(d.get("status")) + "]\033[0m\n" + str(d.get("text", "")))
    elif ev == "error": print("\n\033[31m" + str(d) + "\033[0m")
    sys.stdout.flush()
'
  # The stream ends with the run, or expires: show the final state from the API.
  printf '\n\033[2m-- stream closed --\033[0m\n'
  cursor_api GET "/agents/$agent/runs/$run" 2>/dev/null | jq -r '"status: \(.status)\n\(.result // "")"'
}

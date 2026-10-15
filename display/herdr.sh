# shellcheck shell=bash
# Display: Herdr. Each ticket gets its own Herdr workspace, and Herdr switches to it: the first
# tab is the live graph, then one tab per agent step. The terminal where you typed the command is
# never split. A step's tab closes when the step succeeds; a failed step keeps its tab for reading.
# At the end a "summary" tab shows what ran, what did not, and what changed.
# Contract: see display/headless.sh.

herdr_get() { jq -r ".result$1 // empty"; }   # pull one field out of a herdr JSON reply

display_start() { :; }

# The live graph in its own tab of the ticket's workspace. Reopened if you closed it.
herdr_view_tab() {
  local file="$RUN/herdr-view-pane" pane
  pane=$(cat "$file" 2>/dev/null) && herdr pane get "$pane" >/dev/null 2>&1 && return 0
  pane=$(herdr tab create --workspace "$HERDR_WS" --cwd "$RUN" --label "live graph" --no-focus \
           --env DATA_DIR="$DATA_DIR" --env FACTORY_CONFIG="$CONFIG" | herdr_get .root_pane.pane_id)
  [ -n "$pane" ] || return 0
  echo "$pane" >"$file"
  herdr pane run "$pane" "$(printf %q "$HERE/factory.sh") view" >/dev/null
}

display_ticket_start() {
  local reply tab
  HERDR_WS=$(herdr workspace list | jq -r --arg l "factory $1" '.result.workspaces[] | select(.label == $l) | .workspace_id' | head -1)
  if [ -z "$HERDR_WS" ]; then
    # A new workspace: its first tab becomes the live graph.
    reply=$(herdr workspace create --cwd "$RUN" --label "factory $1" --focus \
              --env DATA_DIR="$DATA_DIR" --env FACTORY_CONFIG="$CONFIG")
    HERDR_WS=$(herdr_get .workspace.workspace_id <<<"$reply")
    tab=$(herdr_get .tab.tab_id <<<"$reply")
    herdr_get .root_pane.pane_id <<<"$reply" >"$RUN/herdr-view-pane"
    herdr tab rename "$tab" "live graph" >/dev/null
    herdr pane run "$(cat "$RUN/herdr-view-pane")" "$(printf %q "$HERE/factory.sh") view" >/dev/null
  else
    herdr workspace focus "$HERDR_WS" >/dev/null
    herdr_view_tab
  fi
}

display_run() {
  local title=$1 script=$2 out=$3 rc="$2.rc" pane tab reply code
  rm -f "$rc"
  reply=$(herdr tab create --workspace "$HERDR_WS" --cwd "$RUN" --label "$title" --no-focus)
  pane=$(herdr_get .root_pane.pane_id <<<"$reply"); tab=$(herdr_get .tab.tab_id <<<"$reply")
  [ -n "$pane" ] || { bash "$script" >"$out" 2>&1; return; }   # Herdr unavailable: run headless
  printf 'bash %q 2>&1 | tee %q; echo "${PIPESTATUS[0]}" > %q\n' "$script" "$out" "$rc" >"$script.pane"
  herdr pane run "$pane" "bash $(printf %q "$script.pane")" >/dev/null
  # The sandbox enforces the time limit, so the rc file always appears unless the tab is closed.
  until [ -s "$rc" ]; do
    herdr pane get "$pane" >/dev/null 2>&1 || return 130
    sleep 2
  done
  code=$(cat "$rc")
  [ "$code" = 0 ] && herdr tab close "$tab" >/dev/null 2>&1   # done: the log is in the run folder
  return "$code"
}

display_ticket_end() {
  [ -s "$RUN/summary.txt" ] || return 0
  local pane
  pane=$(herdr tab create --workspace "$HERDR_WS" --cwd "$RUN" --label "summary" --focus | herdr_get .root_pane.pane_id)
  [ -n "$pane" ] && herdr pane run "$pane" "clear; cat $(printf %q "$RUN/summary.txt")" >/dev/null
}

# Close this ticket's step tabs (a stopped run's leftovers), keeping the live graph.
display_stop() {
  [ -n "${HERDR_WS:-}" ] || return 0
  local tab
  for tab in $(herdr tab list --workspace "$HERDR_WS" | jq -r '.result.tabs[] | select(.label != "live graph") | .tab_id'); do
    herdr tab close "$tab" >/dev/null 2>&1
  done
}

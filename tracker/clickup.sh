# shellcheck shell=bash
# Tracker adapter: ClickUp. Needs CLICKUP_TOKEN, CLICKUP_TEAM_ID, CLICKUP_USER_ID (CLICKUP_LIST_ID optional).
# To support another tracker, copy this file and implement the same 7 functions.
#   tracker_status ID STATUS      set the ticket status
#   tracker_comment ID            post stdin as a comment
#   tracker_fetch ID RUNDIR       write RUNDIR/ticket.md and RUNDIR/comments.md
#   tracker_info ID               print "<display id><TAB><title>"
#   tracker_list                  print "<id><TAB><status>" per ticket assigned to me in $S_TODO or $S_APPROVED, $S_APPROVED first
#   tracker_resolve REF           ticket key, id or URL -> internal id
#   tracker_whoami                print ids needed for config
API=https://api.clickup.com/api/v2
# Bounded and retried: a hung or flaky API must not stall the daemon. curl retries only
# transient failures (timeouts, 429, 5xx).
api() {
  [ -n "${CLICKUP_TOKEN:-}" ] || { echo "CLICKUP_TOKEN is not set (ff login CLICKUP_TOKEN)" >&2; return 1; }
  curl -fsS --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 2 \
    -H "Authorization: $CLICKUP_TOKEN" -H "Content-Type: application/json" "$@"
}

tracker_status() { jq -n --arg s "$2" '{status:$s}' | api -X PUT "$API/task/$1" -d @- >/dev/null; }
tracker_comment() { jq -Rs '{comment_text:., notify_all:false}' | api -X POST "$API/task/$1/comment" -d @- >/dev/null; }

tracker_fetch() {
  api "$API/task/$1?include_markdown_description=true" \
    | jq -r '"# \(.custom_id // .id): \(.name)\n\nURL: \(.url)\n\n\(.markdown_description // .description // "")"' >"$2/ticket.md" || return 1
  api "$API/task/$1/comment" \
    | jq -r '.comments[] | "[\(.user.username)] \(.comment_text)\n"' >"$2/comments.md"
}

tracker_info() { api "$API/task/$1" | jq -r '[(.custom_id // .id), .name] | @tsv'; }

tracker_list() {
  local url="$API/team/$CLICKUP_TEAM_ID/task"
  [ -n "${CLICKUP_LIST_ID:-}" ] && url="$API/list/$CLICKUP_LIST_ID/task"
  api -G "$url" --data-urlencode "assignees[]=$CLICKUP_USER_ID" \
    --data-urlencode "statuses[]=$S_TODO" --data-urlencode "statuses[]=$S_APPROVED" \
    | jq -r --arg a "$(lc "$S_APPROVED")" '.tasks | sort_by(.status.status|ascii_downcase != $a) | .[] | [.id, .status.status] | @tsv'
}

tracker_resolve() {
  local x=${1##*/}; x=${x%%[?#]*}
  if [[ $x =~ ^[A-Za-z]+-[0-9]+$ ]]; then
    x=$(printf '%s' "$x" | tr '[:lower:]' '[:upper:]')
    api "$API/task/$x?custom_task_ids=true&team_id=$CLICKUP_TEAM_ID" | jq -r .id
  else echo "$x"; fi
}

tracker_whoami() {
  api "$API/user" | jq '{user_id: .user.id, name: .user.username}'
  api "$API/team" | jq '.teams[] | {team_id: .id, name}'
}

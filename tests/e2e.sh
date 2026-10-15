#!/usr/bin/env bash
# End-to-end check of the orchestrator with no network: a scratch repo, a fake tracker, a fake
# gh and fake agents that write what each real agent writes.
#   tests/e2e.sh [none|docker] [headless|herdr] [pass|fail|deltests|edittests|verify|parallel]
# fail: the coder crashes. deltests: the coder deletes the spec tests. edittests: the coder edits
# a spec test without saying so. All three check the failure path. verify: the factory's own
# VERIFY_CMD run fails after the coder's first try. parallel: the daemon runs two tickets at
# once. In every mode the coder also tries to change refs outside its ticket. KEEP=1 keeps the files.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX=${1:-none}; DISPLAY_UI=${2:-headless}; MODE=${3:-pass}
T=$(mktemp -d "$HOME/.sf-e2e.XXXX")   # under $HOME so Docker Desktop can mount it
[ -n "${KEEP:-}" ] && echo "kept: $T" || trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/data/runs/T-1" "$T/agent"
git init -q --bare "$T/origin.git"; git clone -q "$T/origin.git" "$T/repo" 2>/dev/null
mkdir -p "$T/repo/.claude/commands" && echo "# repo review skill" > "$T/repo/.claude/commands/review-a.md"   # a repo skill must win
git -C "$T/repo" add . && git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q -m init
git -C "$T/repo" branch -M main; git -C "$T/repo" push -q origin main

cat >"$T/tracker.sh" <<X
tracker_status()  { echo "status \$2" >> $T/tracker.log; }
tracker_comment() { echo "comment \$(tr '\n' ' ')" >> $T/tracker.log; }
tracker_fetch()   { printf '# %s: test\nSkills: no-such-skill, ../../escape\n' "\$1" > "\$2/ticket.md"; : > "\$2/comments.md"; }
tracker_info()    { printf '%s\ttest ticket\n' "\$1"; }
tracker_resolve() { echo "\$1"; }
tracker_list()    { :; }
tracker_whoami()  { :; }
X
cat >"$T/bin/gh" <<X
#!/usr/bin/env bash
echo "gh \$*" >> $T/gh.log
case "\$1 \$2" in "pr view") exit 1 ;; "pr create") echo "https://example.test/pr/\$(date +%s%N)" ;; esac
X
chmod +x "$T/bin/gh"
# Lives in the run folder, so a sandboxed agent can run it too.
[ "$MODE" = fail ] && touch "$T/data/runs/T-1/coder-crashes"
[ "$MODE" = deltests ] && touch "$T/data/runs/T-1/coder-deletes-tests"
[ "$MODE" = edittests ] && touch "$T/data/runs/T-1/coder-edits-tests"
[ "$MODE" = verify ] && touch "$T/data/runs/T-1/coder-breaks-verify"
# Mounted into the sandbox (SANDBOX_ARGS below), so every ticket's agents can run it.
cat >"$T/agent/fakeagent" <<'X'
p="${@: -1}"
case "$p" in -*) echo "error: prompt starts with '-', the CLI would read it as an option" >&2; exit 2 ;; esac
run=$(grep -o 'RUN_DIR=[^ ]*' <<<"$p" | cut -d= -f2); round=$(grep -o 'ROUND=[0-9]*' <<<"$p" | cut -d= -f2)
git config user.name >/dev/null || export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
case "$p" in
  *"Agent: spec writer"*)  printf 'spec\nSTATUS: READY\n' > "$run/spec.md" ;;
  *"Agent: planner"*)      echo plan > "$run/plan.md" ;;
  *"Agent: test writer"*)  echo "test AC-1" > ac1.test && git add ac1.test && git commit -qm "T-1 test: AC-1 (red)" && echo "AC-1 -> ac1.test" > "$run/tests.md"
                           # the base branch moves on meanwhile: its changes are not spec tests
                           u=$(mktemp -d); git clone -q -b main "$(git remote get-url origin)" "$u" 2>/dev/null && echo up > "$u/upstream.txt" \
                             && git -C "$u" add . && git -C "$u" commit -qm upstream && git -C "$u" push -q origin HEAD:main; rm -rf "$u"; git fetch -q origin
                           true ;;   # two parallel tickets race to push and fetch main: losing that race is fine
  *"Agent: coder"*)        [ -e "$run/coder-crashes" ] && exit 7; [ -e "$run/coder-deletes-tests" ] && git rm -q ac1.test
                           [ -e "$run/coder-edits-tests" ] && echo weakened >> ac1.test && git add ac1.test
                           # try to leave the ticket's cell: every one of these must be refused
                           { git update-ref refs/heads/main HEAD; git branch other-ticket-branch
                             echo x >> .claude/commands/review-a.md; git stash; git checkout -q -- .claude/commands/review-a.md
                             git tag v-agent; } >>"$run/escape.log" 2>&1
                           echo "port $PORT_BASE compose $COMPOSE_PROJECT_NAME memory-off ${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-}" >"$run/cell.txt"
                           if [ -e "$run/coder-breaks-verify" ] && [ ! -e "$run/verify-failed.md" ]; then echo broken >> file.txt; else echo code >> file.txt; sed -i.bak /broken/d file.txt; rm -f file.txt.bak; fi
                           sleep "${FAKE_SLOW:-0}"; git add file.txt && git commit -qm "T-1 code" ;;
  *"Agent: docs writer"*)  echo "No docs change needed" > "$run/docs.md" ;;
  *"Agent: PR summary"*)   echo "T-1 title $round" > "$run/pr-title.txt"; echo body > "$run/pr-body.md" ;;
  *"Agent: code reviewer"*) [ "$round" = 1 ] && v=FIX || v=PASS; printf 'P1 x\nVERDICT: %s\n' "$v" > "$run/review-$round.md" ;;
  *"Agent: judge"*)        printf '{"score":4,"summary":"done","criteria":[{"id":"AC-1","text":"x","status":"met","evidence":"ac1.test"}],"spec_gaps":[],"hallucinations":[{"claim":"y","where":"pr-body","why":"z"}],"out_of_scope":[],"prompt_suggestions":[{"agent":"code","problem":"p","suggestion":"s"}]}' > "$run/judge.json" ;;
  *"Agent: fixer"*)        echo fix >> file.txt && git commit -qam "T-1 fix" ;;
esac
X
jq -n --arg a "$T/agent/fakeagent" '{clis: {fake: {command: ("bash " + $a + " {model}"), auth: [], env: [], check: "true"}},
  lanes: {spec: ["fake:m-1"], code: ["fake:m-1"], review: ["fake:other-1"]},
  aliases: {plan: "spec", test: "code", judge: "review", docs: "code", "pr-summary": "code", fix: "code"}, pinned: []}' >"$T/router.json"

ff() { env -u HERDR_ENV PATH="$T/bin:$PATH" FACTORY_CONFIG=/dev/null TRACKER="$T/tracker.sh" DATA_DIR="$T/data" \
  REPO="$T/repo" BASE=main ROUTER_CONFIG="$T/router.json" AGENT_TIMEOUT=120 SANDBOX="$SANDBOX" \
  DISPLAY_UI="$DISPLAY_UI" PR_LABEL="test-label" TRACKER_COMMENTS=1 SKILLS_PATH="$HERE/skills" \
  SANDBOX_ARGS="-v $T/origin.git:$T/origin.git -v $T/agent:$T/agent" "$HERE/factory.sh" "$@"; }   # the fake test writer pushes to origin
main_before=$(git -C "$T/repo" rev-parse main)
if [ "$MODE" = verify ]; then VERIFY_CMD='! grep -q broken file.txt 2>/dev/null' ff run T-1 >"$T/out.log" 2>&1
elif [ "$MODE" = parallel ]; then
  mkdir -p "$T/data/state/queue"; echo T-1 >"$T/data/state/queue/1-a"; echo T-2 >"$T/data/state/queue/1-b"
  MAX_PARALLEL=2 FAKE_SLOW=3 ff daemon --once >"$T/out.log" 2>&1
else ff run T-1 >"$T/out.log" 2>&1; fi

OTEL_SUMMARY=$(python3 "$HERE/observe/otlp.py" T-1 "$T/data/state/events.jsonl" "$T/data/runs/T-1" --summary)
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; cat "$T/out.log"; exit 1; fi; }
if [ "$MODE" = deltests ]; then
  check "run blocked: coder deleted spec tests" 'grep -q "coder deleted tests written from the spec: ac1.test" "$T/out.log" && [ "$(tail -1 "$T/tracker.log")" = "status blocked" ]'
  check "no PR opened"                          '[ ! -e "$T/gh.log" ] || ! grep -q "pr create" "$T/gh.log"'
  exit 0
fi
if [ "$MODE" = edittests ]; then
  check "run blocked: coder edited a spec test" 'grep -q "coder changed tests written from the spec without naming them in test-changes.md: ac1.test" "$T/out.log" && [ "$(tail -1 "$T/tracker.log")" = "status blocked" ]'
  check "no PR opened"                          '[ ! -e "$T/gh.log" ] || ! grep -q "pr create" "$T/gh.log"'
  exit 0
fi
if [ "$MODE" = verify ]; then
  lanes=$(jq -r 'select(.ev=="lane_start") | "\(.lane)\(.round)"' "$T/data/state/events.jsonl" | tr '\n' ' ')
  check "verify gate: baseline, catch, retry" '[ "${lanes%%docs*}" = "spec1 plan1 verify1 test1 code1 verify2 code2 verify3 " ]'
  check "verify gate: second coder fixed it"   '[ -s "$T/data/runs/T-1/code-2.log" ] || [ -e "$T/data/runs/T-1/code-2.log" ]; ! git -C "$T/origin.git" show feature/T-1/test-ticket:file.txt | grep -q broken && [ ! -e "$T/data/runs/T-1/verify-failed.md" ]'
  check "verify gate: PR opened after the fix"  'grep -q "pr create --draft" "$T/gh.log"'
  exit 0
fi
if [ "$MODE" = parallel ]; then
  for k in T-1 T-2; do
    check "$k: finished with its own PR"   'grep -q "pr create --draft --base main --head feature/$k/test-ticket" "$T/gh.log" && [ "$(tail -1 "$T/data/runs/$k/journal")" = finished ]'
    check "$k: pushed from its own worktree" '[ "$(git -C "$T/origin.git" log --format=%s "feature/$k/test-ticket" | grep -c "T-1 code")" = 1 ]'
  done
  check "tickets ran at the same time"   'jq -rs "[.[] | select(.ev==\"ticket_start\")] | length" "$T/data/state/events.jsonl" | grep -qx 2 && [ "$(jq -r "select(.ev==\"ticket_start\" or .ev==\"ticket_end\") | .ev" "$T/data/state/events.jsonl" | head -2 | tr "\n" " ")" = "ticket_start ticket_start " ]'
  check "each ticket its own ports"      '[ "$(cut -d" " -f2 "$T/data/runs/T-1/cell.txt")" != "$(cut -d" " -f2 "$T/data/runs/T-2/cell.txt")" ]'
  check "slots and claims released"      '[ -z "$(ls -A "$T/data/state/queue/running")" ] && ! ls -d "$T/data/state/slot-"* >/dev/null 2>&1'
  check "base branch untouched"          '[ "$(git -C "$T/repo" rev-parse main)" = "$main_before" ]'
  exit 0
fi
if [ "$MODE" = fail ]; then
  check "run stops after the coder fails"  '[ "$(jq -r "select(.ev==\"lane_start\") | .lane" "$T/data/state/events.jsonl" | tr "\n" " ")" = "spec plan test code " ]'
  check "ticket blocked with a comment" 'grep -q "comment Factory stopped" "$T/tracker.log" && [ "$(tail -1 "$T/tracker.log")" = "status blocked" ]'
  check "no PR opened"                  '[ ! -e "$T/gh.log" ] || ! grep -q "pr create" "$T/gh.log"'
  check "trace marks code step failed"  'grep -q "^FAIL code" <<<"$OTEL_SUMMARY"'
  check "trace marks the run failed"    'grep -q "^FAIL ticket T-1" <<<"$OTEL_SUMMARY"'
  check "summary lists steps not run"   'grep -q "^Not run: docs, pr-summary, review, judge  (stopped early)" "$T/data/runs/T-1/summary.txt"'
  exit 0
fi
agents=$(jq -r 'select(.ev=="lane_start") | .lane' "$T/data/state/events.jsonl" | tr '\n' ' ')
check "guard: base branch untouched"     '[ "$(git -C "$T/repo" rev-parse main)" = "$main_before" ]'
check "guard: no new branch, tag, stash" '! git -C "$T/repo" show-ref -q refs/heads/other-ticket-branch && ! git -C "$T/repo" show-ref -q refs/tags/v-agent && ! git -C "$T/repo" rev-parse -q --verify refs/stash >/dev/null'
check "guard: refusals logged"          '[ "$(grep -c "refused" "$T/data/runs/T-1/escape.log")" = 4 ] && [ "$(wc -l <"$T/data/runs/T-1/guard.log")" -ge 4 ]'
check "cell: ports, compose, no memory" 'grep -qx "port 20000 compose factory-t-1 memory-off 1" "$T/data/runs/T-1/cell.txt"'
check "skill names from tickets checked" 'grep -q "skill name .../../escape. is not a plain name" "$T/out.log"'
check "pstack skills delivered"         'grep -q "^review: pstack/blast-radius <- .*skills/pstack/blast-radius$" "$T/data/runs/T-1/skills.log"'
check "agents run in order"        '[ "$agents" = "spec plan test code docs pr-summary review fix review pr-summary judge " ]'
check "code and fix pushed"        '[ "$(git -C "$T/origin.git" log --format=%s feature/T-1/test-ticket | head -2 | tr "\n" " ")" = "T-1 fix T-1 code " ]'
check "draft PR to base"           'grep -q "pr create --draft --base main" "$T/gh.log"'
check "branch is type/ticket/desc"  'grep -q "pr create --draft --base main --head feature/T-1/test-ticket" "$T/gh.log"'
check "PR labelled"                'grep -q "add-label test-label" "$T/gh.log"'
check "PR text refreshed after fix" 'grep -q "pr edit .* --title T-1 title 2" "$T/gh.log"'
check "PR marked ready"            'grep -q "pr ready" "$T/gh.log"'
check "ticket moved to in review"  '[ "$(tail -1 "$T/tracker.log")" = "status in review" ]'
check "missing skill logged"       'grep -q "skill no-such-skill not found" "$T/out.log"'
check "trace has every step"        '[ "$(grep -c "^ok " <<<"$OTEL_SUMMARY")" = 12 ]'
check "only test-writer files guarded" '[ "$(cat "$T/data/runs/T-1/test-files.txt")" = ac1.test ]'
check "spec tests kept"            'git -C "$T/origin.git" show feature/T-1/test-ticket:ac1.test >/dev/null 2>&1'
check "repo skill wins over factory"  'grep -q "^review: review-a <- .claude/commands/review-a.md$" "$T/data/runs/T-1/skills.log"'
check "factory skill as fallback"    'grep -q "^test: tdd <- .*skills/mattpocock/engineering/tdd$" "$T/data/runs/T-1/skills.log"'
check "judge score in ticket comment" 'grep -q "Judge score: 4/5" "$T/tracker.log"'
check "judge summary on the PR"      'grep -q "pr comment .*judge.txt" "$T/gh.log"'
if [ "${DB:-}" = mysql ]; then   # point DB_CONTAINER at a scratch MySQL, never the real one
  q() { docker exec -e MYSQL_PWD="$DB_PASSWORD" "$DB_CONTAINER" mysql -ufactory factory -NBe "$1"; }
  row=$(q "select concat_ws('|', status, judge_score, criteria_met, hallucinations, review_rounds) from v_runs where ticket_key = 'T-1' order by started_at desc limit 1")
  check "run stored in the database"   '[ "$row" = "pr_open|4|1|1|2" ]'
  check "agent steps stored"           '[ "$(q "select count(*) from agent_steps s join runs r on r.id = s.run_id where r.ticket_key = '"'"'T-1'"'"' and r.started_at = (select max(started_at) from runs where ticket_key = '"'"'T-1'"'"')")" = 11 ]'
  check "views answer"                 '[ "$(q "select concat_ws(\"|\", (select count(*) from v_criteria), (select count(*) from v_hallucinations), (select count(*) from v_prompt_suggestions) > 0)")" != "" ]'
fi
check "summary: every step"         'grep -q "^Steps run (11):" "$T/data/runs/T-1/summary.txt"'
check "summary: files and commits"   'grep -q "added    ac1.test" "$T/data/runs/T-1/summary.txt" && grep -q "T-1 fix" "$T/data/runs/T-1/summary.txt"'
check "summary printed at the end"   'grep -q "^Result: PR opened" "$T/out.log"'
check "no step scripts left"       '! ls "$T/data/runs/T-1/steps/"*.sh >/dev/null 2>&1'

# Operations. A daemon that died mid-run left a claimed queue entry and a lock: the next daemon
# clears the lock, runs the ticket again, and drops the claim when the run ends.
mkdir -p "$T/data/state/queue/running" "$T/data/state/lock-T-1"
echo T-1 >"$T/data/state/queue/running/1-1"; echo 999999 >"$T/data/state/lock-T-1/pid"
grep -vx finished "$T/data/runs/T-1/journal" >"$T/j" && mv "$T/j" "$T/data/runs/T-1/journal"   # stopped just before the end
ff daemon --once >"$T/daemon.log" 2>&1 || { cat "$T/daemon.log"; exit 1; }
check "doctor passes"                'sed "/daemon up/q" "$T/daemon.log" | grep -q "ok    agent CLIs ready: fake" && ! sed "/daemon up/q" "$T/daemon.log" | grep -q FAIL'
check "daemon resumes a claimed ticket" 'grep -q "T-1 continues after" "$T/daemon.log" && [ "$(tail -1 "$T/data/runs/T-1/journal")" = finished ]'
check "claim and locks released"     '[ -z "$(ls -A "$T/data/state/queue/running")" ] && [ ! -e "$T/data/state/lock-T-1" ] && [ ! -e "$T/data/state/daemon.lock" ]'
ff gc 0 >"$T/gc.log" 2>&1
check "gc removes idle worktrees"    'grep -q "removed worktree T-1" "$T/gc.log" && [ ! -e "$T/data/worktrees/T-1" ] && ! git -C "$T/repo" worktree list | grep -q T-1'
check "gc keeps the branch"          'git -C "$T/repo" show-ref -q refs/heads/feature/T-1/test-ticket'
check "gc trims old log lines"       '[ ! -s "$T/data/state/events.jsonl" ] && [ ! -s "$T/data/state/decisions.jsonl" ]'

#!/usr/bin/env bash
# Check `ff cloud` with no network: a fake Cursor API (curl) that pushes a commit like a cloud
# agent would, and a fake gh. Covers: WIP handoff push, request body, draft PR, journal, resume.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); [ -n "${KEEP:-}" ] && echo "kept: $T" || trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/data/runs/T-1" "$T/data/worktrees"
git init -q --bare "$T/origin.git"; git clone -q "$T/origin.git" "$T/repo" 2>/dev/null
G="git -c user.name=t -c user.email=t@t"
echo a >"$T/repo/a.txt"; $G -C "$T/repo" add . && $G -C "$T/repo" commit -qm init
git -C "$T/repo" branch -M main; git -C "$T/repo" push -q origin main
git -C "$T/repo" worktree add -q -b feature/T-1 "$T/data/worktrees/T-1" main
W="$T/data/worktrees/T-1"
echo t >"$W/ac1.test"; $G -C "$W" add . && $G -C "$W" commit -qm "T-1 test (red)"
echo ac1.test >"$T/data/runs/T-1/test-files.txt"
echo partial >"$W/partial.txt"   # uncommitted work from a dead local coder
R="$T/data/runs/T-1"; printf 'spec AC-1\n' >"$R/spec.md"; echo plan >"$R/plan.md"; echo "AC-1 -> ac1.test" >"$R/tests.md"
printf 'spec\nplan\ntest\n' >"$R/journal"

cat >"$T/tracker.sh" <<X
tracker_status() { echo "status \$2" >> $T/tracker.log; }
tracker_comment() { :; }; tracker_fetch() { :; }; tracker_list() { :; }; tracker_whoami() { :; }
tracker_info() { printf '%s\ttest ticket\n' "\$1"; }
tracker_resolve() { echo "\$1"; }
X
cat >"$T/bin/curl" <<X
#!/usr/bin/env bash
echo "curl \$*" >> $T/curl.log
case "\$*" in
  *"POST https://api.cursor.com/v1/agents "*)
    for a; do [ "\$prev" = --data-binary ] && printf '%s' "\$a" > $T/body.json; prev=\$a; done
    # the cloud agent: clone the pushed branch, commit, push
    rm -rf $T/cloud; git clone -q -b "\$(jq -r '.repos[0].startingRef' $T/body.json)" $T/origin.git $T/cloud 2>/dev/null
    echo code > $T/cloud/code.txt; $G -C $T/cloud add . && $G -C $T/cloud commit -qm "T-1 code" && git -C $T/cloud push -q
    echo '{"agent":{"id":"bc-1","url":"https://cursor.com/agents/bc-1"},"run":{"id":"run-1","status":"CREATING"}}' ;;
  *"GET https://api.cursor.com/v1/models"*) echo '{"items":[{"id":"composer-2.5","displayName":"Composer 2.5"},{"id":"grok-4.7","displayName":"Grok 4.7"}]}' ;;
  *"/agents/bc-1/runs/run-1"*) echo "{\\"status\\":\\"\$(cat $T/status 2>/dev/null || echo FINISHED)\\",\\"result\\":\\"AC-1 met\\\\nVERDICT: PASS\\"}" ;;
  *) exit 22 ;;
esac
X
cat >"$T/bin/gh" <<X
#!/usr/bin/env bash
echo "gh \$*" >> $T/gh.log
case "\$1 \$2" in "pr view") exit 1 ;; "pr create") echo https://example.test/pr/1 ;; esac
X
chmod +x "$T/bin/"*

cat >"$T/fakeagent" <<'X'
p="${@: -1}"; run=$(grep -o 'RUN_DIR=[^ ]*' <<<"$p" | cut -d= -f2)
case "$p" in *"Agent: spec writer"*) printf 'spec AC-9\nSTATUS: READY\n' > "$run/spec.md" ;; *"Agent: planner"*) echo plan > "$run/plan.md" ;; esac
X
jq -n --arg a "$T/fakeagent" '{clis: {fake: {command: ("bash " + $a + " {model}"), auth: [], env: [], check: "true"}},
  lanes: {spec: ["fake:m-1"]}, aliases: {plan: "spec"}, pinned: []}' >"$T/router.json"
run() { env -u HERDR_ENV ROUTER_CONFIG="$T/router.json" SKILLS_PATH=/nonexistent PATH="$T/bin:$PATH" FACTORY_CONFIG=/dev/null TRACKER="$T/tracker.sh" DATA_DIR="$T/data" \
  REPO="$T/repo" BASE=main SANDBOX=none DISPLAY_UI=headless CURSOR_API_KEY=k CURSOR_REPO_URL=https://github.com/o/r \
  CURSOR_CLOUD_POLL=0 CURSOR_CLOUD_TIMEOUT=20 "$HERE/factory.sh" cloud "${@:-T-1}" >>"$T/out.log" 2>&1 </dev/null; }
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; cat "$T/out.log"; exit 1; fi; }

check "bad flag refused"             '! run T-1 --nope && ! [ -e "$T/body.json" ]'
check "--models lists ids"           'run --models && grep -q "^grok-4.7" "$T/out.log"'
run T-1 --model grok-4.7
check "partial work pushed as WIP"   'git -C "$T/origin.git" log --format=%s feature/T-1 | grep "T-1 wip: handoff to Cursor Cloud" >/dev/null'
check "agent asked for branch+model" 'jq -e ".repos[0].startingRef==\"feature/T-1\" and .workOnCurrentBranch and .model.id==\"grok-4.7\" and (.autoCreatePR|not)" "$T/body.json" >/dev/null'
check "tests exist: Cursor keeps them" '! jq -r .prompt.text "$T/body.json" | grep "No tests exist yet" >/dev/null'
check "prompt inlines spec"          'jq -r .prompt.text "$T/body.json" | grep "spec AC-1" >/dev/null'
check "cloud commit pulled"          '[ -e "$W/code.txt" ]'
check "draft PR opened"              'grep -q "pr create --draft --base main --head feature/T-1" "$T/gh.log"'
check "journal marks code cloud pr"  '[ "$(tail -3 "$R/journal" | tr "\n" " ")" = "code cloud pr " ]'
check "verdict kept for the PR"      'grep -q "VERDICT: PASS" "$R/pr-body.md"'
n=$(grep -c "POST https://api.cursor.com/v1/agents " "$T/curl.log")
run
check "rerun starts no second agent" '[ "$(grep -c "POST https://api.cursor.com/v1/agents " "$T/curl.log")" = "$n" ]'

E="$T/data/state/events.jsonl"
check "graph: resume, cloud link, end" 'jq -r "select(.ticket==\"T-1\") | .ev" "$E" | tr "\n" " " | grep -q "ticket_resume lane_start cloud lane_end pr ticket_end"'
check "graph: cloud model on the step" 'jq -e "select(.ev==\"lane_start\") | select(.msg==\"cursor-cloud:grok-4.7\")" "$E" >/dev/null'
check "lock released"                  '[ ! -e "$T/data/state/lock-T-1" ]'
check "view shows cloud step + link"   'DATA_DIR="$T/data" python3 "$HERE/factory-view.py" --once | grep "☁ cursor grok-4.7" >/dev/null && DATA_DIR="$T/data" python3 "$HERE/factory-view.py" --once | grep "Cursor agent https://cursor.com/agents/bc-1" >/dev/null'
check "view: click hits match boxes"   'DATA_DIR="$T/data" python3 - "$HERE/factory-view.py" <<"PY"
import importlib.util, re, sys, time
s = importlib.util.spec_from_file_location("fv", sys.argv[1]); fv = importlib.util.module_from_spec(s); s.loader.exec_module(fv)
plain = [fv.strip(l) for l in fv.render(time.time(), 0, 120)]
assert fv.HITS and all(plain[y0][x0] == "┌" and l["name"] in plain[y0 + 1][x0:x1] for y0, y1, x0, x1, t, l in fv.HITS)
cloud = [h for h in fv.HITS if h[5]["model"].startswith("cursor-cloud:")]
assert cloud and fv.step_cmd(cloud[0][4], cloud[0][5]).endswith("cloud-log T-1")
assert re.match(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])", "\x1b[<0;12;9M")
PY'

# a failed Cursor run: new agent, fail shown in the graph, no second PR
printf 'spec\nplan\ntest\n' >"$R/journal"; echo ERROR >"$T/status"; rm -rf "$T/cloud"; : >"$T/gh.log"
check "failed run exits non-zero"      '! run T-1 --model grok-4.7'
check "fail reason in the graph"       'tail -2 "$E" | jq -r .msg | grep "Cursor run ended ERROR" >/dev/null'
check "no PR after a failed run"       '! grep -q "pr create" "$T/gh.log"'

# a new ticket: no spec, plan, tests or worktree. Spec and plan are written locally, Cursor writes the tests.
rm -f "$T/status"
run T-2 --model grok-4.7
R2="$T/data/runs/T-2"
check "new ticket: spec+plan generated" 'grep -q "spec AC-9" "$R2/spec.md" && [ -s "$R2/plan.md" ]'
check "new ticket: branch type/id/desc"  'jq -e ".repos[0].startingRef==\"feature/T-2/test-ticket\"" "$T/body.json" >/dev/null'
check "new ticket: Cursor writes tests"  'jq -r .prompt.text "$T/body.json" | grep "No tests exist yet" >/dev/null'
check "new ticket: draft PR opened"      'grep -q "head feature/T-2/test-ticket" "$T/gh.log"'

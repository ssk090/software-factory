#!/usr/bin/env python3
"""Store one ticket run in the factory's local MySQL (a Docker container), for the dashboard.

    db.py <ticket> <events.jsonl> <run_dir> <worktree> <base>          sync the latest run
    db.py <ticket> <events.jsonl> <run_dir> <worktree> <base> --print  print the document, write nothing
    db.py --schema                                                      create or update the tables only

Talks to MySQL with `docker exec` into DB_CONTAINER, so no MySQL client is needed on the host.
Needs DB_CONTAINER and DB_PASSWORD (ff db up sets both). Texts are trimmed to MAX_TEXT characters.
"""
import json, os, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from otlp import latest_run, route_skips, tail  # noqa: E402

HERE = Path(__file__).parent
MAX_TEXT = 20000


def text(path, n=MAX_TEXT):
    return tail(path, n) or None


def diff_stats(worktree, base):
    """Files changed, lines added and deleted on the branch."""
    out = subprocess.run(["git", "-C", worktree, "diff", "--numstat", f"origin/{base}...HEAD"],
                         capture_output=True, text=True).stdout
    rows = [l.split("\t") for l in out.splitlines() if l.count("\t") >= 2]
    num = lambda v: int(v) if v.isdigit() else 0   # binary files show "-"
    return len(rows), sum(num(r[0]) for r in rows), sum(num(r[1]) for r in rows)


def judge(run):
    try:
        return json.loads((run / "judge.json").read_text())
    except (OSError, ValueError):
        return None


def document(ticket, events, run, worktree, base):
    first, last = events[0], events[-1]
    ev = lambda name: [e for e in events if e["ev"] == name]
    # The outcome counts only what happened after the latest resume (a stop, then ff run again).
    resumes = [i for i, e in enumerate(events) if e["ev"] == "ticket_resume"]
    latest = events[resumes[-1]:] if resumes else events
    ev_latest = lambda name: [e for e in latest if e["ev"] == name]
    skills_log = text(run / "skills.log") or ""
    steps, open_steps, seq = [], {}, 0
    for e in events:
        key = (e["lane"], e["round"])
        if e["ev"] == "lane_start":
            open_steps[key] = e
        elif e["ev"] == "lane_end" and key in open_steps:
            s = open_steps.pop(key)
            seq += 1
            cli, _, model = s["msg"].rpartition(":")
            prompts = sorted((run / "steps").glob(f"factory-{ticket}-{e['lane']}-{e['round']}-*.sh.prompt"))
            steps.append({"seq": seq, "agent": e["lane"], "round": e["round"], "cli": cli or "pi", "model": model,
                          "started_at": s["t"], "ended_at": e["t"], "exit_code": int(e["msg"] or 0),
                          "router_skipped": "; ".join(route_skips(run, e["lane"])) or None,
                          "skills": "\n".join(l for l in skills_log.splitlines() if l.startswith(e["lane"] + ":")) or None,
                          "prompt": text(prompts[-1], 8000) if prompts else None,
                          "output": text(run / f"{e['lane']}-{e['round']}.log", 8000)})
    verdicts = {v["round"]: v["msg"] for v in ev("verdict")}
    reviews = [{"round": int(m.group(1)), "verdict": verdicts.get(int(m.group(1))), "body": text(p)}
               for p in sorted(run.glob("review-*.md")) if (m := re.match(r"review-(\d+)\.md$", p.name))]
    failure = next((e["msg"] for e in ev_latest("fail")), None)
    pr = next((e["msg"] for e in reversed(ev("pr"))), None)
    finished = bool(ev_latest("ticket_end"))
    status = "failed" if failure else "pr_open" if pr else "spec_posted" if ev("note") else "done" if finished else "running"
    files, added, deleted = diff_stats(worktree, base) if Path(worktree, ".git").exists() else (None, None, None)
    return {"run_id": f"{ticket}-{first['t']}", "ticket": ticket, "title": first["msg"],
            "description": text(run / "ticket.md"), "started_at": first["t"], "ended_at": last["t"],
            "status": status, "failure": failure, "pr_url": pr,
            "pr_title": text(run / "pr-title.txt"), "pr_body": text(run / "pr-body.md"),
            "review_rounds": len(reviews), "final_verdict": verdicts[max(verdicts)] if verdicts else None,
            "files_changed": files, "lines_added": added, "lines_deleted": deleted,
            "spec": text(run / "spec.md"), "plan": text(run / "plan.md"), "tests": text(run / "tests.md"),
            "steps": steps, "reviews": reviews, "judge": judge(run)}


def strip_none(v):
    """Drop null values, so missing JSON keys become NULL in MySQL (not the string 'null')."""
    if isinstance(v, dict):
        return {k: strip_none(x) for k, x in v.items() if x is not None}
    if isinstance(v, list):
        return [strip_none(x) for x in v]
    return v


def mysql(sql):
    """Run SQL in the factory's MySQL container. The password goes in the environment, not argv."""
    return subprocess.run(["docker", "exec", "-i", "-e", f"MYSQL_PWD={os.environ['DB_PASSWORD']}",
                           os.environ.get("DB_CONTAINER", "factory-mysql"), "mysql", "--default-character-set=utf8mb4",
                           "-ufactory", "factory"], input=sql, capture_output=True, text=True)


def sql_string(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def apply(sql, what):
    r = mysql(sql)
    if r.returncode:
        sys.exit(f"db: {what} failed: {r.stderr.strip()[:500]}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--schema"]:
        apply((HERE / "schema.sql").read_text(), "schema"); print("db: schema ready"); sys.exit()
    if len(sys.argv) < 6:
        sys.exit(__doc__)
    ticket, events_file, run, worktree, base = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5]
    events = latest_run(ticket, events_file)
    if not events:
        sys.exit(f"no run found for {ticket}. Start one with: ff run {ticket}")
    doc = strip_none(document(ticket, events, run, worktree, base))
    if "--print" in sys.argv:
        print(json.dumps(doc, indent=2)); sys.exit()
    apply((HERE / "schema.sql").read_text(), "schema")
    apply(f"SET @doc = {sql_string(json.dumps(doc))};\n" + (HERE / "upsert.sql").read_text(), "sync")
    print(f"db: stored run {doc['run_id']} ({len(doc['steps'])} steps, judge score {(doc.get('judge') or {}).get('score', '-')})")

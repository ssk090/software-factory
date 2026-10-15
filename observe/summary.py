#!/usr/bin/env python3
"""Plain-text summary of a ticket's latest run: result, steps run and not run, files changed.

    summary.py <ticket> <events.jsonl> <run_dir> <worktree> <base> <agents_dir>
"""
import subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import document, judge  # noqa: E402
from otlp import latest_run  # noqa: E402


def dur(s):
    return f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


def git(worktree, *args):
    if not Path(worktree, ".git").exists():
        return ""
    return subprocess.run(["git", "-C", worktree, *args], capture_output=True, text=True).stdout.strip()


def planned(doc, agents_dir):
    """The steps this run was meant to take, in order."""
    if doc["status"] == "spec_posted":
        return ["spec", "plan"]
    steps = ["spec", "plan", "test", "code"]
    if (Path(agents_dir) / "docs.md").exists():
        steps.append("docs")
    return steps + ["pr-summary", "review", "judge"]


def main(ticket, events_file, run, worktree, base, agents_dir):
    events = latest_run(ticket, events_file)
    if not events:
        sys.exit(f"no run found for {ticket}. Start one with: ff run {ticket}")
    doc = document(ticket, events, Path(run), worktree, base)
    j = judge(Path(run)) or {}
    out = []

    result = {"pr_open": "PR opened", "spec_posted": "spec posted, waiting for your approval",
              "failed": "FAILED", "done": "done", "running": "still running"}.get(doc["status"], doc["status"])
    out.append(f"{ticket}  {doc['title']}")
    out.append(f"Result: {result}   took {dur(doc['ended_at'] - doc['started_at'])}")
    if doc["failure"]:
        out.append(f"Why: {doc['failure']}")
    if doc["pr_url"]:
        out.append(f"PR: {doc['pr_url']}")
    if doc["final_verdict"]:
        out.append(f"Review: {doc['final_verdict']} after {doc['review_rounds']} round(s)")
    if j:
        met = sum(c.get("status") == "met" for c in j.get("criteria", []))
        out.append(f"Judge: {j.get('score')}/5, {met}/{len(j.get('criteria', []))} criteria met, "
                   f"{len(j.get('hallucinations', []))} hallucination(s). {j.get('summary', '')}")

    out.append(f"\nSteps run ({len(doc['steps'])}):")
    for s in doc["steps"]:
        mark = "ok  " if s["exit_code"] == 0 else f"FAIL (exit {s['exit_code']})"
        name = s["agent"] + (f" #{s['round']}" if s["agent"] in ("review", "fix", "pr-summary") else "")
        out.append(f"  {mark:<5} {name:<14} {s['cli']}:{s['model']:<34} {dur(s['ended_at'] - s['started_at'])}")
    ran = {s["agent"] for s in doc["steps"]}
    missing = [a for a in planned(doc, agents_dir) if a not in ran]
    if missing:
        why = "stopped early" if doc["failure"] else "waiting for your spec approval" if doc["status"] == "spec_posted" else "skipped"
        out.append(f"Not run: {', '.join(missing)}  ({why})")

    numstat = git(worktree, "diff", "--numstat", f"origin/{base}...HEAD")
    status = dict(reversed(l.split("\t", 1)) for l in git(worktree, "diff", "--name-status", f"origin/{base}...HEAD").splitlines() if "\t" in l)
    if numstat:
        out.append(f"\nFiles changed ({doc['files_changed']} files, +{doc['lines_added']} -{doc['lines_deleted']}):")
        for line in numstat.splitlines():
            add, rem, path = line.split("\t", 2)
            kind = {"A": "added", "M": "changed", "D": "deleted"}.get(status.get(path, "M")[:1], "changed")
            out.append(f"  {kind:<8} {path}  (+{add} -{rem})")
        out.append("\nCommits:")
        out += [f"  {c}" for c in git(worktree, "log", "--oneline", f"origin/{base}..HEAD").splitlines()]
    else:
        out.append("\nFiles changed: none")

    kept = [f for f in ("spec.md", "plan.md", "tests.md", "docs.md", "pr-body.md", "judge.json") if (Path(run) / f).exists()]
    kept += sorted(p.name for p in Path(run).glob("review-*.md"))
    out.append(f"\nOutput files in {run}:\n  {', '.join(kept) or 'none'} (and one log per step)")
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) != 7:
        sys.exit(__doc__)
    main(*sys.argv[1:])

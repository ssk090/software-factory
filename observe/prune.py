#!/usr/bin/env python3
"""Drop old lines from the factory's append-only logs (ff gc).

    prune.py <days> <events.jsonl> <decisions.jsonl>

events.jsonl: a ticket's events go together, so a trace never sees half a run. They are dropped
only when the ticket's newest event is older than <days>.
decisions.jsonl: routing decisions older than <days> are dropped (the quota meter needs 5 hours).
"""
import json, os, sys, time


def rows(path):
    try:
        with open(path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
    except OSError:
        return []
    out = []
    for l in lines:
        try:
            out.append((l, json.loads(l)))
        except ValueError:
            out.append((l, {}))   # a torn line: keep it, it is not ours to judge
    return out


def keep(path, all_rows, ok):
    kept = [l for l, r in all_rows if ok(r)]
    if len(kept) == len(all_rows):
        return
    with open(path + ".tmp", "w") as f:
        f.write("".join(l + "\n" for l in kept))
    os.replace(path + ".tmp", path)
    print(f"{os.path.basename(path)}: {len(all_rows) - len(kept)} old lines removed")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    cut = time.time() - int(sys.argv[1]) * 86400
    events, decisions = rows(sys.argv[2]), rows(sys.argv[3])
    newest = {}
    for _, e in events:
        t = e.get("ticket")
        newest[t] = max(newest.get(t, 0), e.get("t", 0))
    keep(sys.argv[2], events, lambda e: not e or newest.get(e.get("ticket"), 0) >= cut)
    keep(sys.argv[3], decisions, lambda d: not d or d.get("t", 0) >= cut)

#!/usr/bin/env python3
"""Live flow graph of the software factory, read from state/events.jsonl. Ctrl-C or q to quit. --once prints one frame."""
import json, os, re, shutil, subprocess, sys, time, select, termios, tty
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("DATA_DIR", HERE)
EVENTS = os.path.join(DATA, "state", "events.jsonl")
R, G, Y, D, B, X = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[1m", "\033[0m"
SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
strip = lambda s: re.sub(r"\033\[[0-9;]*m", "", s)

def load():
    out = []
    try:
        for line in open(EVENTS):
            try: out.append(json.loads(line))
            except ValueError: pass
    except FileNotFoundError: pass
    return out

def dur(s):
    s = int(s); return f"{s//60}m{s%60:02d}s" if s >= 60 else f"{s}s"

def tickets(events, now):
    ts = {}
    for e in events:
        k = e["ticket"]
        if not k: continue
        t = ts.setdefault(k, {"id": k, "title": "", "lanes": [], "pr": "", "end": None, "fail": "", "note": "", "cloud": "", "start": e["t"]})
        if e["ev"] == "ticket_start": t.update(title=e["msg"], start=e["t"], lanes=[], end=None, fail="", pr="", note="", cloud="")
        elif e["ev"] == "ticket_resume":   # keep the finished steps; a step left open by a stopped run is over
            t.update(end=None, fail="", note="")
            for l in t["lanes"]:
                if l["t1"] is None: l["t1"], l["ok"] = e["t"], False
        elif e["ev"] == "lane_start": t["lanes"].append({"name": e["lane"], "round": e["round"], "t0": e["t"], "t1": None, "ok": None, "model": e["msg"], "verdict": ""})
        elif e["ev"] == "lane_end":
            for l in reversed(t["lanes"]):
                if l["name"] == e["lane"] and l["t1"] is None: l["t1"], l["ok"] = e["t"], e["msg"] == "0"; break
        elif e["ev"] == "verdict":
            for l in reversed(t["lanes"]):
                if l["name"] == "review": l["verdict"] = e["msg"]; break
        elif e["ev"] == "pr": t["pr"] = e["msg"]
        elif e["ev"] == "cloud": t["cloud"] = e["msg"]   # Cursor Cloud agent page (ff cloud)
        elif e["ev"] == "note": t["note"] = e["msg"]
        elif e["ev"] == "fail": t["fail"] = e["msg"]
        elif e["ev"] == "ticket_end": t["end"] = e["t"]
    return list(ts.values())

def alive(ticket):
    """Is an orchestrator running this ticket right now? (its lock holds a live pid)"""
    try:
        os.kill(int(open(os.path.join(DATA, "state", f"lock-{ticket}", "pid")).read()), 0)
        return True
    except (OSError, ValueError):
        return False


def box(l, now, frame, live=True):
    if l["t1"] is None and not live: col, icon, d = R, "■", now - l["t0"]   # orchestrator gone: stopped
    elif l["t1"] is None: col, icon, d = Y, SPIN[frame % len(SPIN)], now - l["t0"]
    elif l["ok"] and l["verdict"] == "FIX": col, icon, d = Y, "▲", l["t1"] - l["t0"]
    elif l["ok"]: col, icon, d = G, "✓", l["t1"] - l["t0"]
    else: col, icon, d = R, "✗", l["t1"] - l["t0"]
    name = l["name"] + (f"#{l['round']}" if l["name"] in ("review", "fix") else "")
    top = f"{col}{icon} {B}{name}{X}"
    sub = f"{D}{dur(d)}{X}" + (f" {col}{l['verdict']}{X}" if l["verdict"] else "")
    cli, _, name = l["model"].rpartition(":")  # "<cli>:<model>", chosen by router.py or ff cloud
    if cli == "cursor-cloud": cli = "☁ cursor"
    model = f"{D}{(cli + ' ' if cli else '') + name.split('/')[-1]}"[:28] + X
    w = max(len(strip(top)), len(strip(sub)), len(strip(model))) + 2
    pad = lambda s: " " + s + " " * (w - 1 - len(strip(s)))
    return [col + "┌" + "─" * w + "┐" + X, col + "│" + X + pad(top) + col + "│" + X, col + "│" + X + pad(sub) + col + "│" + X, col + "│" + X + pad(model) + col + "│" + X, col + "└" + "─" * w + "┘" + X]

def start_run(text):
    """'<ticket>' runs the full pipeline; 'cloud <ticket> [model]' hands the code step to Cursor Cloud."""
    words = text.split()
    if words[0] == "cloud" and len(words) > 1:
        cmd = ["cloud", words[1]] + (["--model", words[2]] if len(words) > 2 else [])
    else:
        cmd = ["run", words[0]]
    log = open(os.path.join(DATA, "state", f"manual-{int(time.time())}.log"), "w")
    subprocess.Popen([os.path.join(HERE, "factory.sh")] + cmd, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)

HITS = []   # (first line, last line + 1, first col, last col + 1, ticket, lane) of every box on screen

def step_cmd(tid, l):
    """What a click on a step shows: the live Cursor stream for a cloud step, else the step's log."""
    if l["model"].startswith("cursor-cloud:"):
        return f"{os.path.join(HERE, 'factory.sh')} cloud-log {tid}"
    log = os.path.join(DATA, "runs", tid, f"{l['name']}-{l['round'] or 1}.log")
    return f"tail -n 300 -F {log!r}"

def open_side(tid, l):
    """Show a step in one pane to the right of the graph (Herdr), reused on every click. Returns a status line."""
    cmd = step_cmd(tid, l)
    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_PANE_ID"):
        return f"not in Herdr, run in another terminal: {cmd}"
    keep = os.path.join(DATA, "state", "view-side-pane")
    try: subprocess.run(["herdr", "pane", "close", open(keep).read().strip()], capture_output=True)
    except OSError: pass
    try:
        reply = subprocess.run(["herdr", "pane", "split", os.environ["HERDR_PANE_ID"], "--direction", "right", "--no-focus",
                                "--ratio", "0.45", "--cwd", DATA, "--env", f"DATA_DIR={DATA}"], capture_output=True, text=True).stdout
        pane = json.loads(reply)["result"]["pane"]["pane_id"]
    except (ValueError, KeyError, OSError):
        return f"could not open a Herdr pane, run: {cmd}"
    open(keep, "w").write(pane)
    subprocess.run(["herdr", "pane", "run", pane, f"clear; echo '{tid} {l['name']} #{l['round'] or 1}'; {cmd}"], capture_output=True)
    return f"showing {tid} {l['name']} on the right"

def click(row, col):
    for y0, y1, x0, x1, tid, l in HITS:
        if y0 <= row < y1 and x0 <= col < x1: return open_side(tid, l)
    return ""

def render(now, frame, width):
    HITS.clear()
    ev = load(); ts = tickets(ev, now)[-3:]
    polls = [e["t"] for e in ev if e["ev"] == "poll"]
    out = [f"{B}SOFTWARE FACTORY{X}  {D}{time.strftime('%H:%M:%S', time.localtime(now))}  last poll: {time.strftime('%H:%M:%S', time.localtime(polls[-1])) if polls else 'never'}{X}", "",
           f"  {B}orchestrator{X} {D}(never writes code){X}", f"  {D}│{X}"]
    if not ts: out += ["  └ no runs yet. Type a ticket below, or run: ff run <ticket> | ff cloud <ticket>"]
    for t in ts:
        live = alive(t["id"])
        running = t["end"] is None and not t["fail"] and live
        stopped = t["end"] is None and not t["fail"] and not live
        stopped = stopped or t["fail"].startswith("stopped")
        state = f"{Y}running{X}" if running else (f"{R}stopped{X}" if stopped else (f"{R}failed{X}" if t["fail"] else f"{G}done{X}"))
        out.append(f"  ├─ {B}{t['id']}{X} {t['title'][:max(10, width-30)]}  [{state}]")
        rows, cur, spots = [], [[] for _ in range(5)], []; used = 0
        for i, l in enumerate(t["lanes"]):
            end = t["end"] if t["end"] and t["end"] >= l["t0"] else now   # a step after an old end is still going
            b = box(l, end, frame, live); bw = len(strip(b[0]))
            if used + bw + 3 > width - 8 and used:
                rows.append((cur, spots)); cur, spots = [[] for _ in range(5)], []; used = 0
            spots.append((7 + used, 7 + used + bw, t["id"], l))   # screen columns of this box, for clicks
            for k in range(5): cur[k].append(b[k])
            if i < len(t["lanes"]) - 1:
                for k in range(5): cur[k].append(D + (" ─▶ " if k == 1 else "    ") + X)
            used += bw + 4
        if cur[0]: rows.append((cur, spots))
        for cur, spots in rows:
            top = len(out)
            for x0, x1, tid, l in spots: HITS.append((top, top + 5, x0, x1, tid, l))
            for k in range(5): out.append("  │    " + "".join(cur[k]))
        if t["cloud"]: out.append(f"  │    ☁ Cursor agent {t['cloud']}")
        if t["pr"]: out.append(f"  │    {G}PR{X} {t['pr']}")
        if t["note"] and running is False and not t["fail"]: out.append(f"  │    {Y}{t['note']}{X}")
        if t["fail"]: out.append(f"  │    {R}{t['fail'][:width-10]}{X}")
        out.append("  │")
    return out

if __name__ == "__main__":
    if "--once" in sys.argv:
        print("\n".join(render(time.time(), 0, shutil.get_terminal_size().columns))); sys.exit()
    fd = sys.stdin.fileno(); old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd); sys.stdout.write("\033[?1049h\033[?1000h\033[?1006h"); frame = 0; buf = ""; msg = ""   # alt screen + mouse clicks
        while True:
            w, h = shutil.get_terminal_size()
            lines = render(time.time(), frame, w)[: h - 3]
            input_line = f"{B}ticket >{X} {buf}█"
            sys.stdout.write("\033[H\033[2J" + "\n".join(lines) + f"\033[{h-1};1H{D}{msg}{X}\033[{h};1H{input_line}  {D}(click a step = open it on the right, enter = run, cloud <ticket> [model] = Cursor Cloud, esc = quit){X}"); sys.stdout.flush(); frame += 1
            if select.select([sys.stdin], [], [], 0.4)[0]:
                data = os.read(fd, 4096).decode(errors="ignore")
                while data:
                    m = re.match(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])", data)   # mouse (SGR): button;col;row
                    if m:
                        if m.group(1) == "0" and m.group(4) == "M": msg = click(int(m.group(3)) - 1, int(m.group(2)) - 1) or msg
                        data = data[m.end():]; continue
                    m = re.match(r"\x1b\[[0-9;?]*[A-Za-z~]", data)   # other keys (arrows...): ignore
                    if m: data = data[m.end():]; continue
                    ch, data = data[0], data[1:]
                    if ch in ("\x1b", "\x03"): raise KeyboardInterrupt
                    elif ch in ("\r", "\n") and buf.strip():
                        start_run(buf.strip()); msg = f"started {buf.strip()} (log: state/manual-*.log)"; buf = ""
                    elif ch in ("\x7f", "\b"): buf = buf[:-1]
                    elif ch.isprintable(): buf += ch
    except KeyboardInterrupt: pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old); sys.stdout.write("\033[?1000l\033[?1006l\033[?1049l")

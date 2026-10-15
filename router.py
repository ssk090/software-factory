#!/usr/bin/env python3
"""Pick the agent CLI and model for one factory lane. Idea from ssk090/jroute.

    router.py <lane> <run_dir>  ->  "<entry>\\t<command>\\t<family>\\t<auth files>\\t<env names>"
    router.py status            ->  which CLIs are installed and logged in, and live quota

A chain entry is "<cli>:<model>", for example "codex:gpt-6.1-sol" or
"opencode:opencode-go/glm-5.3", or a list of such entries that reach the SAME model through
different subscriptions, for example ["codex:gpt-6-luna", "opencode:opencode-go/gpt-6-luna"].
From a list the router takes the route whose subscription has the most quota left. The CLIs are
defined in router.json under "clis", so a new CLI is a config change, not a code change.

How a model is chosen:
  1. Each lane has an ordered chain in router.json (cheap first for build, strong first for spec).
  2. An entry is removed when: it failed earlier in this run, it shares the builder's family
     (review only), its CLI is not installed or not logged in, or its subscription quota is low
     or unknown (checked live, like jroute). Across models quota only removes, it never ranks,
     so a low quota never pushes work to a weaker model. Inside a list of routes to the same
     model, the route with the most quota left wins.
  3. Jev (optional, TYPESAFE_API_KEY) scores the ticket once and moves the START point along the
     remaining chain. Jev never names a model.
  4. A human override wins: run_dir/overrides.json ({"code": "claude:claude-opus-5-5"}, set with
     ff route <ticket> --set code=claude:claude-opus-5-5) replaces the choice for that agent.
     Low quota only warns; a CLI that is missing or not logged in stops the run. If the chosen
     model failed earlier in this run, the normal chain takes over.
Every removed entry and the reason are printed to stderr.

Logins are found in this order: the CLI's own login file (under AUTH_HOME, default $HOME), an
API key or token in the environment (config.env, set with ff login KEY), or the CLI's own login
check command.
"""
import hashlib, json, os, re, shutil, subprocess, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get("ROUTER_CONFIG", HERE / "router.json"))
AUTH_HOME = Path(os.environ.get("AUTH_HOME", Path.home()))
DECISIONS = Path(os.environ.get("DATA_DIR", HERE)) / "state" / "decisions.jsonl"


# ---- small helpers ----

def http_json(url, headers, data=None):
    body = json.dumps(data).encode() if data is not None else None
    with urllib.request.urlopen(urllib.request.Request(url, body, headers), timeout=15) as r:
        return json.loads(r.read())


def secret(rel_path, *keys):
    """Read a value out of a JSON login file under AUTH_HOME, or None."""
    try:
        value = json.loads((AUTH_HOME / rel_path).read_text())
        for k in keys:
            value = value[k]
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def split_entry(entry):
    """'codex:gpt-6.1-sol' -> ('codex', 'gpt-6.1-sol'). No prefix means pi."""
    cli, sep, model = entry.partition(":")
    return (cli, model) if sep else ("pi", entry)


def family(entry):
    """'opencode:opencode-go/glm-5.3' -> 'glm', 'claude:claude-opus-5-5' -> 'claude'."""
    return re.split(r"[-.]", split_entry(entry)[1].split("/")[-1])[0].lower()


# ---- quota: one class per subscription. Add a class and a QUOTAS entry to support another. ----

class Codex:
    """ChatGPT plan (codex CLI, or pi's openai-codex): 5h and 7d windows, per-model availability."""

    def probe(self):
        token = secret(".codex/auth.json", "tokens", "access_token") or secret(".pi/agent/auth.json", "openai-codex", "access")
        if not token:
            return None  # no subscription login: an OPENAI_API_KEY is metered, so no gate
        return http_json("https://chatgpt.com/backend-api/wham/usage",
                         {"Authorization": f"Bearer {token}", "User-Agent": "codex-cli"})

    def blocked(self, model, snap, gate):
        if snap is None:
            return None
        if isinstance(snap, Exception):
            return f"codex quota unknown ({snap})"
        rl = snap.get("rate_limit") or {}
        five = (rl.get("primary_window") or {}).get("used_percent") or 0
        week = (rl.get("secondary_window") or {}).get("used_percent") or 0
        if rl.get("limit_reached") or rl.get("allowed") is False:
            return "codex limit reached"
        if five >= gate.get("5h_max", 70):
            return f"codex 5h window {five}% used"
        if week >= gate.get("7d_max", 85):
            return f"codex 7d window {week}% used"
        name = model.split("/")[-1]
        if (snap.get("model_usage") or {}).get(name, {}).get("available") is False:
            return f"codex model {name} unavailable"
        return None

    def headroom(self, model, snap, gate):
        """Share of quota left before the gate, for the tighter of the 5h and 7d windows."""
        if not isinstance(snap, dict):
            return None
        rl = snap.get("rate_limit") or {}
        g5, g7 = gate.get("5h_max", 70), gate.get("7d_max", 85)
        five = (rl.get("primary_window") or {}).get("used_percent") or 0
        week = (rl.get("secondary_window") or {}).get("used_percent") or 0
        return max(0.0, min((g5 - five) / g5, (g7 - week) / g7))


class OpencodeGo:
    """Flat rate, no usage endpoint. Checks the live catalog, and meters the factory's own calls:
    gate "5h_budget" is how many calls you allow in 5 hours (set it to your plan's limit)."""

    def probe(self):
        key = secret(".local/share/opencode/auth.json", "opencode-go", "key") or secret(".pi/agent/auth.json", "opencode-go", "key")
        raw = http_json("https://opencode.ai/zen/go/v1/models", {"Authorization": f"Bearer {key}", "User-Agent": "Mozilla/5.0"})
        return {m["id"] for m in raw.get("data", [])}

    def blocked(self, model, snap, gate):
        name = model.split("/")[-1]
        if isinstance(snap, set) and name not in snap:
            return "not in the live opencode-go catalog"
        used, budget = recent_calls("opencode-go"), gate.get("5h_budget")
        if budget and used >= budget:
            return f"opencode-go used {used} of {budget} calls in 5h"
        return None

    def headroom(self, model, snap, gate):
        budget = gate.get("5h_budget")
        return max(0.0, 1 - recent_calls("opencode-go") / budget) if budget else None


class Cursor:
    """Cursor plan: 'auto' and 'api' buckets fill separately (jroute's rule)."""

    def probe(self):
        token = os.environ.get("CURSOR_AUTH_TOKEN")
        if not token and sys.platform == "darwin":
            token = subprocess.run(["security", "find-generic-password", "-s", "cursor-access-token", "-w"],
                                   capture_output=True, text=True, timeout=15).stdout.strip()
        if not token:
            return None if os.environ.get("CURSOR_API_KEY") else RuntimeError("no Cursor login")
        return http_json("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
                         {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                          "User-Agent": "cursor-agent/1.0"}, data={})

    def blocked(self, model, snap, gate):
        if snap is None:
            return None
        if isinstance(snap, Exception):
            return f"cursor quota unknown ({snap})"
        plan = snap.get("planUsage") or {}
        auto = model.lower() in {str(m).lower() for m in snap.get("autoBucketModels") or []}
        used = plan.get("autoPercentUsed" if auto else "apiPercentUsed") or 0
        if used >= gate.get("bucket_max", 85):
            return f"cursor {'auto' if auto else 'api'} bucket {used}% used"
        return None

    def headroom(self, model, snap, gate):
        if not isinstance(snap, dict):
            return None
        plan = snap.get("planUsage") or {}
        auto = model.lower() in {str(m).lower() for m in snap.get("autoBucketModels") or []}
        g = gate.get("bucket_max", 85)
        return max(0.0, (g - (plan.get("autoPercentUsed" if auto else "apiPercentUsed") or 0)) / g)


QUOTAS = {"codex": Codex(), "opencode-go": OpencodeGo(), "cursor": Cursor()}
UNKNOWN_HEADROOM = 0.5  # a route whose quota cannot be measured ranks in the middle


def recent_calls(quota, hours=5):
    """How many routing decisions used this quota in the last few hours (decisions.jsonl)."""
    import time
    since, n = time.time() - hours * 3600, 0
    try:
        for line in DECISIONS.read_text().splitlines():
            d = json.loads(line)
            n += d.get("quota") == quota and d.get("t", 0) >= since
    except (OSError, ValueError):
        pass
    return n


def headroom(entry, cfg, snaps):
    """Share of quota left for this route, 0..1. Unknown or metered routes rank in the middle."""
    cli, model = split_entry(entry)
    name = quota_name(cfg["clis"][cli], model)
    h = QUOTAS[name].headroom(model, snaps.get(name), cfg.get("gates", {}).get(name, {})) if name in QUOTAS else None
    return UNKNOWN_HEADROOM if h is None else h


def quota_name(cli_cfg, model):
    """A CLI names one quota, or maps model prefixes to quotas (pi reaches several)."""
    q = cli_cfg.get("quota")
    if isinstance(q, dict):
        return next((name for prefix, name in q.items() if model.startswith(prefix)), None)
    return q


def probe(names):
    """One live snapshot per quota. A failed probe is kept as the exception."""
    snaps = {}
    for name in names & QUOTAS.keys():
        try:
            snaps[name] = QUOTAS[name].probe()
        except Exception as exc:
            snaps[name] = exc
    return snaps


# ---- logins ----

def login_state(cli_cfg):
    """None if the CLI can be used, else why not."""
    binary = cli_cfg["command"].split()[0]
    if not shutil.which(binary):
        return f"{binary} not installed"
    if any((AUTH_HOME / p).exists() for p in cli_cfg.get("auth", [])):
        return None
    if any(os.environ.get(e) for e in cli_cfg.get("env", [])):
        return None
    check = cli_cfg.get("check")
    try:
        if check and subprocess.run(check, shell=True, capture_output=True, timeout=30).returncode == 0:
            return None
    except subprocess.TimeoutExpired:
        return f"{binary} login check timed out ({check})"
    return f"{binary} not logged in (no login file, no {' / '.join(cli_cfg.get('env', [])) or 'key'})"


# ---- Jev (optional) ----

JEV_QUESTIONS = {  # same questions as jroute
    "complexity": {"type": "score", "instructions": "How much reasoning does this task need?",
                   "criteria": ["trivial", "routine", "moderate", "hard", "frontier"]},
    "consequence": {"type": "noul", "instructions": "Would a wrong change be expensive to undo, or does it "
                    "touch production, security, money, or data loss?"},
}


def redact(text):
    """Ticket text leaves the machine for Jev: strip anything credential-shaped (from jroute)."""
    for pattern in [r"sk-[A-Za-z0-9_\-]{8,}", r"gh[pousr]_[A-Za-z0-9]{8,}", r"github_pat_[A-Za-z0-9_]+",
                    r"AKIA[0-9A-Z]{16}", r"AIza[A-Za-z0-9_\-]{20,}", r"xox[baprs]-[A-Za-z0-9\-]{10,}",
                    r"pk_[0-9]+_[A-Za-z0-9]{20,}", r"apikey_[A-Za-z0-9_]{20,}", r"Bearer\s+\S+",
                    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"]:
        text = re.sub(pattern, "<redacted>", text, flags=re.S)
    return text


def jev_answers(run_dir):
    """One Jev call per ticket text, cached in the run dir. None when Jev is not set up."""
    key = os.environ.get("TYPESAFE_API_KEY")
    ticket = run_dir / "ticket.md"
    if not key or not ticket.exists():
        return None
    text = redact(ticket.read_text()[:8000])
    sha = hashlib.sha256(text.encode()).hexdigest()
    cache = run_dir / "jev.json"
    if cache.exists():
        saved = json.loads(cache.read_text())
        if saved.get("sha") == sha:
            return saved["answers"]
    try:
        answers = http_json(os.environ.get("JEV_URL", "https://api.typesafe.ai/v1/systemone"),
                            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                            {"model": os.environ.get("JEV_MODEL", "jev-1.13.0"), "state": text,
                             "questions": JEV_QUESTIONS}).get("answers") or None
    except Exception as exc:  # Jev is optional: a miss means "start at the first entry"
        print(f"router: jev unavailable ({exc})", file=sys.stderr)
        return None
    cache.write_text(json.dumps({"sha": sha, "answers": answers}))
    return answers


def start_index(answers):
    """Hard or risky ticket -> skip the cheapest models. Unsure -> round up."""
    if not answers:
        return 0
    c = answers.get("complexity") or {}
    score = c.get("score") if isinstance(c.get("score"), (int, float)) else 0
    if (c.get("confidence") or 0) < 0.6:
        score += 1
    risk = (answers.get("consequence") or {}).get("noul") or 0
    if score >= 3 or risk > 0.7:
        return 2
    return 1 if score >= 2 else 0


# ---- routing ----

def skip_reason(entry, cfg, excluded, avoid, logins, snaps):
    """Why this chain entry is removed, or None if it can be used."""
    cli, model = split_entry(entry)
    if entry in excluded:
        return "failed earlier in this run"
    if family(entry) == avoid:
        return "same family as the builder"
    if cli not in cfg["clis"]:
        return f"unknown cli {cli!r} (add it under clis in router.json)"
    if logins[cli]:
        return logins[cli]
    name = quota_name(cfg["clis"][cli], model)
    return QUOTAS[name].blocked(model, snaps.get(name), cfg.get("gates", {}).get(name, {})) if name in QUOTAS else None


def route(lane, run_dir):
    cfg = json.loads(CONFIG.read_text())
    chain = cfg["lanes"][cfg.get("aliases", {}).get(lane, lane)]
    excluded = set((run_dir / "excluded.txt").read_text().split()) if (run_dir / "excluded.txt").exists() else set()
    # the reviewer and the judge never use the coder's model family
    avoid = (run_dir / "build_family.txt").read_text().strip() if lane in ("review", "judge") and (run_dir / "build_family.txt").exists() else ""

    override = overrides(run_dir).get(lane)
    if override and override not in excluded:
        return use_override(lane, override, cfg, run_dir)

    entries = [e for item in chain for e in (item if isinstance(item, list) else [item])]
    clis = {split_entry(e)[0] for e in entries}
    logins = {c: login_state(cfg["clis"][c]) for c in clis if c in cfg["clis"]}
    snaps = probe({quota_name(cfg["clis"][c], m) for c, m in map(split_entry, entries) if c in cfg["clis"] and not logins[c]})

    usable = []  # one route per chain position
    for item in chain:
        ok = []
        for entry in (item if isinstance(item, list) else [item]):
            reason = skip_reason(entry, cfg, excluded, avoid, logins, snaps)
            if reason:
                print(f"router: {lane}: skip {entry}: {reason}", file=sys.stderr)
            else:
                ok.append(entry)
        if ok:
            # Same model through different subscriptions: take the one with the most quota left.
            best = max(ok, key=lambda e: headroom(e, cfg, snaps))
            if len(ok) > 1:
                rest = ", ".join(f"{e} {headroom(e, cfg, snaps):.0%}" for e in ok if e != best)
                print(f"router: {lane}: chose {best} ({headroom(best, cfg, snaps):.0%} quota left) over {rest}", file=sys.stderr)
            usable.append(best)
    if not usable:
        sys.exit(f"router: no usable model for lane {lane}")

    start = 0 if lane in cfg.get("pinned", []) else start_index(jev_answers(run_dir))
    entry = usable[min(start, len(usable) - 1)]
    cli, model = split_entry(entry)
    c = cfg["clis"][cli]
    log_decision(lane, entry, quota_name(c, model), start, run_dir)
    return entry, c["command"].replace("{model}", model), family(entry), " ".join(c.get("auth", [])), " ".join(c.get("env", []))


def overrides(run_dir):
    try:
        return json.loads((run_dir / "overrides.json").read_text())
    except (OSError, ValueError):
        return {}


def use_override(lane, entry, cfg, run_dir):
    """The human's choice for this agent. Checked only for what would make it impossible to run."""
    cli, model = split_entry(entry)
    if cli not in cfg["clis"]:
        sys.exit(f"router: {lane}: override {entry}: unknown cli {cli!r}")
    if (why := login_state(cfg["clis"][cli])):
        sys.exit(f"router: {lane}: override {entry}: {why}")
    name = quota_name(cfg["clis"][cli], model)
    if name in QUOTAS:
        snap = probe({name}).get(name)
        if (why := QUOTAS[name].blocked(model, snap, cfg.get("gates", {}).get(name, {}))):
            print(f"router: {lane}: override {entry} used although {why}", file=sys.stderr)
    print(f"router: {lane}: override -> {entry} (set by you)", file=sys.stderr)
    c = cfg["clis"][cli]
    log_decision(lane, entry, name, "override", run_dir)
    return entry, c["command"].replace("{model}", model), family(entry), " ".join(c.get("auth", [])), " ".join(c.get("env", []))


def log_decision(lane, entry, quota, start, run_dir):
    """One line per routing decision (like jroute's decisions.jsonl). Also feeds the local meters."""
    if os.environ.get("ROUTER_DRY"):
        return
    import time
    DECISIONS.parent.mkdir(parents=True, exist_ok=True)
    with DECISIONS.open("a") as f:
        f.write(json.dumps({"t": int(time.time()), "ticket": run_dir.name, "agent": lane, "entry": entry,
                            "quota": quota, "start": start}) + "\n")


def status():
    """Human-readable: each CLI's login, then each quota."""
    cfg = json.loads(CONFIG.read_text())
    for name, c in cfg["clis"].items():
        print(f"  {name:9} {login_state(c) or 'ready'}")
    for name, snap in probe(set(QUOTAS)).items():
        if isinstance(snap, Exception):
            print(f"  quota {name}: unknown ({snap})")
        elif snap is None:
            print(f"  quota {name}: no subscription login (metered or not used)")
        elif name == "codex":
            rl = snap.get("rate_limit") or {}
            print(f"  quota codex: 5h {(rl.get('primary_window') or {}).get('used_percent')}%  7d {(rl.get('secondary_window') or {}).get('used_percent')}%")
        elif name == "cursor":
            p = snap.get("planUsage") or {}
            print(f"  quota cursor: auto {p.get('autoPercentUsed')}%  api {p.get('apiPercentUsed')}%")
        else:
            budget = (json.loads(CONFIG.read_text()).get("gates", {}).get(name) or {}).get("5h_budget")
            meter = f", {recent_calls(name)}/{budget} calls in 5h" if budget else ""
            print(f"  quota {name}: flat rate, {len(snap)} models in catalog{meter}")


if __name__ == "__main__":
    if sys.argv[1:] == ["status"]:
        status()
    elif len(sys.argv) == 3:
        # "-" marks an empty field, so the shell's tab split keeps every column
        print("\t".join(f or "-" for f in route(sys.argv[1], Path(sys.argv[2]))))
    else:
        sys.exit(__doc__)

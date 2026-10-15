#!/usr/bin/env python3
"""Send one ticket run to any OpenTelemetry backend (LangSmith, Langfuse, Phoenix, Jaeger, ...).

    otlp.py <ticket> <events.jsonl> <run_dir>      export the ticket's latest run
    otlp.py <ticket> <events.jsonl> <run_dir> --print   print the payload, send nothing
    otlp.py <ticket> <events.jsonl> <run_dir> --summary print a short table, send nothing

Settings (standard OTel variables):
    OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://api.smith.langchain.com/otel or http://localhost:4318
    OTEL_EXPORTER_OTLP_HEADERS    e.g. x-api-key=<key>,Langsmith-Project=software-factory

Trace shape: one root span per ticket run, one child span per agent step. Attributes follow the
OTel GenAI conventions (gen_ai.*), so backends show agent, CLI and model without extra setup.
Prompts and outputs are trimmed to MAX_TEXT characters.
"""
import json, os, secrets, sys, urllib.request
from pathlib import Path

MAX_TEXT = 4000


def attr(key, value):
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": str(value)}}


def ns(seconds):
    return str(int(seconds) * 1_000_000_000)


def tail(path, n=MAX_TEXT):
    try:
        return Path(path).read_text(errors="replace")[-n:]
    except OSError:
        return ""


def latest_run(ticket, events_file):
    """The events of this ticket's last run: from its last ticket_start to the end."""
    if not Path(events_file).exists():
        return []
    events = [json.loads(line) for line in Path(events_file).read_text().splitlines() if line.strip()]
    mine = [e for e in events if e.get("ticket") == ticket]
    starts = [i for i, e in enumerate(mine) if e["ev"] == "ticket_start"]
    return mine[starts[-1]:] if starts else []


def route_skips(run_dir, agent):
    """Why the router skipped models for this agent (from route.log)."""
    lines = tail(Path(run_dir) / "route.log", 20000).splitlines()
    return sorted({l.split(": ", 2)[2].removeprefix("skip ") for l in lines if l.startswith(f"router: {agent}: ")})


def build(ticket, events, run_dir):
    trace_id = secrets.token_hex(16)
    root_id = secrets.token_hex(8)
    start = events[0]
    end = next((e for e in reversed(events) if e["ev"] == "ticket_end"), events[-1])
    resumes = [i for i, e in enumerate(events) if e["ev"] == "ticket_resume"]
    failure = next((e["msg"] for e in events[resumes[-1] if resumes else 0:] if e["ev"] == "fail"), "")
    pr = next((e["msg"] for e in events if e["ev"] == "pr"), "")
    spans, open_steps = [], {}

    for e in events:
        key = (e["lane"], e["round"])
        if e["ev"] == "lane_start":
            open_steps[key] = e
        elif e["ev"] == "lane_end" and key in open_steps:
            s = open_steps.pop(key)
            agent, rnd, entry = e["lane"], e["round"], s["msg"]
            cli, _, model = entry.rpartition(":")
            ok = e["msg"] == "0"
            prompts = sorted(Path(run_dir, "steps").glob(f"factory-{ticket}-{agent}-{rnd}-*.sh.prompt"))
            attrs = [attr("gen_ai.operation.name", "invoke_agent"), attr("gen_ai.agent.name", agent),
                     attr("gen_ai.provider.name", cli or "pi"), attr("gen_ai.request.model", model),
                     attr("factory.round", rnd), attr("factory.exit_code", int(e["msg"] or 0)),
                     attr("session.id", ticket),
                     attr("input.value", tail(prompts[-1]) if prompts else ""),
                     attr("output.value", tail(Path(run_dir) / f"{agent}-{rnd}.log"))]
            skips = route_skips(run_dir, agent)
            if skips:
                attrs.append(attr("factory.router.skipped", "; ".join(skips)))
            verdict = next((v["msg"] for v in events if v["ev"] == "verdict" and v["round"] == rnd and agent == "review"), "")
            if verdict:
                attrs.append(attr("factory.review.verdict", verdict))
            spans.append({"traceId": trace_id, "spanId": secrets.token_hex(8), "parentSpanId": root_id,
                          "name": f"{agent}" + (f" #{rnd}" if agent in ("review", "fix") else ""),
                          "kind": 1, "startTimeUnixNano": ns(s["t"]), "endTimeUnixNano": ns(e["t"]),
                          "attributes": attrs, "status": {"code": 1 if ok else 2}})

    root_attrs = [attr("factory.ticket", ticket), attr("factory.title", start["msg"]), attr("session.id", ticket),
                  attr("gen_ai.operation.name", "workflow"), attr("input.value", tail(Path(run_dir) / "ticket.md"))]
    if pr:
        root_attrs.append(attr("factory.pr", pr))
    if failure:
        root_attrs.append(attr("factory.failure", failure))
    spans.insert(0, {"traceId": trace_id, "spanId": root_id, "name": f"ticket {ticket}", "kind": 1,
                     "startTimeUnixNano": ns(start["t"]), "endTimeUnixNano": ns(end["t"]),
                     "attributes": root_attrs, "status": {"code": 2 if failure else 1}})
    return {"resourceSpans": [{"resource": {"attributes": [attr("service.name", "software-factory")]},
                               "scopeSpans": [{"scope": {"name": "software-factory"}, "spans": spans}]}]}


def summary(payload):
    spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
    for sp in spans:
        a = {x["key"]: next(iter(x["value"].values())) for x in sp["attributes"]}
        secs = (int(sp["endTimeUnixNano"]) - int(sp["startTimeUnixNano"])) // 1_000_000_000
        mark = "ok  " if sp["status"]["code"] == 1 else "FAIL"
        who = f'{a.get("gen_ai.provider.name", "")} {a.get("gen_ai.request.model", "")}'.strip()
        extra = " ".join(x for x in (a.get("factory.review.verdict", ""), a.get("factory.pr", ""), a.get("factory.failure", "")) if x)
        print(f"{mark} {sp['name']:<16} {secs:>5}s  {who:<40} {extra}")
        if a.get("factory.router.skipped"):
            print(f"       skipped: {a['factory.router.skipped']}")


def send(payload):
    endpoint = os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"].rstrip("/")
    headers = {"Content-Type": "application/json"}
    for pair in filter(None, os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "").split(",")):
        k, _, v = pair.partition("=")
        headers[k.strip()] = v.strip()
    req = urllib.request.Request(f"{endpoint}/v1/traces", json.dumps(payload).encode(), headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    events = latest_run(sys.argv[1], sys.argv[2])
    if not events:
        sys.exit(f"no run found for {sys.argv[1]}. Start one with: ff run {sys.argv[1]}")
    payload = build(sys.argv[1], events, sys.argv[3])
    if "--summary" in sys.argv:
        summary(payload)
    elif "--print" in sys.argv:
        print(json.dumps(payload, indent=2))
    else:
        print(f"otlp: sent {len(payload['resourceSpans'][0]['scopeSpans'][0]['spans'])} spans, HTTP {send(payload)}")

// The dashboard server: who may call it, and what the API does.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Factory } from "../src/host.ts";
import { _test, startServer } from "../src/server.ts";
import { FakeGitHost, FakeTracker, fauxAgents, here, lanes, scratchRepo, testConfig } from "./support.ts";

describe("server", { timeout: 60_000 }, () => {
	let factory: Factory;
	let url: string;
	let token: string;
	let close: () => Promise<void>;
	let root: string;

	before(async () => {
		const w = await scratchRepo();
		root = w.root;
		const config = testConfig(w.repo, w.data, { DASH_PORT: "0" });
		const { models } = fauxAgents({ coderSleep: 3 });
		factory = await Factory.open({ config, models, lanes, tracker: new FakeTracker(), gitHost: new FakeGitHost(), sentry: null, log: () => {}, gatePollMs: 50, admitPollMs: 50 });
		const started = await startServer(factory, { dashboardFile: join(here, "durable", "dashboard", "index.html"), tokenFile: join(w.data, "state", "dash.token") });
		url = started.url;
		token = started.token;
		close = async () => {
			started.server.closeAllConnections();
			await new Promise<void>((r) => started.server.close(() => r()));
		};
	});
	after(async () => {
		await close();
		await factory.close();
		await rm(root, { recursive: true, force: true });
	});

	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Factory-Token": token, ...headers }, body: JSON.stringify(body) });

	it("serves the page with this start's token, and the token file is private", async () => {
		const page = await (await fetch(url)).text();
		assert.ok(page.includes(`const TOKEN = "${token}"`));
		const file = await readFile(join(root, "data", "state", "dash.token"), "utf8");
		assert.equal(file, token);
	});

	it("refuses an unknown Host (DNS rebinding) and a POST without the token (cross-site)", async () => {
		// fetch ignores a Host header, so this one goes through node:http.
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(`${url}/api/overview`, { headers: { Host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 421);
		const noToken = await fetch(`${url}/api/tickets/T-1/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		assert.equal(noToken.status, 403);
		const wrong = await post("/api/tickets/T-1/start", {}, { "X-Factory-Token": "nope" });
		assert.equal(wrong.status, 403);
		const form = await fetch(`${url}/api/tickets/T-1/start`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Factory-Token": token }, body: "{}" });
		assert.equal(form.status, 415);
	});

	it("starts a ticket, streams its running step, takes a steer, and stops it", async () => {
		const started = await (await post("/api/tickets/T-9/start", { gate: false })).json();
		assert.equal(started.started, true);
		for (let i = 0; i < 400; i++) {
			const t = (await (await fetch(`${url}/api/tickets/T-9`)).json()).ticket;
			if (t.steps.some((s: { name: string }) => s.name === "code-1-1")) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const controller = new AbortController();
		const events = await fetch(`${url}/api/tickets/T-9/events`, { signal: controller.signal });
		assert.equal(events.headers.get("content-type"), "text/event-stream");
		const reader = events.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		assert.match(first, /"type":"step","step":"code-1-1"/);
		controller.abort();
		const steer = await (await post("/api/tickets/T-9/steer", { text: "Use pnpm" })).json();
		assert.equal(steer.step, "code-1-1");
		const bad = await post("/api/tickets/T-9/steer", { text: "" });
		assert.equal(bad.status, 400);
		const paused = await post("/api/tickets/T-9/pause", {});
		assert.equal(paused.status, 200);
		assert.equal((await paused.json()).paused.reason, "you");
		assert.equal((await post("/api/tickets/T-9/resume", {})).status, 200);
		assert.equal((await post("/api/tickets/T-9/resume", {})).status, 409, "not paused");
		const detail = await (await fetch(`${url}/api/tickets/T-9`)).json();
		assert.equal(detail.phases[0].phase, "start");
		assert.ok(detail.ticket.events.some((e: { text: string }) => /^Paused by you/.test(e.text)));
		assert.ok(detail.ticket.steps.every((s: { usage: unknown }) => s.usage !== undefined), "running steps report their usage so far");
		assert.equal((await post("/api/tickets/T-9/stop", {})).status, 200);
		for (let i = 0; i < 200 && (await factory.ticket("T-9"))?.state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal((await factory.ticket("T-9"))?.state, "stopped");
		const overview = await (await fetch(`${url}/api/overview`)).json();
		assert.equal(overview.tickets[0].id, "T-9");
		assert.equal(overview.sentry.configured, false);
		assert.equal(overview.usage.limits.rpm, 50);
		assert.ok(overview.usage.today.total.requests > 0, "the agents' requests were counted");
		assert.equal((await post("/api/tickets/T-9/pause", {})).status, 409, "a stopped ticket cannot pause");
	});

	it("streams a tool call as the model writes it: the start, each argument delta, and the call in flight for a late viewer", () => {
		const { compact } = _test;
		const update = compact({ type: "message_update", changes: [
			{ type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "c1", name: "write", arguments: { path: "/run/spec.md" } } },
			{ type: "toolcall_delta", contentIndex: 1, path: ["content"], delta: "# Spec\n" },
		] } as never);
		assert.deepEqual(update, { type: "delta", text: "", calls: [
			{ type: "call_start", index: 1, name: "write", args: { path: "/run/spec.md" } },
			{ type: "call_delta", index: 1, path: ["content"], delta: "# Spec\n" },
		] });
		const snapshot = compact({ type: "snapshot", entries: [], generation: { attempt: 1, message: { content: [{ type: "text", text: "Writing it." }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "/run/spec.md", content: "# Spec\nAC-1" } }] } }, tools: [], nestedTools: [], compactions: [], inbox: [] } as never);
		assert.deepEqual((snapshot as { calls: unknown }).calls, [{ index: 1, name: "write", args: { path: "/run/spec.md", content: "# Spec\nAC-1" } }]);
		assert.equal(compact({ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: "hm" }] } as never), null, "nothing to show");
	});

	it("streams the dashboard's state: the overview, and the open ticket, as soon as they change", async () => {
		const controller = new AbortController();
		const res = await fetch(`${url}/api/stream?ticket=T-9`, { signal: controller.signal });
		assert.equal(res.headers.get("content-type"), "text/event-stream");
		const reader = res.body!.getReader();
		let text = "";
		while (!(text.includes("event: overview") && text.includes("event: ticket"))) text += new TextDecoder().decode((await reader.read()).value);
		controller.abort();
		const overview = JSON.parse(/event: overview\ndata: (.*)\n/.exec(text)![1]!);
		const ticket = JSON.parse(/event: ticket\ndata: (.*)\n/.exec(text)![1]!);
		assert.ok(Array.isArray(overview.tickets));
		assert.equal(ticket.ticket.id, "T-9");
		assert.equal((await fetch(`${url}/api/stream?ticket=..%2Fx`)).status, 400);
	});

	it("rejects bad ids and unknown routes", async () => {
		assert.equal((await post("/api/tickets/..%2F..%2Fetc/start", {})).status, 400);
		assert.equal((await fetch(`${url}/api/nope`)).status, 404);
		assert.equal((await fetch(`${url}/api/tickets/UNKNOWN`)).status, 404);
	});

	it("will not listen beyond loopback without a password", async () => {
		const config = { ...factory.deps.config, dash: { ...factory.deps.config.dash, host: "0.0.0.0", password: "" } };
		const fake = { deps: { ...factory.deps, config } } as unknown as Factory;
		await assert.rejects(startServer(fake, { dashboardFile: join(here, "durable", "dashboard", "index.html"), tokenFile: join(root, "x.token") }), /set DASH_PASSWORD/);
	});
});

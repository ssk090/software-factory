// The dashboard and the API the CLI uses, served by the process that owns the session (examples
// 19-json, 20-inbox, 21-late-join, 24-child-tasks): tickets, your sprint and production issues, a live
// stream of any agent step (a late client gets the current state first), steering, and the task graph.
//
// Safety: it listens on 127.0.0.1 by default. Requests must name an allowed Host (no DNS rebinding),
// and every POST carries the token this start wrote to state/dash.token (no cross-site requests: a
// page elsewhere cannot read it). Listening on another address requires DASH_PASSWORD (basic auth).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEvent, AssistantEntry, type ConversationId, watchEvents } from "@earendil-works/pi-durable";
import type { Ticket } from "./docs.ts";
import type { Factory } from "./host.ts";
import { PHASES } from "./pipeline.ts";
import { score } from "./sentry.ts";

const context = BACKGROUND_CONTEXT;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY = 64 * 1024;
/** How often the state stream looks for a change. */
const STREAM_MS = 400;

class HttpFail extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const same = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpFail(415, "send application/json");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpFail(413, "body too large");
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	const parsed = JSON.parse(text) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpFail(400, "send a JSON object");
	return parsed as Record<string, unknown>;
}

const str = (value: unknown, name: string, max = 20_000): string => {
	if (typeof value !== "string" || value.trim() === "") throw new HttpFail(400, `${name} is required`);
	if (value.length > max) throw new HttpFail(400, `${name} is too long`);
	return value;
};
const id = (value: string) => {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpFail(400, "bad id");
	return value;
};

/** A run folder file for the dashboard: only known names, bounded. */
async function runFile(ticket: Ticket, name: string): Promise<string | null> {
	if (ticket.run === null || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
	const text = await readFile(join(ticket.run, name), "utf8").catch(() => null);
	return text === null ? null : text.length > 200_000 ? `${text.slice(0, 200_000)}\n…(cut)` : text;
}

/** The compact live events the dashboard draws: text, tool calls and their output, steers. */
function compact(event: AgentEvent): Record<string, unknown> | null {
	switch (event.type) {
		case "snapshot": {
			type Shown = { kind: string; text?: string; name?: string; args?: string };
			const entries = event.entries.flatMap((entry): Shown[] => {
				if (AssistantEntry.is(entry)) {
					const message = entry.model?.[0] as { content?: { type: string; text?: string; name?: string; arguments?: unknown }[] } | undefined;
					return (message?.content ?? []).flatMap((part): Shown[] =>
						part.type === "text" && part.text ? [{ kind: "text", text: part.text }] : part.type === "toolCall" ? [{ kind: "tool", name: part.name, args: JSON.stringify(part.arguments ?? {}).slice(0, 500) }] : [],
					);
				}
				if (entry.kind === "pi.user") {
					const message = entry.model?.[0] as { content?: unknown } | undefined;
					const text = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
					return [{ kind: "user", text: text.slice(0, 4000) }];
				}
				return [];
			});
			// A tool call the model is still writing: a late viewer of a live document starts from it.
			const partial = event.generation?.message as { content?: { type: string; name?: string; arguments?: unknown }[] } | undefined;
			const calls = (partial?.content ?? []).flatMap((part, index) => (part.type === "toolCall" ? [{ index, name: part.name, args: part.arguments ?? {} }] : []));
			return { type: "snapshot", entries, running: event.run !== undefined, calls };
		}
		case "message_update": {
			const text = event.changes.flatMap((c) => (c.type === "text_delta" ? [c.delta] : [])).join("");
			// Tool calls as the model writes them: the start (name, arguments so far) and each argument delta
			// by its path, so the dashboard can show a file the agent is writing as it is written.
			const calls = event.changes.flatMap((c): Record<string, unknown>[] => {
				if (c.type === "toolcall_start") {
					const block = c.block as { type?: string; name?: string; arguments?: unknown };
					return block.type === "toolCall" ? [{ type: "call_start", index: c.contentIndex, name: block.name, args: block.arguments ?? {} }] : [];
				}
				return c.type === "toolcall_delta" ? [{ type: "call_delta", index: c.contentIndex, path: c.path, delta: c.delta }] : [];
			});
			return text || calls.length > 0 ? { type: "delta", text, calls } : null;
		}
		case "message_end": {
			if (!AssistantEntry.is(event.entry)) return null;
			const message = event.entry.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
			const text = (message?.content ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("");
			return { type: "text", text };
		}
		case "tool_execution_start":
			return event.parentToolCallId ? null : { type: "tool", name: event.toolName, args: JSON.stringify(event.args).slice(0, 2000) };
		case "tool_execution_update": {
			if (event.parentToolCallId || event.output === undefined) return null;
			const out = "set" in event.output ? event.output.set : (event.output.append ?? "");
			return out ? { type: "output", text: out.slice(-4000) } : null;
		}
		case "tool_execution_end":
			return event.parentToolCallId ? null : { type: "tool_end", name: event.toolName };
		case "submission":
			return event.record.type === "input" && event.record.status === "placed" ? { type: "placed" } : null;
		case "run_end":
			return { type: "run_end" };
		case "auto_retry_start":
			return { type: "retry", attempt: event.attempt, error: event.errorMessage.slice(0, 500) };
		default:
			return null;
	}
}

export const _test = { compact };

export async function startServer(factory: Factory, options: { dashboardFile: string; tokenFile: string }): Promise<{ server: Server; url: string; token: string }> {
	const { dash } = factory.deps.config;
	const loopback = LOOPBACK.has(dash.host);
	if (!loopback && dash.password === "") throw new Error(`DASH_HOST=${dash.host} is not loopback: set DASH_PASSWORD too`);
	const token = randomBytes(24).toString("base64url");
	await writeFile(options.tokenFile, token, { mode: 0o600 });
	const allowed = new Set([...LOOPBACK, ...dash.allowedHosts.map((h) => h.toLowerCase())]);
	const page = await readFile(options.dashboardFile, "utf8");
	// The one script the page loads from here: the Mermaid bundle, read when first asked for.
	const mermaidFile = join(dirname(options.dashboardFile), "vendor", "mermaid.min.js");
	let mermaid: Buffer | null = null;

	const authorized = (req: IncomingMessage) => {
		const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		if (!allowed.has(host)) throw new HttpFail(421, "unknown Host");
		if (dash.password !== "") {
			const auth = req.headers.authorization ?? "";
			const given = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":") : "";
			if (!same(given, dash.password)) throw new HttpFail(401, "password required");
		}
		if (req.method === "POST" && !same(String(req.headers["x-factory-token"] ?? ""), token)) throw new HttpFail(403, "missing or wrong X-Factory-Token");
	};

	const json = (res: ServerResponse, status: number, value: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(value));
	};

	const route = async (req: IncomingMessage, res: ServerResponse) => {
		authorized(req);
		const url = new URL(req.url ?? "/", "http://dashboard");
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const method = req.method ?? "GET";
		if (method === "GET" && url.pathname === "/") {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
				"X-Frame-Options": "DENY",
				"Referrer-Policy": "no-referrer",
			});
			res.end(page.replace("__FACTORY_TOKEN__", token));
			return;
		}
		if (method === "GET" && url.pathname === "/vendor/mermaid.min.js") {
			mermaid ??= await readFile(mermaidFile);
			res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff" });
			res.end(mermaid);
			return;
		}
		if (parts[0] !== "api") throw new HttpFail(404, "not found");
		const [, area, key, action] = parts;

		if (method === "GET" && area === "overview") return json(res, 200, await overview());
		if (method === "GET" && area === "stream") return state(res, url);
		if (method === "GET" && area === "sprint") {
			try {
				return json(res, 200, await factory.sprint(url.searchParams.get("refresh") === "1"));
			} catch (error) {
				return json(res, 200, { error: error instanceof Error ? error.message : String(error) });
			}
		}
		if (method === "GET" && area === "graph") return json(res, 200, await factory.graph());
		if (area === "tickets" && key !== undefined) {
			const ticketId = id(key);
			if (method === "GET" && action === undefined) {
				const detail = await ticketDetail(ticketId);
				if (detail === null) throw new HttpFail(404, "unknown ticket");
				return json(res, 200, detail);
			}
			if (method === "GET" && action === "events") return stream(res, url, ticketId);
			if (method === "POST") {
				const input = await body(req);
				if (action === "start") {
					return json(res, 200, await factory.start(ticketId, { gate: input.gate !== false, build: input.build === true, fresh: input.fresh === true }));
				}
				if (action === "approve") return json(res, 200, await factory.approve(ticketId, typeof input.note === "string" ? input.note.slice(0, 20_000) : ""));
				if (action === "stop") return json(res, 200, (await factory.stop(ticketId), { ok: true }));
				// Not running, not paused, or the budget is spent: the request conflicts with the ticket's state.
				const conflict = (error: unknown): never => {
					throw new HttpFail(409, error instanceof Error ? error.message : String(error));
				};
				if (action === "pause") return json(res, 200, await factory.pause(ticketId).catch(conflict));
				if (action === "forget") return json(res, 200, await factory.forget(ticketId).catch(conflict));
				if (action === "revise") {
					const file = str(input.file, "file", 20);
					const comment = str(input.comment, "comment", 4000);
					return json(res, 200, await factory.revise(ticketId, { file, quote: typeof input.quote === "string" ? input.quote : "", comment }).catch(conflict));
				}
				if (action === "resume") return json(res, 200, await factory.resume(ticketId).catch(conflict));
				if (action === "steer") return json(res, 200, await factory.steer(ticketId, str(input.text, "text")));
			}
		}
		if (area === "sentry" && method === "POST") {
			await body(req);
			if (key === "sync" && action === undefined) return json(res, 200, await factory.syncSentry());
			if (key !== undefined && action === "fix") return json(res, 200, await factory.fixIssue(id(key)));
			if (key !== undefined && action === "dismiss") return json(res, 200, (await factory.triage(id(key), "dismissed"), { ok: true }));
			if (key !== undefined && action === "restore") return json(res, 200, (await factory.triage(id(key), "new"), { ok: true }));
		}
		if (area === "gc" && method === "POST") {
			await body(req);
			return json(res, 200, { removed: await factory.gc() });
		}
		throw new HttpFail(404, "not found");
	};

	/** What the dashboard shows: every ticket, the Sentry inbox, the spend. */
	const overview = async () => {
		const tickets = await factory.tickets();
		const inbox = await factory.inbox();
		const issues = Object.values(inbox.issues).map((i) => ({ ...i, score: score(i) })).sort((a, b) => b.score - a.score || b.lastSeen.localeCompare(a.lastSeen));
		const { config } = factory.deps;
		return {
			tickets,
			sentry: { configured: config.sentry.token !== "" && config.sentry.org !== "", environment: inbox.environment || config.sentry.environment, lastSync: inbox.lastSync, lastError: inbox.lastError, issues },
			sprintConfigured: config.clickup.sprintListId !== "" || config.clickup.sprintFolderId !== "",
			specGate: config.specGate,
			usage: factory.usage(),
			phases: PHASES,
		};
	};
	/** One ticket with its run folder files and its steps' usage so far, or null. */
	const ticketDetail = async (ticketId: string) => {
		const ticket = await factory.ticket(ticketId);
		if (ticket === undefined) return null;
		const files: Record<string, string | null> = {};
		const logs = ["route.log", "guard.log", "skills.log", "setup.log", ...ticket.verify.map((v) => v.log)];
		for (const name of ["spec.md", "plan.md", "tests.md", "blocked.md", "verify-failed.md", "judge.txt", ...ticket.reviews.map((r) => r.file), ...logs]) files[name] = await runFile(ticket, name);
		// A running step's usage so far (an ended step carries its own).
		const steps = await Promise.all((ticket.steps ?? []).map(async (s) => (s.usage == null ? { ...s, usage: await factory.stepUsage(s.conversationId) } : s)));
		return { ticket: { ...ticket, steps, events: ticket.events ?? [], paused: ticket.paused ?? null }, files, phases: PHASES };
	};
	/**
	 * The dashboard's state as server-sent events: the overview, and the ticket named by ?ticket=,
	 * each sent first and then again whenever it changes (checked every STREAM_MS here, where it is
	 * cheap, instead of the browser polling).
	 */
	const state = async (res: ServerResponse, url: URL) => {
		const wanted = url.searchParams.get("ticket");
		const ticketId = wanted === null || wanted === "" ? null : id(wanted);
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
		let last = { overview: "", ticket: "" };
		let busy = false;
		let open = true;
		const tick = async () => {
			if (busy || !open) return;
			busy = true;
			try {
				const o = JSON.stringify(await overview());
				if (o !== last.overview) res.write(`event: overview\ndata: ${o}\n\n`);
				last.overview = o;
				if (ticketId !== null) {
					const detail = await ticketDetail(ticketId);
					const t = JSON.stringify(detail ?? { error: "unknown ticket" });
					if (t !== last.ticket) res.write(`event: ticket\ndata: ${t}\n\n`);
					last.ticket = t;
				}
			} catch {
				// a closing session: the next tick or the reconnect tries again
			} finally {
				busy = false;
			}
		};
		await tick();
		const timer = setInterval(() => void tick(), STREAM_MS);
		const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
		res.on("close", () => {
			open = false;
			clearInterval(timer);
			clearInterval(ping);
			last = { overview: "", ticket: "" };
		});
	};

	/** Server-sent events of one step conversation: the current state first, then each change. */
	const stream = async (res: ServerResponse, url: URL, ticketId: string) => {
		const ticket = await factory.ticket(ticketId);
		const wanted = url.searchParams.get("conversation");
		const step = wanted === null ? ticket?.steps.findLast((s) => s.status === "running") ?? ticket?.steps.at(-1) : ticket?.steps.find((s) => String(s.conversationId) === wanted);
		if (step === undefined) throw new HttpFail(404, "no step to watch");
		const events = await watchEvents(factory.harness, step.conversationId as ConversationId, context);
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
		const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
		send({ type: "step", step: step.name, model: step.model, status: step.status });
		const first = compact(events.snapshot);
		if (first) send(first);
		events.start(async (batch) => {
			for (const event of batch) {
				const out = compact(event);
				if (out) send(out);
			}
		});
		const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
		res.on("close", () => {
			clearInterval(ping);
			void events.stop();
		});
	};

	const server = createServer((req, res) => {
		route(req, res).catch((error: unknown) => {
			const status = error instanceof HttpFail ? error.status : error instanceof SyntaxError ? 400 : 500;
			if (!res.headersSent) json(res, status, { error: error instanceof Error ? error.message : String(error) });
			else res.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(dash.port, dash.host, () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : dash.port;
	// Where clients on this machine reach it: listening on every address includes loopback.
	const host = dash.host === "0.0.0.0" || dash.host === "::" ? "127.0.0.1" : dash.host;
	return { server, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`, token };
}

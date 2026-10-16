// ff: the software factory's command line. `ff serve` is the factory: one process that owns the
// session, runs every ticket and serves the dashboard. Other commands talk to it over its API (one
// process owns a Pi Durable session). `ff run` hosts a one-shot run itself when nothing is serving.
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { TaskId } from "@earendil-works/pi-durable";
import { type Config, loadConfig } from "./config.ts";
import type { Ticket } from "./docs.ts";
import { git, run, useOriginUrl } from "./git.ts";
import { GitHubCli } from "./github.ts";
import { Factory, type HostDeps } from "./host.ts";
import { requestJson } from "./http.ts";
import { chain, family, loadLanes, modelName, pickModel } from "./lanes.ts";
import { learnedVerify, lessons } from "./lessons.ts";
import { SentryClient } from "./sentry.ts";
import { type ThrottleStatus, usd } from "./throttle.ts";
import { startServer } from "./server.ts";
import { ClickUp } from "./tracker.ts";

const USAGE = `usage: ff <command>
  serve                      run the factory and its dashboard (DASH_HOST:DASH_PORT, default 127.0.0.1:8090)
  spec <ticket>              plan the spec, then wait for your approval (dashboard, ff approve, or S_APPROVED)
  run <ticket> [--fresh] [--gate] [--build]
                             the whole pipeline without the spec gate (--gate: with it; --build: from an approved spec)
  approve <ticket> [note]    approve a spec; the note goes to the coder
  steer <ticket> <message>   a message into the ticket's running agent step
  stop <ticket>              stop a ticket's pipeline (worktree and branch stay)
  pause <ticket>             pause a running ticket: it holds before its next phase and model request
  resume <ticket>            continue a paused ticket where it held
  status                     every ticket and what it is doing
  show <ticket>              one ticket: steps, files, PR
  logs <ticket>              everything that happened to a ticket, oldest first
  lessons                    what the coordinator learned from failures (state/lessons.md)
  usage                      today's model spend and the rate limits
  sentry [sync]              production issues, by Fix first (sync: ask Sentry now)
  fix <sentry issue id>      make a ticket from a Sentry issue and plan its spec
  sprint                     your tasks in the current ClickUp sprint
  gc [days]                  remove worktrees of merged or closed PRs, or idle ones
  doctor                     check everything a run needs
  health                     exit 0 when the factory serves (container healthcheck)
  login [KEY]                save a key in config.env (hidden input) and show the model logins
  whoami                     your ClickUp user and team ids`;

const ticketArg = (args: string[]) => {
	const ref = args.find((a) => !a.startsWith("--"));
	if (!ref) fail(USAGE);
	return ref;
};

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function deps(config: Config, extra: Partial<HostDeps> = {}): Promise<HostDeps> {
	return loadLanes(process.env.LANES_FILE || join(config.here, "durable", "lanes.json")).then((lanes) => ({
		config,
		models: builtinModels(),
		lanes,
		tracker: new ClickUp(config),
		gitHost: new GitHubCli(),
		sentry: config.sentry.token && config.sentry.org ? new SentryClient(config.sentry) : null,
		...extra,
	}));
}

/** The serving factory, if one is up: its URL and token (written by ff serve). */
async function server(config: Config): Promise<{ url: string; token: string } | null> {
	try {
		const pid = Number((await readFile(join(config.stateDir, "factory.pid"), "utf8")).trim());
		process.kill(pid, 0);
		const url = (await readFile(join(config.stateDir, "dash.url"), "utf8")).trim();
		const token = (await readFile(join(config.stateDir, "dash.token"), "utf8")).trim();
		return { url, token };
	} catch {
		return null;
	}
}

async function call<T>(config: Config, path: string, body?: unknown): Promise<T> {
	const up = await server(config);
	if (up === null) fail("no factory is serving: start it with ff serve");
	const headers: Record<string, string> = { "X-Factory-Token": up.token };
	if (config.dash.password) headers.Authorization = `Basic ${Buffer.from(`ff:${config.dash.password}`).toString("base64")}`;
	try {
		return (await requestJson<T>(body === undefined ? "GET" : "POST", `${up.url}${path}`, { headers, body, tries: 1, timeoutMs: 120_000 })).data;
	} catch (error) {
		fail(error instanceof Error ? error.message.replace(/^HTTP \d+ from \S+: /, "") : String(error));
	}
}

const line = (t: Ticket) => {
	const step = t.steps.findLast((s) => s.status === "running");
	const state = t.paused ? "paused" : t.state;
	return `${t.cid.padEnd(12)} ${state.padEnd(17)} ${t.phase.padEnd(12)} ${(step?.name ?? "").padEnd(16)} ${t.pr ?? ""}${t.blocked ? `  ${t.blocked}` : ""}`;
};

async function serve(config: Config) {
	const factory = await Factory.open(await deps(config));
	const { server: http, url } = await startServer(factory, {
		dashboardFile: join(config.here, "durable", "dashboard", "index.html"),
		tokenFile: join(config.stateDir, "dash.token"),
	});
	await writeFile(join(config.stateDir, "dash.url"), url);
	console.log(`factory up: dashboard ${url}  (data ${config.dataDir}, sandbox ${config.sandbox}, up to ${config.maxParallel} tickets at once)`);
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) process.exit(130);
		stopping = true;
		console.log(`${signal}: stopping; every ticket continues from its checkpoint on the next ff serve`);
		http.close();
		http.closeAllConnections();
		await factory.close();
		process.exit(0);
	};
	for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => void stop(s));
}

/** ff run / ff spec: through the serving factory, or hosted here until the ticket stops or waits. */
async function runTicket(config: Config, args: string[], gate: boolean) {
	const ref = ticketArg(args);
	const options = { gate: gate || args.includes("--gate"), build: args.includes("--build"), fresh: args.includes("--fresh") };
	if ((await server(config)) !== null) {
		const r = await call<{ ticketId: string; started: boolean }>(config, `/api/tickets/${encodeURIComponent(ref)}/start`, options);
		console.log(r.started ? `started ${ref}: follow it on the dashboard or with ff show ${ref}` : `${ref} is already running`);
		return;
	}
	const factory = await Factory.open(await deps(config));
	let done = false;
	const stop = async () => {
		if (done) process.exit(130);
		done = true;
		console.log(`stopped. ff run ${ref} (or ff serve) continues where it stopped`);
		await factory.close();
		process.exit(130);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
	try {
		const { ticketId } = await factory.start(ref, options);
		let last = "";
		for (;;) {
			const t = (await factory.ticket(ticketId))!;
			const now = line(t);
			if (now !== last) console.log(`${new Date().toISOString().slice(11, 19)} ${now}`);
			last = now;
			if (t.state === "waiting_approval") {
				console.log(`spec ready: ${t.run}/spec.md. Approve with: ff serve, then the dashboard or ff approve ${t.cid}`);
				break;
			}
			if (t.taskId !== null && (await factory.harness.getTask(t.taskId as TaskId, BACKGROUND_CONTEXT))?.state.status === "terminal") break;
			await new Promise((r) => setTimeout(r, 1000));
		}
	} finally {
		done = true;
		await factory.close();
	}
}

/** Read-only commands: through the serving factory, or by opening the session without running anything. */
async function readOnly<T>(config: Config, viaServer: () => Promise<T>, local: (factory: Factory) => Promise<T>): Promise<T> {
	if ((await server(config)) !== null) return viaServer();
	const factory = await Factory.open(await deps(config, { readOnly: true }));
	try {
		return await local(factory);
	} finally {
		await factory.close();
	}
}

/** One line of config.env, quoted for the shell that sources it. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function login(config: Config, key?: string) {
	const file = process.env.FACTORY_CONFIG || join(config.here, "config.env");
	if (key !== undefined) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail("key names look like ANTHROPIC_API_KEY");
		const value = await hiddenInput(`Value for ${key} (hidden): `);
		const old = await readFile(file, "utf8").catch(() => "");
		const kept = old.split("\n").filter((l) => !l.startsWith(`${key}=`) && l !== "");
		await writeFile(`${file}.tmp`, `${[...kept, `${key}=${shellQuote(value)}`].join("\n")}\n`, { mode: 0o600 });
		await rename(`${file}.tmp`, file);
		process.env[key] = value;
		console.log(`saved ${key} in ${file}`);
	}
	const lanes = await loadLanes(process.env.LANES_FILE || join(config.here, "durable", "lanes.json"));
	const models = builtinModels();
	const seen = new Set<string>();
	for (const entries of Object.values(lanes.lanes)) {
		for (const entry of entries) {
			const provider = entry.split("/")[0]!;
			if (seen.has(provider)) continue;
			seen.add(provider);
			console.log(`  ${provider.padEnd(12)} ${(await models.getAuth(provider)) ? "ready" : "no login"}`);
		}
	}
	console.log("  keys: the provider's API key, e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY (ff login <KEY>); also CLICKUP_TOKEN, SENTRY_AUTH_TOKEN, GH_TOKEN");
}

function hiddenInput(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
		out._writeToOutput = (s: string) => {
			if (s.includes(prompt)) out.output.write(prompt);
		};
		rl.question(prompt, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		});
	});
}

async function doctor(config: Config) {
	let bad = false;
	const ok = (s: string) => console.log(`  ok    ${s}`);
	const no = (s: string) => {
		console.log(`  FAIL  ${s}`);
		bad = true;
	};
	const warn = (s: string) => console.log(`  warn  ${s}`);
	for (const bin of ["git", "gh"]) ((await run(bin, ["--version"])).code === 0 ? ok(bin) : no(`${bin} not installed`));
	const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
	major > 22 || (major === 22 && minor >= 19) ? ok(`node ${process.versions.node}`) : no(`node ${process.versions.node}: Pi Durable needs 22.19 or newer`);
	if ((await git(config.repo, "rev-parse", "--git-dir")).code === 0) {
		ok(`REPO ${config.repo}`);
		(await git(config.repo, "ls-remote", "-q", "--exit-code", "origin", `refs/heads/${config.base}`)).code === 0
			? ok(`origin has branch ${config.base}`)
			: no(`origin has no branch ${config.base} (BASE), or origin is unreachable`);
	} else no(`REPO ${config.repo} is not a git repository`);
	const v = (await run("git", ["version"])).stdout.match(/(\d+)\.(\d+)/);
	const shadows = (await git(config.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/origin/")).stdout.trim();
	if (shadows) warn(`local branches named like remote ones (${shadows.split("\n").join(", ")}): they make origin/<branch> ambiguous; delete them once merged (git branch -d <name>)`);
	v && (Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 31)) ? ok(`git ${v[0]} (ticket guard hooks)`) : no("the ticket guard needs git 2.31 or newer");
	(await run("gh", ["auth", "status"])).code === 0 ? ok("gh logged in") : no("gh not logged in (gh auth login, or GH_TOKEN)");
	try {
		await requestJson("GET", "https://api.clickup.com/api/v2/user", { headers: { Authorization: config.clickup.token }, tries: 1 });
		ok("ClickUp reachable");
	} catch (error) {
		no(`ClickUp: ${error instanceof Error ? error.message : error} (CLICKUP_TOKEN)`);
	}
	if (config.clickup.sprintListId || config.clickup.sprintFolderId) {
		try {
			const s = await new ClickUp(config).currentSprint();
			ok(`sprint: ${s.name}`);
		} catch (error) {
			no(`sprint: ${error instanceof Error ? error.message : error}`);
		}
	} else warn("no sprint set (CLICKUP_SPRINT_FOLDER_ID or CLICKUP_SPRINT_LIST_ID): the dashboard's sprint tab is empty");
	if (config.sentry.token && config.sentry.org) {
		try {
			const { issues } = await new SentryClient({ ...config.sentry, maxPages: 1 }).issues();
			ok(`Sentry: ${issues.length} ${config.sentry.environment} issue(s) on the first page`);
		} catch (error) {
			no(`Sentry: ${error instanceof Error ? error.message : error}`);
		}
	} else warn("Sentry not set up (SENTRY_AUTH_TOKEN, SENTRY_ORG): no production issues on the dashboard");
	if (config.sandbox === "docker") {
		(await run("docker", ["info"])).code === 0 ? ok("docker") : no("Docker is not running (or set SANDBOX=none)");
		(await run("docker", ["image", "inspect", config.sandboxImage])).code === 0 ? ok(`sandbox image ${config.sandboxImage}`) : no(`no image ${config.sandboxImage}: docker build -t ${config.sandboxImage} .`);
	} else warn("SANDBOX=none: agents' commands run unconfined on this machine");
	const lanes = await loadLanes(process.env.LANES_FILE || join(config.here, "durable", "lanes.json"));
	const models = builtinModels();
	let coder: string | null = null;
	for (const role of ["spec", "plan", "test", "code", "review", "fix", "judge"]) {
		const { model } = await pickModel({ lanes, models, role, attempt: 1, avoidFamily: null, skip: () => null });
		if (model === null) {
			no(`${role}: no usable model in ${chain(lanes, role).map(modelName).join(", ") || "its lane"} (ff login)`);
			continue;
		}
		if (role === "code") coder = family(model);
		const other = coder !== null && (role === "review" || role === "judge") ? (await pickModel({ lanes, models, role, attempt: 1, avoidFamily: coder, skip: () => null })).model : model;
		if (other === null) warn(`${role}: only ${modelName(model)} has a login, the coder's own family (${coder}): set another provider's key so code is reviewed by another family`);
		else ok(`${role}: ${modelName(other)}`);
	}
	const learned = config.verifyCmd ? await learnedVerify(config.stateDir, config.verifyCmd) : null;
	if (learned) ok(`VERIFY_CMD runs as: ${learned} (learned by the coordinator, state/verify.json)`);
	const { rpm, tpm, dailyBudgetUsd } = config.limits;
	const limits = `model limits per provider: ${rpm || "no"} requests/min, ${tpm || "no"} tokens/min; daily budget ${dailyBudgetUsd > 0 ? usd(dailyBudgetUsd) : "none"}`;
	dailyBudgetUsd > 0 ? ok(limits) : warn(`${limits} (set DAILY_BUDGET_USD to cap spend)`);
	if (config.dash.host !== "127.0.0.1" && config.dash.host !== "localhost" && !config.dash.password) no(`DASH_HOST=${config.dash.host} needs DASH_PASSWORD`);
	const file = process.env.FACTORY_CONFIG || join(config.here, "config.env");
	const mode = await stat(file).then((s) => s.mode & 0o077, () => 0);
	if (mode !== 0) warn(`${file} holds secrets but others can read it (chmod 600)`);
	return bad ? 1 : 0;
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const config = loadConfig();
	useOriginUrl(config.originUrl);
	switch (command) {
		case "serve":
			return serve(config);
		case "spec":
			return runTicket(config, args, true);
		case "run":
			return runTicket(config, args, false);
		case "approve": {
			const ref = ticketArg(args);
			const t = await call<Ticket>(config, `/api/tickets/${encodeURIComponent(ref)}/approve`, { note: args.slice(1).join(" ") });
			return console.log(`approved ${t.cid}: the build continues`);
		}
		case "steer": {
			const ref = ticketArg(args);
			const text = args.slice(1).join(" ");
			if (!text.trim()) fail("usage: ff steer <ticket> <message>");
			const r = await call<{ step: string }>(config, `/api/tickets/${encodeURIComponent(ref)}/steer`, { text });
			return console.log(`sent to ${r.step}`);
		}
		case "stop": {
			const ref = ticketArg(args);
			await call(config, `/api/tickets/${encodeURIComponent(ref)}/stop`, {});
			return console.log(`stopping ${ref}`);
		}
		case "pause":
		case "resume": {
			const ref = ticketArg(args);
			const t = await call<Ticket>(config, `/api/tickets/${encodeURIComponent(ref)}/${command}`, {});
			return console.log(command === "pause" ? `paused ${t.cid}: ff resume ${t.cid} continues it` : `${t.cid} continues`);
		}
		case "logs": {
			const ref = ticketArg(args);
			const data = await readOnly(config, () => call<{ ticket: Ticket }>(config, `/api/tickets/${encodeURIComponent(ref)}`), async (f) => ({ ticket: (await f.ticket(ref)) ?? fail(`unknown ticket ${ref}`) }));
			for (const e of data.ticket.events ?? []) {
				const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
				console.log(`${when}  ${e.level.padEnd(5)} ${e.kind.padEnd(8)} ${(e.step ?? e.phase).padEnd(14)} ${e.text}`);
			}
			return;
		}
		case "lessons": {
			const all = await lessons(config.stateDir);
			if (all.length === 0) return console.log("no lessons yet: the coordinator adds one when it repairs a failure");
			for (const l of all) console.log(`- ${l}`);
			return console.log(`(${join(config.stateDir, "lessons.md")}: edit or delete a line freely)`);
		}
		case "usage": {
			const u = (await call<{ usage: ThrottleStatus }>(config, "/api/overview")).usage;
			const budget = u.limits.dailyBudgetUsd > 0 ? ` of ${usd(u.limits.dailyBudgetUsd)}${u.budgetReached ? " (reached: tickets are paused)" : ""}` : " (no daily budget)";
			console.log(`today ${u.today.day}: ${usd(u.today.total.cost)}${budget}, ${u.today.total.requests} requests, ${u.today.total.tokens} tokens`);
			for (const [p, x] of Object.entries(u.today.providers)) console.log(`  ${p.padEnd(12)} ${usd(x.cost).padStart(8)} ${String(x.requests).padStart(6)} requests ${String(x.tokens).padStart(10)} tokens`);
			console.log(`limits per provider: ${u.limits.rpm || "no"} requests/min, ${u.limits.tpm || "no"} tokens/min`);
			for (const w of u.waiting) console.log(`  waiting: ${w.provider}: ${w.reason}`);
			return;
		}
		case "status": {
			const tickets = await readOnly(config, async () => (await call<{ tickets: Ticket[] }>(config, "/api/overview")).tickets, (f) => f.tickets());
			const up = await server(config);
			console.log(up ? `factory serving at ${up.url}` : "no factory is serving (ff serve)");
			for (const t of tickets) console.log(`  ${line(t)}`);
			return;
		}
		case "show": {
			const ref = ticketArg(args);
			const data = await readOnly(config, () => call<{ ticket: Ticket }>(config, `/api/tickets/${encodeURIComponent(ref)}`), async (f) => ({ ticket: (await f.ticket(ref)) ?? fail(`unknown ticket ${ref}`) }));
			const t = data.ticket;
			console.log(line(t));
			console.log(`  branch ${t.branch}  worktree ${t.worktree}  run ${t.run}`);
			for (const s of t.steps) console.log(`  ${s.name.padEnd(16)} ${s.status.padEnd(8)} ${s.model}${s.error ? `  ${s.error}` : ""}`);
			return;
		}
		case "sentry": {
			if (args[0] === "sync") {
				const r = await call<{ issues: number; complete: boolean }>(config, "/api/sentry/sync", {});
				return console.log(`synced ${r.issues} issue(s)${r.complete ? "" : " (more than SENTRY_MAX_PAGES pages: the rest wait for the next sync)"}`);
			}
			const o = await call<{ sentry: { issues: { id: string; shortId: string; title: string; score: number; events: number; users: number; triage: string; gone: boolean }[]; lastSync: number | null } }>(config, "/api/overview");
			for (const i of o.sentry.issues.filter((x) => !x.gone && x.triage === "new")) {
				console.log(`  ${i.score.toFixed(1).padStart(6)}  ${i.shortId.padEnd(16)} ${String(i.events).padStart(7)} ev ${String(i.users).padStart(5)} users  ${i.title}  (ff fix ${i.id})`);
			}
			return;
		}
		case "fix": {
			const id = ticketArg(args);
			const r = await call<{ ticketId: string }>(config, `/api/sentry/${encodeURIComponent(id)}/fix`, {});
			return console.log(`ticket ${r.ticketId} created, its spec is being planned`);
		}
		case "sprint": {
			const s = await call<{ sprint?: { name: string }; tasks?: { cid: string; title: string; status: string; factory: Ticket | null }[]; error?: string }>(config, "/api/sprint?refresh=1");
			if (s.error) fail(s.error);
			console.log(`sprint ${s.sprint!.name}`);
			for (const t of s.tasks!) console.log(`  ${t.cid.padEnd(12)} ${t.status.padEnd(14)} ${(t.factory?.state ?? "-").padEnd(17)} ${t.title}`);
			return;
		}
		case "gc": {
			if ((await server(config)) !== null) {
				const r = await call<{ removed: string[] }>(config, "/api/gc", {});
				return console.log([...r.removed, `gc: ${r.removed.length} worktree(s) removed`].join("\n"));
			}
			const days = args[0] === undefined ? config.gcDays : Number(args[0]);
			if (!Number.isInteger(days) || days < 0) fail("usage: ff gc [days]");
			const factory = await Factory.open(await deps(config, { readOnly: true }));
			try {
				const removed = await factory.gc(days);
				return console.log([...removed, `gc: ${removed.length} worktree(s) removed`].join("\n"));
			} finally {
				await factory.close();
			}
		}
		case "doctor":
			process.exitCode = await doctor(config);
			return;
		case "health": {
			// The container healthcheck: the factory serves and answers.
			const up = await server(config);
			if (up === null) fail("no factory is serving");
			await call(config, "/api/overview");
			return console.log("ok");
		}
		case "login":
			return login(config, args[0]);
		case "whoami": {
			const headers = { Authorization: config.clickup.token };
			const user = await requestJson<{ user: { id: number; username: string } }>("GET", "https://api.clickup.com/api/v2/user", { headers });
			const teams = await requestJson<{ teams: { id: string; name: string }[] }>("GET", "https://api.clickup.com/api/v2/team", { headers });
			console.log(`CLICKUP_USER_ID=${user.data.user.id}  (${user.data.user.username})`);
			for (const t of teams.data.teams) console.log(`CLICKUP_TEAM_ID=${t.id}  (${t.name})`);
			return;
		}
		default:
			console.log(USAGE);
			process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 1;
	}
}

await main();

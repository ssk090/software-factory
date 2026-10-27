// Onboarding: the setup the dashboard may read and write without a file edit. The running factory
// reads config.env at start (bin/ff sources it), so a saved repo or tracker setting needs a restart.
// Agent files and lanes apply to the next step. Every secret is write-only: the API returns a mask,
// never the value, and the file keeps mode 600.
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Config, loadConfig } from "./config.ts";
import { run } from "./git.ts";
import { requestJson } from "./http.ts";
import { chain, loadLanes, modelName } from "./lanes.ts";
import { parseAgentFile } from "./skills.ts";

export type KeyGroup = "repo" | "clickup" | "sentry" | "models" | "github";

type KeySpec = {
	name: string;
	label: string;
	group: KeyGroup;
	secret: boolean;
	read: (config: Config) => string;
};

const specs: KeySpec[] = [
	{ name: "REPO", label: "Repo path", group: "repo", secret: false, read: (c) => c.repo },
	{ name: "BASE", label: "Base branch", group: "repo", secret: false, read: (c) => c.base },
	{ name: "SETUP_CMD", label: "Setup command", group: "repo", secret: false, read: (c) => c.setupCmd },
	{ name: "VERIFY_CMD", label: "Verify command", group: "repo", secret: false, read: (c) => c.verifyCmd },
	{ name: "GH_REPO", label: "GitHub repo (owner/name)", group: "repo", secret: false, read: () => process.env.GH_REPO ?? "" },
	{ name: "SANDBOX_IMAGE", label: "Sandbox image", group: "repo", secret: false, read: (c) => c.sandboxImage },
	{ name: "SANDBOX", label: "Sandbox: docker or none", group: "repo", secret: false, read: (c) => c.sandbox },
	{ name: "CLICKUP_TOKEN", label: "ClickUp token", group: "clickup", secret: true, read: (c) => c.clickup.token },
	{ name: "CLICKUP_TEAM_ID", label: "ClickUp team id", group: "clickup", secret: false, read: (c) => c.clickup.teamId },
	{ name: "CLICKUP_USER_ID", label: "ClickUp user id", group: "clickup", secret: false, read: (c) => c.clickup.userId },
	{ name: "CLICKUP_LIST_ID", label: "ClickUp list id", group: "clickup", secret: false, read: (c) => c.clickup.listId },
	{ name: "CLICKUP_SPRINT_FOLDER_ID", label: "Sprint folder id", group: "clickup", secret: false, read: (c) => c.clickup.sprintFolderId },
	{ name: "CLICKUP_SPRINT_LIST_ID", label: "Sprint list id", group: "clickup", secret: false, read: (c) => c.clickup.sprintListId },
	{ name: "CLICKUP_ID_PREFIX", label: "Ticket id prefix", group: "clickup", secret: false, read: (c) => c.clickup.idPrefix },
	{ name: "SENTRY_CLICKUP_LIST_ID", label: "ClickUp list for Sentry tickets", group: "clickup", secret: false, read: (c) => c.clickup.sentryListId },
	{ name: "S_TODO", label: "Status: to do", group: "clickup", secret: false, read: (c) => c.statuses.todo },
	{ name: "S_SPEC_REVIEW", label: "Status: spec review", group: "clickup", secret: false, read: (c) => c.statuses.specReview },
	{ name: "S_APPROVED", label: "Status: approved", group: "clickup", secret: false, read: (c) => c.statuses.approved },
	{ name: "S_WORKING", label: "Status: in progress", group: "clickup", secret: false, read: (c) => c.statuses.working },
	{ name: "S_IN_REVIEW", label: "Status: in review", group: "clickup", secret: false, read: (c) => c.statuses.inReview },
	{ name: "S_BLOCKED", label: "Status: blocked", group: "clickup", secret: false, read: (c) => c.statuses.blocked },
	{ name: "SENTRY_AUTH_TOKEN", label: "Sentry auth token", group: "sentry", secret: true, read: (c) => c.sentry.token },
	{ name: "SENTRY_ORG", label: "Sentry org", group: "sentry", secret: false, read: (c) => c.sentry.org },
	{ name: "SENTRY_PROJECTS", label: "Sentry project ids (comma)", group: "sentry", secret: false, read: (c) => c.sentry.projects.join(",") },
	{ name: "SENTRY_ENVIRONMENT", label: "Sentry environments (comma)", group: "sentry", secret: false, read: (c) => c.sentry.environment },
	{ name: "SENTRY_QUERY", label: "Sentry query", group: "sentry", secret: false, read: (c) => c.sentry.query },
	{ name: "SENTRY_PERIOD", label: "Sentry period", group: "sentry", secret: false, read: (c) => c.sentry.period },
	{ name: "ANTHROPIC_API_KEY", label: "Anthropic key", group: "models", secret: true, read: () => process.env.ANTHROPIC_API_KEY ?? "" },
	{ name: "OPENAI_API_KEY", label: "OpenAI key", group: "models", secret: true, read: () => process.env.OPENAI_API_KEY ?? "" },
	{ name: "GEMINI_API_KEY", label: "Gemini key", group: "models", secret: true, read: () => process.env.GEMINI_API_KEY ?? "" },
	{ name: "XAI_API_KEY", label: "xAI key", group: "models", secret: true, read: () => process.env.XAI_API_KEY ?? "" },
	{ name: "MISTRAL_API_KEY", label: "Mistral key", group: "models", secret: true, read: () => process.env.MISTRAL_API_KEY ?? "" },
	{ name: "GROQ_API_KEY", label: "Groq key", group: "models", secret: true, read: () => process.env.GROQ_API_KEY ?? "" },
	{ name: "OPENROUTER_API_KEY", label: "OpenRouter key", group: "models", secret: true, read: () => process.env.OPENROUTER_API_KEY ?? "" },
	{ name: "TYPESAFE_API_KEY", label: "Jev key (typesafe.ai)", group: "models", secret: true, read: () => process.env.TYPESAFE_API_KEY ?? "" },
	{ name: "GH_TOKEN", label: "GitHub token", group: "github", secret: true, read: () => process.env.GH_TOKEN ?? "" },
];
const specByName = new Map(specs.map((s) => [s.name, s]));

/** The roles the pipeline runs today (an agent file with another name is stored but not called). */
export const PIPELINE_ROLES = ["spec", "plan", "test", "code", "docs", "pr-summary", "review", "fix", "judge", "coordinate", "runtime"];

export type SetupKey = { name: string; label: string; group: KeyGroup; secret: boolean; set: boolean; hint: string; value: string };
export type SetupAgent = { role: string; name: string; skills: string; prompt: string; enabled: boolean; builtin: boolean; runs: boolean; lane: string[] };
export type SetupView = {
	file: string;
	loopback: boolean;
	firstRun: boolean;
	keys: SetupKey[];
	agents: SetupAgent[];
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const mask = (value: string) => (value === "" ? "" : value.length <= 4 ? "****" : `****${value.slice(-4)}`);

/** The config values the running factory uses, refreshed from the environment (and the factory's own
 * values for a field the environment does not carry, as in tests and a hosted CLI). */
const fresh = (config: Config) =>
	loadConfig(
		{
			...process.env,
			REPO: process.env.REPO ?? config.repo,
			DATA_DIR: process.env.DATA_DIR ?? config.dataDir,
			BASE: process.env.BASE ?? config.base,
			FACTORY_CONFIG: config.configFile,
		},
		config.here,
	);

const agentFile = (config: Config, role: string) => join(config.here, "agents", `${role}.md`);

/** Every agent file (also a disabled one) in the order the pipeline runs. */
async function agents(config: Config): Promise<SetupAgent[]> {
	const dir = join(config.here, "agents");
	const names = await readdir(dir).catch(() => [] as string[]);
	const lanes = await loadLanes(process.env.LANES_FILE || join(config.here, "durable", "lanes.json")).catch(() => ({ lanes: {}, aliases: {} }));
	const found: SetupAgent[] = [];
	for (const file of names) {
		const enabled = file.endsWith(".md");
		const disabled = file.endsWith(".md.off");
		if (!enabled && !disabled) continue;
		const role = file.replace(/\.md(?:\.off)?$/, "");
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) continue;
		const parsed = parseAgentFile(await readFile(join(dir, file), "utf8").catch(() => ""));
		found.push({
			role,
			name: parsed.header.name || role,
			skills: parsed.header.skills ?? "",
			prompt: parsed.body.trim(),
			enabled,
			builtin: PIPELINE_ROLES.includes(role),
			runs: PIPELINE_ROLES.includes(role) && enabled,
			lane: chain(lanes, role).map(modelName),
		});
	}
	const order = (a: SetupAgent, b: SetupAgent) => {
		const ai = PIPELINE_ROLES.indexOf(a.role);
		const bi = PIPELINE_ROLES.indexOf(b.role);
		return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.role.localeCompare(b.role);
	};
	return found.sort(order);
}

/** What the onboarding page shows. Secret values leave as a mask only. */
export async function setupView(config: Config): Promise<SetupView> {
	const c = fresh(config);
	const keys = specs.map((spec): SetupKey => {
		const value = spec.read(c);
		return { name: spec.name, label: spec.label, group: spec.group, secret: spec.secret, set: value !== "", hint: spec.secret ? mask(value) : "", value: spec.secret ? "" : value };
	});
	const raw = await readFile(config.configFile, "utf8").catch(() => "");
	return {
		file: config.configFile,
		loopback: LOOPBACK.has(c.dash.host),
		firstRun: !/^REPO=/m.test(raw) && process.env.REPO === undefined,
		keys,
		agents: await agents(config),
	};
}

export type SaveResult = { saved: string[]; cleared: string[]; restart: string[] };

/**
 * Write settings and keys to config.env. A non-empty value replaces the line. `clear` removes a
 * line. An unknown name or a value with a newline is refused. The file stays mode 600.
 */
export async function saveSetup(config: Config, input: { values?: Record<string, unknown>; clear?: readonly unknown[] }): Promise<SaveResult> {
	const values = input.values ?? {};
	const clear = (input.clear ?? []).filter((x): x is string => typeof x === "string");
	const saved: string[] = [];
	const cleared: string[] = [];
	const lines: string[] = [];
	for (const [name, value] of Object.entries(values)) {
		const spec = specByName.get(name);
		if (spec === undefined) throw new Error(`${name} is not a setting the onboarding page writes`);
		if (typeof value !== "string") throw new Error(`${name} must be a string`);
		if (/[\0\r\n]/.test(value)) throw new Error(`${name} must be one line`);
		if (value.length > 20_000) throw new Error(`${name} is too long`);
		if (spec.secret && value.trim() === "") throw new Error(`${name} is a secret and cannot be empty: clear it instead`);
		lines.push(value.trim() === "" ? `${name}=` : `${name}=${shellQuote(value)}`);
		saved.push(name);
	}
	for (const name of clear) {
		if (!specByName.has(name)) throw new Error(`${name} is not a setting the onboarding page writes`);
		lines.push(`# cleared by onboarding: ${name}`);
		cleared.push(name);
	}
	if (saved.length === 0 && cleared.length === 0) return { saved: [], cleared: [], restart: [] };
	const file = config.configFile;
	const old = await readFile(file, "utf8").catch(() => "");
	const drop = new Set([...saved, ...cleared]);
	const kept = old.split("\n").filter((line) => line !== "" && !drop.has(line.split("=")[0] ?? ""));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, `${[...kept, ...lines].join("\n")}\n`, { mode: 0o600 });
	await chmod(`${file}.tmp`, 0o600);
	await rename(`${file}.tmp`, file);
	for (const line of lines) {
		if (line.startsWith("#")) continue;
		const name = line.slice(0, line.indexOf("="));
		const raw = line.slice(line.indexOf("=") + 1);
		process.env[name] = unquote(raw);
	}
	for (const name of cleared) delete process.env[name];
	return { saved, cleared, restart: [...saved, ...cleared] };
}

/** A value written by shellQuote (or a plain one). */
function unquote(raw: string): string {
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/'\\''/g, "'");
	return raw;
}

export type AgentInput = { role: string; prompt?: unknown; skills?: unknown; cloneFrom?: unknown };

/** Write (or clone) an agent file. The pipeline reads it at the next step, so no restart is needed. */
export async function saveAgent(config: Config, input: AgentInput): Promise<SetupAgent> {
	const role = typeof input.role === "string" ? input.role.trim() : "";
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) throw new Error("role must look like code, review or my-agent");
	const from = typeof input.cloneFrom === "string" ? input.cloneFrom.trim() : "";
	let body = typeof input.prompt === "string" ? input.prompt : undefined;
	let skills = typeof input.skills === "string" ? input.skills : undefined;
	if (from !== "") {
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(from)) throw new Error("cloneFrom must be a role");
		const parsed = parseAgentFile(await readFile(agentFile(config, from), "utf8").catch(() => {
			throw new Error(`no agent ${from} to clone`);
		}));
		if (body === undefined) body = parsed.body;
		if (skills === undefined) skills = parsed.header.skills ?? "";
	}
	if (body === undefined || body.trim() === "") throw new Error("the prompt is empty");
	if (body.length > 200_000) throw new Error("the prompt is too long");
	if (skills !== undefined && skills.length > 500) throw new Error("skills is too long");
	const header = `---\nname: ${role}\n${skills === undefined || skills.trim() === "" ? "" : `skills: ${skills.trim()}\n`}---\n`;
	await mkdir(join(config.here, "agents"), { recursive: true });
	await writeFile(agentFile(config, role), `${header}${body.trim()}\n`);
	const found = findAgent(await agents(config), role);
	if (found === undefined) throw new Error(`agent ${role} was not written`);
	return found;
}

const findAgent = (list: SetupAgent[], role: string) => list.find((a) => a.role === role);

/** Turn an agent on or off (the pipeline only runs an enabled .md file). */
export async function setAgentEnabled(config: Config, role: string, enabled: boolean): Promise<void> {
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) throw new Error("bad role");
	const on = agentFile(config, role);
	const off = `${on}.off`;
	if (enabled) {
		await rename(off, on).catch(() => {
			throw new Error(`no disabled agent ${role}`);
		});
	} else {
		await rename(on, off).catch(() => {
			throw new Error(`no enabled agent ${role}`);
		});
	}
}

/** Remove a custom agent (a built-in can be disabled, never deleted). */
export async function removeAgent(config: Config, role: string): Promise<void> {
	if (PIPELINE_ROLES.includes(role)) throw new Error(`built-in agents are disabled, not deleted: ${role}`);
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) throw new Error("bad role");
	await rm(agentFile(config, role), { force: true });
	await rm(`${agentFile(config, role)}.off`, { force: true });
}

export type ConnectionKind = "clickup" | "sentry" | "github" | "repo" | "verify" | "models";

/** A live check for one step of the onboarding page. No value of a secret appears in the detail. */
export async function testConnection(config: Config, kind: ConnectionKind): Promise<{ ok: boolean; detail: string }> {
	const c = fresh(config);
	const clean = (text: string, ...secrets: string[]) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join("[redacted]"), text).slice(0, 1500);
	if (kind === "clickup") {
		if (c.clickup.token === "") return { ok: false, detail: "CLICKUP_TOKEN is not set" };
		try {
			const user = await requestJson<{ user?: { username?: string; id?: number } }>("GET", "https://api.clickup.com/api/v2/user", { headers: { Authorization: c.clickup.token }, tries: 1 });
			let detail = `ClickUp: ${user.data.user?.username ?? "signed in"}`;
			if (c.clickup.listId !== "") {
				await requestJson("GET", `https://api.clickup.com/api/v2/list/${encodeURIComponent(c.clickup.listId)}`, { headers: { Authorization: c.clickup.token }, tries: 1 });
				detail += `; list ${c.clickup.listId} is reachable`;
			}
			return { ok: true, detail: clean(detail, c.clickup.token) };
		} catch (error) {
			return { ok: false, detail: clean(error instanceof Error ? error.message : String(error), c.clickup.token) };
		}
	}
	if (kind === "sentry") {
		if (c.sentry.token === "" || c.sentry.org === "") return { ok: false, detail: "SENTRY_AUTH_TOKEN and SENTRY_ORG are required" };
		try {
			const org = await requestJson<{ name?: string; slug?: string }>("GET", `${c.sentry.url}/api/0/organizations/${encodeURIComponent(c.sentry.org)}/`, { headers: { Authorization: `Bearer ${c.sentry.token}` }, tries: 1 });
			return { ok: true, detail: clean(`Sentry: ${org.data.name ?? org.data.slug ?? c.sentry.org}`, c.sentry.token) };
		} catch (error) {
			return { ok: false, detail: clean(error instanceof Error ? error.message : String(error), c.sentry.token) };
		}
	}
	if (kind === "github") {
		const auth = await run("gh", ["auth", "status"]);
		return { ok: auth.code === 0, detail: (auth.code === 0 ? auth.stdout : auth.stderr).trim().split("\n")[0] ?? "" };
	}
	if (kind === "repo") {
		const gitDir = await run("git", ["-C", c.repo, "rev-parse", "--git-dir"]);
		if (gitDir.code !== 0) return { ok: false, detail: `${c.repo} is not a git repository` };
		const remote = await run("git", ["-C", c.repo, "ls-remote", "-q", "--exit-code", "origin", `refs/heads/${c.base}`]);
		if (remote.code !== 0) return { ok: false, detail: `origin has no branch ${c.base}, or origin is unreachable` };
		return { ok: true, detail: `${c.repo}: branch ${c.base} is on origin` };
	}
	if (kind === "verify") {
		if (c.verifyCmd === "") return { ok: false, detail: "VERIFY_CMD is not set" };
		const result = await run("sh", ["-c", c.verifyCmd], { cwd: c.repo, timeoutMs: 180_000 });
		const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-15).join("\n");
		return { ok: result.code === 0, detail: clean(`VERIFY_CMD ${result.code === 0 ? "passes" : `fails (exit ${result.code})`}${tail === "" ? "" : `:\n${tail}`}`) };
	}
	const models = builtinModels();
	const ready: string[] = [];
	for (const provider of ["anthropic", "openai", "google", "xai", "mistral", "groq", "openrouter"]) {
		if ((await models.getAuth(provider)) !== undefined) ready.push(provider);
	}
	return { ok: ready.length > 0, detail: ready.length === 0 ? "no model provider has a key" : `model providers ready: ${ready.join(", ")}` };
}

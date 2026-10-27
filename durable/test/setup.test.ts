// The onboarding setup: masked secrets in config.env, agent files, and the live connection checks.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import { removeAgent, saveAgent, saveSetup, setAgentEnabled, setupView, testConnection } from "../src/setup.ts";
import { scratchRepo } from "./support.ts";

const withEnv = async () => {
	const w = await scratchRepo();
	const here = join(w.root, "here");
	await mkdir(join(here, "agents"), { recursive: true });
	await mkdir(join(here, "durable"), { recursive: true });
	await writeFile(join(here, "durable", "lanes.json"), JSON.stringify({ lanes: { code: ["faux/faux-1"] }, aliases: {} }));
	await writeFile(join(here, "agents", "code.md"), "---\nname: code\nskills: tdd\n---\nYou code.\n");
	const file = join(here, "config.env");
	const config: Config = loadConfig(
		{
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			DATA_DIR: w.data,
			REPO: w.repo,
			BASE: "main",
			SANDBOX: "none",
			FACTORY_CONFIG: file,
			LANES_FILE: join(here, "durable", "lanes.json"),
		},
		here,
	);
	return { ...w, here, file, config };
};

describe("onboarding setup", () => {
	it("shows plain settings and masks every secret", async () => {
		const w = await withEnv();
		try {
			await writeFile(w.file, `REPO='${w.repo}'\nBASE=main\nCLICKUP_TOKEN='pk_secret_1234'\n`, { mode: 0o600 });
			process.env.CLICKUP_TOKEN = "pk_secret_1234";
			const view = await setupView(w.config);
			const token = view.keys.find((k) => k.name === "CLICKUP_TOKEN")!;
			assert.equal(token.set, true);
			assert.equal(token.secret, true);
			assert.equal(token.value, "", "a secret value never comes back");
			assert.equal(token.hint, "****1234");
			assert.equal(view.keys.find((k) => k.name === "REPO")?.value, w.repo);
			assert.equal(view.loopback, true);
			assert.equal(view.agents[0]?.role, "code");
			assert.equal(view.agents[0]?.enabled, true);
			assert.equal(view.agents[0]?.runs, true);
		} finally {
			delete process.env.CLICKUP_TOKEN;
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("writes and clears keys with mode 600, and refuses bad input", async () => {
		const w = await withEnv();
		try {
			const saved = await saveSetup(w.config, { values: { CLICKUP_TOKEN: "pk_new_9999", BASE: "develop" } });
			assert.deepEqual(saved.saved.sort(), ["BASE", "CLICKUP_TOKEN"]);
			const text = await readFile(w.file, "utf8");
			assert.match(text, /CLICKUP_TOKEN='pk_new_9999'/);
			assert.match(text, /BASE='develop'/);
			assert.equal((await stat(w.file)).mode & 0o777, 0o600);
			assert.equal(process.env.CLICKUP_TOKEN, "pk_new_9999", "the running factory sees it");
			const before = await setupView(w.config);
			assert.equal(before.keys.find((k) => k.name === "CLICKUP_TOKEN")?.hint, "****9999");
			await saveSetup(w.config, { clear: ["CLICKUP_TOKEN"] });
			const after = await setupView(w.config);
			assert.equal(after.keys.find((k) => k.name === "CLICKUP_TOKEN")?.set, false);
			assert.equal(process.env.CLICKUP_TOKEN, undefined);
			await assert.rejects(saveSetup(w.config, { values: { NOPE: "x" } }), /not a setting/);
			await assert.rejects(saveSetup(w.config, { values: { BASE: "a\nb" } }), /one line/);
			await assert.rejects(saveSetup(w.config, { values: { CLICKUP_TOKEN: "" } }), /cannot be empty/);
		} finally {
			delete process.env.CLICKUP_TOKEN;
			delete process.env.BASE;
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("saves, clones, disables and removes an agent", async () => {
		const w = await withEnv();
		try {
			const code = await saveAgent(w.config, { role: "code", prompt: "You write the code.", skills: "tdd, ponytail" });
			assert.equal(code.prompt, "You write the code.");
			assert.match(await readFile(join(w.here, "agents", "code.md"), "utf8"), /skills: tdd, ponytail/);
			const clone = await saveAgent(w.config, { role: "my-agent", cloneFrom: "code" });
			assert.equal(clone.prompt, "You write the code.");
			assert.equal(clone.runs, false, "the pipeline does not call an unknown role");
			await setAgentEnabled(w.config, "my-agent", false);
			assert.equal((await setupView(w.config)).agents.find((a) => a.role === "my-agent")?.enabled, false);
			await setAgentEnabled(w.config, "my-agent", true);
			assert.equal((await setupView(w.config)).agents.find((a) => a.role === "my-agent")?.enabled, true);
			await removeAgent(w.config, "my-agent");
			assert.equal((await setupView(w.config)).agents.find((a) => a.role === "my-agent"), undefined);
			await assert.rejects(removeAgent(w.config, "code"), /disabled, not deleted/);
			await assert.rejects(saveAgent(w.config, { role: "Bad Name", prompt: "x" }), /role must look like/);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("checks the repo and VERIFY_CMD, and never echoes a token", async () => {
		const w = await withEnv();
		const realFetch = globalThis.fetch;
		try {
			assert.equal((await testConnection(w.config, "repo")).ok, true);
			process.env.VERIFY_CMD = "test -f README.md";
			assert.equal((await testConnection(w.config, "verify")).ok, true);
			process.env.VERIFY_CMD = "test -f nope";
			const failed = await testConnection(w.config, "verify");
			assert.equal(failed.ok, false);
			assert.match(failed.detail, /VERIFY_CMD fails \(exit 1\)/);
			process.env.CLICKUP_TOKEN = "pk_secret_1234";
			globalThis.fetch = (async () => new Response(JSON.stringify({ user: { username: "me" } }), { status: 200 })) as typeof fetch;
			const clickup = await testConnection(w.config, "clickup");
			assert.equal(clickup.ok, true);
			assert.match(clickup.detail, /ClickUp: me/);
			assert.ok(!clickup.detail.includes("pk_secret_1234"));
			globalThis.fetch = (async () => new Response("bad token pk_secret_1234", { status: 401 })) as typeof fetch;
			const denied = await testConnection(w.config, "clickup");
			assert.equal(denied.ok, false);
			assert.ok(!denied.detail.includes("pk_secret_1234"), denied.detail);
		} finally {
			globalThis.fetch = realFetch;
			delete process.env.CLICKUP_TOKEN;
			delete process.env.VERIFY_CMD;
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

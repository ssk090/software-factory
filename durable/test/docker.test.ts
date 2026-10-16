// SANDBOX=docker: an agent's commands run in its ticket's container, at the same paths, with only the
// cell's variables. Skipped when Docker is not running.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { dockerEnv, ensureContainer, reapOrphans, removeContainer } from "../src/env.ts";
import { Factory } from "../src/host.ts";
import { FakeGitHost, FakeTracker, fauxAgents, lanes, scratchRepo, testConfig } from "./support.ts";

const IMAGE = process.env.SANDBOX_TEST_IMAGE || "node:22-bookworm-slim";
const docker = (() => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("docker sandbox", { skip: !docker && "Docker is not running", timeout: 300_000 }, () => {
	let root: string;
	let worktree: string;
	let run: string;
	const name = `factory-test-${process.pid}`;

	before(async () => {
		// Under $HOME, so Docker Desktop can mount it.
		root = await mkdtemp(join(homedir(), ".sf-docker-test-"));
		worktree = join(root, "worktree");
		run = join(root, "run");
		await mkdir(worktree, { recursive: true });
		await mkdir(run, { recursive: true });
		await ensureContainer({ name, image: IMAGE, worktree, run, gitDir: join(root, "git"), cacheVolume: "", extraArgs: [] });
	});
	after(async () => {
		await removeContainer(name);
		await rm(root, { recursive: true, force: true });
	});

	const env = () => dockerEnv({ worktree, run, cell: { FACTORY_TICKET: "T-1", PORT_BASE: "20100" }, container: name });

	it("runs at the worktree's path with the cell's variables, and none of this machine's secrets", async () => {
		process.env.ANTHROPIC_API_KEY = "must-not-leak";
		await writeFile(join(worktree, "hello.txt"), "from the host\n");
		let out = "";
		const result = await env().exec('pwd; cat hello.txt; echo "$FACTORY_TICKET $PORT_BASE ${ANTHROPIC_API_KEY:-nokey} $PATH"', { onOutput: (t) => (out += t) }, BACKGROUND_CONTEXT);
		delete process.env.ANTHROPIC_API_KEY;
		assert.ok(result.ok && result.value.exitCode === 0, out);
		const [pwd, hello, vars] = out.trim().split("\n");
		assert.equal(pwd, worktree);
		assert.equal(hello, "from the host");
		assert.match(vars!, /^T-1 20100 nokey \/usr\/local\/sbin:/, "the container's own PATH, not the host's");
	});

	it("an aborted command dies with its whole process group inside the container", async () => {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		setTimeout(() => cancel(), 500);
		const started = Date.now();
		await env().exec("sleep 41 & sleep 42; echo never", {}, context);
		assert.ok(Date.now() - started < 10_000);
		await new Promise((r) => setTimeout(r, 300));
		const ps = execFileSync("docker", ["exec", name, "sh", "-c", "ls /proc | grep -E '^[0-9]+$' | while read p; do cat /proc/$p/cmdline 2>/dev/null | tr '\\0' ' '; echo; done"]).toString();
		assert.doesNotMatch(ps, /sleep 4[12]/, ps);
	});

	it("reaps commands a dead factory left running in the container", async () => {
		// A command started as a crashed factory would have left it: recorded, still running.
		execFileSync("docker", ["exec", "-d", name, "setsid", "bash", "-c", 'echo $$ > /tmp/factory-exec-dead-1; exec sleep 43']);
		await new Promise((r) => setTimeout(r, 500));
		const killed = await reapOrphans(run, name);
		assert.equal(killed, 1);
		await new Promise((r) => setTimeout(r, 300));
		const ps = execFileSync("docker", ["exec", name, "sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '"]).toString();
		assert.doesNotMatch(ps, /sleep 43/);
	});
});

// The whole pipeline in the docker sandbox: needs the factory's image (git, bash), so CI's docker job
// builds it and sets SF_DOCKER_PIPELINE=1 (locally: docker build -t software-factory . first).
describe("pipeline in the docker sandbox", { skip: (!docker || process.env.SF_DOCKER_PIPELINE !== "1") && "set SF_DOCKER_PIPELINE=1 with the software-factory image", timeout: 600_000 }, () => {
	it("takes a ticket to a reviewed PR with every agent command in the ticket's container", async () => {
		const w = await scratchRepo(homedir());
		// The repo's pre-push hook passes only on Linux: it must run in the sandbox, where the dependencies are.
		await writeFile(join(w.repo, ".git", "hooks", "pre-push"), '#!/bin/sh\n[ "$(uname)" = Linux ] || { echo "pre-push ran outside the sandbox" >&2; exit 1; }\nread line; echo "pre-push in the sandbox for $line"\n');
		await chmod(join(w.repo, ".git", "hooks", "pre-push"), 0o755);
		const config = testConfig(w.repo, w.data, { SANDBOX: "docker", SANDBOX_IMAGE: process.env.SANDBOX_TEST_IMAGE || "software-factory", CACHE_VOLUME: "" });
		const { models } = fauxAgents();
		const factory = await Factory.open({ config, models, lanes, tracker: new FakeTracker(), gitHost: new FakeGitHost(), sentry: null, log: () => {}, admitPollMs: 50 });
		try {
			await factory.start("T-D", { gate: false });
			const id = (await factory.ticket("T-D"))!.taskId as TaskId;
			await factory.harness.waitForTask(id, BACKGROUND_CONTEXT);
			const t = (await factory.ticket("T-D"))!;
			assert.equal(t.state, "in_review", t.blocked ?? "");
			const escape = await readFile(join(t.run!, "escape.log"), "utf8");
			assert.match(escape, /refused to change refs\/heads\/main/, "the guard hook works inside the container");
			assert.match(await readFile(join(t.run!, "cell.txt"), "utf8"), /^port 20000 token none container$/m, "the coder's commands ran in a container");
			assert.match(await readFile(join(t.run!, "pre-push.log"), "utf8"), /pre-push in the sandbox for refs\/heads\/feature\/T-D\//, "the repo's pre-push hook ran in the sandbox, with the refs on its stdin");
			const hook = t.events.filter((e) => e.kind === "hook").map((e) => e.text);
			// Every push (the PR, then the review fixes) is a start and an end on the timeline.
			assert.ok(hook.length >= 2 && hook.length % 2 === 0, hook.join("\n"));
			hook.forEach((text, i) => assert.match(text, i % 2 === 0 ? /^Pre-push hook running in the sandbox/ : /^Pre-push hook passed in \d+s$/));
			assert.throws(() => execFileSync("docker", ["inspect", "factory-t-d"], { stdio: "ignore" }), "the container went with the run");
		} finally {
			await factory.close();
			await removeContainer("factory-t-d");
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

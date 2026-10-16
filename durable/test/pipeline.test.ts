// The durable pipeline end to end, with no network: scratch repo, fake tracker and git host, faux
// models playing the agents. Mirrors tests/e2e.sh.
//   cd durable && npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Ticket } from "../src/docs.ts";
import { Factory, type HostDeps } from "../src/host.ts";
import { FakeGitHost, FakeTracker, fauxAgents, lanes, scratchRepo, testConfig, type Behaviour } from "./support.ts";

const context = BACKGROUND_CONTEXT;

async function world(behaviour: Behaviour = {}, extra: Record<string, string> = {}) {
	const scratch = await scratchRepo();
	const config = testConfig(scratch.repo, scratch.data, extra);
	const tracker = new FakeTracker();
	const gitHost = new FakeGitHost();
	const { models } = fauxAgents(behaviour);
	const deps: HostDeps = { config, models, lanes, tracker, gitHost, sentry: null, log: () => {}, gatePollMs: 50, admitPollMs: 50 };
	return { ...scratch, config, tracker, gitHost, deps, models };
}

async function settle(factory: Factory, id: string): Promise<Ticket> {
	const ticket = (await factory.ticket(id))!;
	await factory.harness.waitForTask(ticket.taskId as TaskId, context);
	return (await factory.ticket(id))!;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("pipeline", { timeout: 120_000 }, () => {
	it("takes a ticket to a reviewed PR: spec, plan, tests, code, docs, PR, review, fix, judge", async () => {
		const w = await world({}, { VERIFY_CMD: "test -f README.md" });
		const factory = await Factory.open(w.deps);
		try {
			const started = await factory.start("T-1", { gate: false });
			assert.equal(started.started, true);
			const again = await factory.start("T-1", { gate: false });
			assert.equal(again.started, false, "a running ticket is not started twice");
			const t = await settle(factory, "T-1");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.equal(t.pr, "https://example.test/pr/1");
			assert.deepEqual(t.reviews.map((r) => r.verdict), ["FIX", "PASS"]);
			assert.equal(t.judge?.score, 4);
			assert.equal(t.slot, null, "the slot is given back");
			const roles = t.steps.map((s) => s.name);
			assert.deepEqual(roles, ["spec-1-1", "plan-1-1", "test-1-1", "code-1-1", "docs-1-1", "pr-summary-1-1", "review-1-1", "fix-1-1", "review-2-1", "pr-summary-2-1", "judge-1-1"]);
			assert.ok(t.steps.every((s) => s.status === "done"));
			assert.ok(t.steps.filter((s) => s.role === "review").every((s) => s.model === "faux/other-1"), "the reviewer is not the coder's family");
			assert.deepEqual(t.verify.map((v) => [v.round, v.ok]), [[1, true], [2, true], [4, true]]);
			// The PR flow and the ticket's statuses.
			assert.ok(w.gitHost.log.some((l) => l.startsWith("create main feature/T-1/test-ticket-t-1 title 1")), w.gitHost.log.join("\n"));
			assert.ok(w.gitHost.log.includes("label https://example.test/pr/1 test-label"));
			assert.ok(w.gitHost.log.includes("ready https://example.test/pr/1"));
			assert.ok(w.gitHost.log.includes("edit https://example.test/pr/1 title 2"));
			assert.equal(w.tracker.status.get("T-1"), "in review");
			// The branch was pushed with the coder's and the fixer's commits; main did not move.
			const remote = w.git(w.repo, "ls-remote", "origin").toString();
			assert.match(remote, /refs\/heads\/feature\/T-1\/test-ticket-t-1/);
			assert.equal(w.git(w.repo, "rev-parse", "origin/main").trim(), w.git(w.repo, "rev-parse", "main").trim());
			// The ticket guard refused every escape, and the agent's shell had no factory secrets.
			const escape = await readFile(join(t.run!, "escape.log"), "utf8");
			assert.match(escape, /refused to change refs\/heads\/main/);
			assert.match(escape, /refused to change refs\/heads\/other-ticket/);
			assert.match(escape, /refused to change refs\/tags\/v-agent/);
			assert.match(await readFile(join(t.run!, "cell.txt"), "utf8"), /^port 20000 token none/);
			// Skills: the agent's own were delivered, the ticket's bad names skipped.
			assert.match(await readFile(join(t.run!, "skills.log"), "utf8"), /^spec: to-spec <- /m);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("waits at the gate for your approval, and the note reaches the coder", async () => {
		let coderSaw = "";
		const w = await world({ onCoder: (m) => (coderSaw = JSON.stringify(m)) });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-2", { gate: true });
			await waitFor(async () => (await factory.ticket("T-2"))?.state === "waiting_approval", "the gate");
			assert.equal(w.tracker.status.get("T-2"), "spec review");
			await new Promise((r) => setTimeout(r, 300)); // it keeps waiting
			assert.equal((await factory.ticket("T-2"))?.state, "waiting_approval");
			await factory.approve("T-2", "use pnpm");
			const t = await settle(factory, "T-2");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(await readFile(join(t.run!, "comments.md"), "utf8"), /\[approval note\] use pnpm/);
			assert.ok(w.tracker.log.includes("comment T-2 Approved: use pnpm"));
			assert.ok(coderSaw.length > 0);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("continues mid-step after the factory stops: the same coder conversation hears its call was interrupted", async () => {
		let interrupted = "";
		const w = await world({ coderSleep: 30, onInterrupted: (r) => (interrupted = r) });
		let factory = await Factory.open(w.deps);
		await factory.start("T-3", { gate: false });
		const run = join(w.data, "runs", "T-3");
		await waitFor(() => readFile(join(run, "coder-started")).then(() => true, () => false), "the coder's bash");
		const stopping = Date.now();
		await factory.close(); // stops the running bash; its intent is stored
		assert.ok(Date.now() - stopping < 15_000, "closing does not wait for sleep 30");
		factory = await Factory.open(w.deps);
		try {
			const t = await settle(factory, "T-3");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.deepEqual(t.steps.filter((s) => s.role === "code").map((s) => s.name), ["code-1-1"], "the step continued; no second attempt");
			assert.match(interrupted, /interrupt/i, "the model was told its call was interrupted, and made it again");
			assert.match(w.git(t.worktree!, "log", "--format=%s", "-3"), /code after restart/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("continues after the factory process is killed with SIGKILL mid-step", async () => {
		let interrupted = "";
		const w = await world({ onInterrupted: (r) => (interrupted = r) });
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "fixtures", "factory-child.ts"), w.repo, w.data], {
			stdio: ["ignore", "pipe", "inherit"],
			env: process.env,
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("the child's coder never ran")), 60_000);
			child.stdout.on("data", (chunk: Buffer) => {
				if (!chunk.toString().includes("CODER_RUNNING")) return;
				clearTimeout(timer);
				child.kill("SIGKILL"); // no cleanup at all: the pid file and the WAL stay as they were
				resolve();
			});
		});
		await new Promise((r) => child.once("exit", r));
		// The coder's command outlived the killed factory (its own process group); the reopened factory ends it.
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const recorded = (await readFile(join(w.data, "runs", "T-K", "exec.pids"), "utf8")).split("\n").map(Number).filter((n) => n > 1);
		assert.ok(recorded.some(alive), "the orphan is running");
		const lines: string[] = [];
		const factory = await Factory.open({ ...w.deps, log: (l) => lines.push(l) });
		try {
			const t = await settle(factory, "T-K");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.deepEqual(t.steps.filter((s) => s.role === "code").map((s) => s.name), ["code-1-1"]);
			assert.match(interrupted, /interrupt/i);
			assert.ok(lines.some((l) => /T-K: ended 1 command\(s\) left running by the last factory/.test(l)), lines.join("\n"));
			assert.ok(!recorded.some(alive), "the orphan is gone");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("lets a reviewer of the coder's family review when no other family has a login", async () => {
		const w = await world();
		const same = { ...w.deps, lanes: { ...lanes, lanes: { ...lanes.lanes, review: ["faux/faux-1"] } } };
		const factory = await Factory.open(same);
		try {
			await factory.start("T-8", { gate: false });
			const t = await settle(factory, "T-8");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(await readFile(join(t.run!, "route.log"), "utf8"), /no other model family has a login, so faux\/faux-1 reviews code of its own family \(faux\)/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("blocks the ticket when the coder deletes a frozen spec test", async () => {
		const w = await world({ coder: "git rm -q ac1.test" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-4", { gate: false });
			const t = await settle(factory, "T-4");
			assert.equal(t.state, "blocked");
			assert.match(t.blocked ?? "", /code: coder deleted tests written from the spec: ac1\.test/);
			assert.equal(w.tracker.status.get("T-4"), "blocked");
			assert.ok(w.tracker.log.some((l) => l.startsWith("comment T-4 Factory stopped: coder deleted tests")));
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("gives the coder a second try when VERIFY_CMD fails, then blocks", async () => {
		const w = await world({}, { VERIFY_CMD: "! test -f file.txt" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-5", { gate: false });
			const t = await settle(factory, "T-5");
			assert.equal(t.state, "blocked");
			assert.match(t.blocked ?? "", /VERIFY_CMD still fails after the coder's second try/);
			assert.deepEqual(t.steps.filter((s) => s.role === "code").map((s) => s.name), ["code-1-1", "code-2-1"]);
			assert.match(await readFile(join(t.run!, "verify-failed.md"), "utf8"), /failed \(exit 1\)/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("a run after a stop continues where it stopped; a run after a finished one starts over", async () => {
		const w = await world({ coderSleep: 30 });
		let factory = await Factory.open(w.deps);
		try {
			await factory.start("T-10", { gate: false });
			const run = join(w.data, "runs", "T-10");
			await waitFor(() => readFile(join(run, "coder-started")).then(() => true, () => false), "the coder");
			await factory.stop("T-10");
			assert.equal((await settle(factory, "T-10")).state, "stopped");
			await rm(join(run, "coder-started"));
		} finally {
			await factory.close();
		}
		// The faux coder no longer sleeps.
		factory = await Factory.open({ ...w.deps, models: fauxAgents().models });
		try {
			await factory.start("T-10", { gate: false });
			let t = await settle(factory, "T-10");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			const names = t.steps.map((s) => s.name);
			assert.deepEqual(names.filter((n) => /^(spec|plan|test)-/.test(n)), ["spec-1-1", "plan-1-1", "test-1-1"], "done steps did not run again");
			assert.deepEqual(names.filter((n) => n.startsWith("code-")), ["code-1-1", "code-1-2"], "the stopped step ran again as a new attempt");
			assert.equal(t.resume, null);
			await factory.start("T-10", { gate: false });
			t = await settle(factory, "T-10");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.equal(t.steps.filter((s) => s.name === "spec-1-2").length, 1, "a finished ticket's next run starts over");
			assert.equal(t.branch, "feature/T-10/test-ticket-t-10-2", "on a new branch: the pushed one is never rewritten");
			assert.equal(t.pr, "https://example.test/pr/2");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("moves a step to the next model in its lane when its model fails", async () => {
		const w = await world();
		const deps = { ...w.deps, retries: 0, lanes: { ...lanes, lanes: { ...lanes.lanes, code: ["faux/broken-1", "faux/faux-1"] } } };
		const factory = await Factory.open(deps);
		try {
			await factory.start("T-11", { gate: false });
			const t = await settle(factory, "T-11");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			const test = t.steps.filter((s) => s.role === "test");
			assert.deepEqual(test.map((s) => [s.name, s.model, s.status]), [["test-1-1", "faux/broken-1", "failed"], ["test-1-2", "faux/faux-1", "done"]]);
			assert.match(test[0]!.error ?? "", /model_error|provider is down/);
			assert.match(await readFile(join(t.run!, "route.log"), "utf8"), /test-1-2: faux\/broken-1: failed earlier in this step/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("places your steer into the running step", async () => {
		let saw = "";
		const w = await world({ coderSleep: 1, onCoder: (m) => (saw += JSON.stringify(m)) });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-6", { gate: false });
			await waitFor(async () => (await factory.ticket("T-6"))?.steps.some((s) => s.name === "code-1-1") === true, "the coder");
			await new Promise((r) => setTimeout(r, 300));
			const steered = await factory.steer("T-6", "Use pnpm, not npm.");
			assert.equal(steered.step, "code-1-1");
			const t = await settle(factory, "T-6");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(saw, /Use pnpm, not npm\./);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("stops a ticket: its pipeline and running step are aborted", async () => {
		const w = await world({ coderSleep: 5 });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-7", { gate: false });
			await waitFor(async () => (await factory.ticket("T-7"))?.steps.some((s) => s.name === "code-1-1") === true, "the coder");
			await factory.stop("T-7");
			const t = await settle(factory, "T-7");
			assert.equal(t.state, "stopped");
			assert.equal(t.slot, null);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

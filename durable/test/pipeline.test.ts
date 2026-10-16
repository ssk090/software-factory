// The durable pipeline end to end, with no network: scratch repo, fake tracker and git host, faux
// models playing the agents.
//   cd durable && npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Ticket } from "../src/docs.ts";
import { Factory, type HostDeps } from "../src/host.ts";
import { readLessons } from "../src/lessons.ts";
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
			const code = t.steps.find((s) => s.name === "code-1-1")!;
			assert.ok(code.headBefore && code.headAfter && code.headBefore !== code.headAfter, "a step records the commits it started and ended on");
			assert.ok(t.steps.filter((s) => s.role === "review").every((s) => s.model === "faux/other-1"), "the reviewer is not the coder's family");
			assert.deepEqual(t.verify.map((v) => [v.round, v.ok]), [[1, true], [2, true], [4, true]]);
			// The PR flow and the ticket's statuses.
			assert.ok(w.gitHost.log.some((l) => l.startsWith("create main feature/T-1/test-ticket-t-1 title 1")), w.gitHost.log.join("\n"));
			assert.ok(w.gitHost.log.includes("label https://example.test/pr/1 test-label"));
			assert.ok(w.gitHost.log.includes("ready https://example.test/pr/1"));
			assert.ok(w.gitHost.log.includes("review https://example.test/pr/1 file.txt:1"), "review 1 went to the PR with its inline comment");
			assert.ok(t.events.some((e) => e.text === "Review 1: FIX; posted on the PR with 1 inline comment(s)"));
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
			assert.equal(w.tracker.log.filter((l) => l.startsWith("attach ")).length, 0, "nothing is attached before you approve");
			await new Promise((r) => setTimeout(r, 300)); // it keeps waiting
			assert.equal((await factory.ticket("T-2"))?.state, "waiting_approval");
			await factory.approve("T-2", "use pnpm");
			const t = await settle(factory, "T-2");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(await readFile(join(t.run!, "comments.md"), "utf8"), /\[approval note\] use pnpm/);
			assert.ok(w.tracker.log.includes("comment T-2 Approved: use pnpm"));
			// The approved spec and plan are on the ticket, once each.
			assert.deepEqual(w.tracker.log.filter((l) => l.startsWith("attach ")), ["attach T-2 T-2-spec.md", "attach T-2 T-2-plan.md"]);
			assert.match(w.tracker.attached.get("T-2/T-2-spec.md") ?? "", /AC-1: it works/);
			assert.match(w.tracker.attached.get("T-2/T-2-plan.md") ?? "", /plan: AC-1/);
			assert.ok(t.events.some((e) => e.text === "Attached T-2-spec.md to the ticket"));
			assert.ok(t.attachedApproval !== null && t.attachedApproval === t.approved?.at);
			assert.ok(coderSaw.length > 0);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("keeps the spec in Simplified Technical English: a write that breaks a hard rule is blocked with its faults", async () => {
		const w = await world({ badSpec: true });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-16", { gate: true });
			await waitFor(async () => ["waiting_approval", "blocked"].includes((await factory.ticket("T-16"))?.state ?? ""), "the gate");
			const t = (await factory.ticket("T-16"))!;
			assert.equal(t.state, "waiting_approval", t.blocked ?? "");
			const spec = await readFile(join(t.run!, "spec.md"), "utf8");
			assert.doesNotMatch(spec, /leveraging|in order to/, "the blocked text never reached the file");
			assert.match(spec, /^AC-1: it works/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("takes a change you ask for on the spec at the gate: the spec writer makes it, the planner follows", async () => {
		const w = await world();
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-17", { gate: true });
			await waitFor(async () => (await factory.ticket("T-17"))?.state === "waiting_approval", "the gate");
			await assert.rejects(factory.revise("T-17", { file: "notes.md", quote: "", comment: "x" }), /only spec\.md and plan\.md/);
			await assert.rejects(factory.revise("T-17", { file: "spec.md", quote: "", comment: "  " }), /say what to change/);
			await factory.revise("T-17", { file: "spec.md", quote: "AC-1: it works", comment: "Add the empty list case." });
			await waitFor(async () => ["done", "failed"].includes((await factory.ticket("T-17"))?.revisions?.[0]?.status ?? ""), "the revision", 30_000);
			let t = (await factory.ticket("T-17"))!;
			assert.equal(t.revisions![0]!.status, "done", t.revisions![0]!.error ?? "");
			assert.equal(t.state, "waiting_approval", "it still waits for you");
			assert.match(await readFile(join(t.run!, "spec.md"), "utf8"), /AC-2: the list can be empty/);
			assert.match(await readFile(join(t.run!, "plan.md"), "utf8"), /AC-2 -> ac2\.test/, "the planner followed the spec");
			assert.ok(t.events.some((e) => e.text === "spec.md revised, and plan.md updated to match"), t.events.map((e) => e.text).join("\n"));
			assert.equal(w.tracker.log.filter((l) => l.startsWith("attach ")).length, 0, "a changed but unapproved spec is not attached");
			assert.deepEqual(t.steps.map((s) => s.name), ["spec-1-1", "plan-1-1"], "the same agents, no new steps");
			await factory.approve("T-17");
			t = await settle(factory, "T-17");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(w.tracker.attached.get("T-17/T-17-spec.md") ?? "", /AC-2: the list can be empty/, "the approved, changed spec is attached");
			assert.equal(w.tracker.log.filter((l) => l === "attach T-17 T-17-spec.md").length, 1);
			await assert.rejects(factory.revise("T-17", { file: "spec.md", quote: "", comment: "late" }), /not waiting for your approval/);
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

	it("cuts the worktree from the remote base even when a local branch is named origin/<base>", async () => {
		const w = await world();
		w.git(w.repo, "branch", "origin/main"); // makes the short name origin/main ambiguous
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-15", { gate: true });
			await waitFor(async () => ["waiting_approval", "blocked"].includes((await factory.ticket("T-15"))?.state ?? ""), "the gate");
			const t = (await factory.ticket("T-15"))!;
			assert.equal(t.state, "waiting_approval", t.blocked ?? "");
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

	it("pauses mid-step: the step's next model request waits until you continue, and its paused time is not its own", async () => {
		const w = await world({ coderSleep: 1 });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-12", { gate: false });
			const run = join(w.data, "runs", "T-12");
			await waitFor(() => readFile(join(run, "coder-started")).then(() => true, () => false), "the coder's bash");
			const paused = await factory.pause("T-12");
			assert.equal(paused.paused?.reason, "you");
			await assert.rejects(factory.resume("T-13"), /not paused/);
			// The bash (sleep 1) ends; the coder's next request is held, so the step does not finish.
			await new Promise((r) => setTimeout(r, 2500));
			let t = (await factory.ticket("T-12"))!;
			assert.equal(t.steps.find((s) => s.name === "code-1-1")?.status, "running", "held while paused");
			assert.match(factory.usage().waiting.map((x) => x.reason).join(" "), /T-12 is paused \(by you\)/);
			await factory.resume("T-12");
			t = await settle(factory, "T-12");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.equal(t.paused, null);
			const code = t.steps.find((s) => s.name === "code-1-1")!;
			assert.ok((code.pausedMs ?? 0) >= 2000, `paused time is counted apart: ${code.pausedMs}`);
			// The timeline and the log: phases in order, steps, the pause, the end.
			const texts = t.events.map((e) => e.text);
			assert.match(texts[0]!, /^Run started/);
			const phases = t.events.filter((e) => e.kind === "phase").map((e) => e.phase);
			assert.deepEqual(phases.slice(0, 6), ["admit", "fetch", "worktree", "spec", "plan", "post-spec"]);
			assert.ok(texts.some((x) => /^Paused by you; code-1-1 finishes its current request, then waits/.test(x)), texts.join("\n"));
			assert.ok(texts.some((x) => /^Continued by you after \d/.test(x)));
			assert.ok(texts.some((x) => /^code-1-1 done in /.test(x)));
			assert.ok(texts.some((x) => /^Ticket status: in progress/.test(x)));
			assert.match(texts.at(-1)!, /^Done: PR ready for human review/);
			assert.ok(t.steps.every((s) => s.sessionId && s.usage !== undefined), "each step knows its provider session and its usage");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("pauses running tickets when the daily budget is spent, and will not continue them until it is back", async () => {
		const w = await world({ coderSleep: 5 }, { DAILY_BUDGET_USD: "1" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-14", { gate: false });
			await waitFor(async () => (await factory.ticket("T-14"))?.steps.some((s) => s.name === "code-1-1") === true, "the coder");
			const cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 } };
			factory.throttle.record(await factory.throttle.admit("faux"), cost);
			await (factory as unknown as { watchBudget(): Promise<void> }).watchBudget();
			const t = (await factory.ticket("T-14"))!;
			assert.equal(t.paused?.reason, "daily budget");
			assert.match(t.events.at(-1)!.text, /^Paused: daily budget reached: \$2\.00 of \$1\.00 spent today/);
			await assert.rejects(factory.resume("T-14"), /daily budget reached.*raise DAILY_BUDGET_USD/);
			await factory.stop("T-14");
			assert.equal((await settle(factory, "T-14")).paused, null, "stopping clears the pause");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("calls the coordinator when the repo's pre-push hook refuses the push: it fixes the branch, the push runs again, and its lesson is kept", async () => {
		const w = await world({ coordinator: "commit-fixed" });
		// The repo's pre-push hook: the check passes only when fixed.txt is on the branch.
		await writeFile(join(w.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\ngit ls-tree -r --name-only HEAD | grep -qx fixed.txt && exit 0\necho 'check:typescript: error TS2322 in src/a.ts' >&2\nexit 1\n");
		await chmod(join(w.repo, ".git", "hooks", "pre-push"), 0o755);
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-20", { gate: false });
			const t = await settle(factory, "T-20");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.ok(t.steps.some((s) => s.name === "coordinate-1-1" && s.status === "done"), t.steps.map((s) => s.name).join(" "));
			assert.match(await readFile(join(t.run!, "failure-1.md"), "utf8"), /error TS2322 in src\/a\.ts/, "the coordinator got the hook's output");
			const texts = t.events.map((e) => e.text);
			assert.ok(texts.some((x) => /^Coordinator called \(1\/2 for "Open the PR"\): git push was refused/.test(x)), texts.join("\n"));
			assert.ok(texts.some((x) => /^Coordinator: The pre-push check wanted fixed\.txt; added it\. "Open the PR" runs again/.test(x)));
			assert.match(w.git(w.repo, "ls-remote", "origin").toString(), /refs\/heads\/feature\/T-20\//, "the branch was pushed after the repair");
			// Self-improving: the lesson reaches the next agents that change code.
			assert.match(await readLessons(w.config.stateDir, "code"), /Run the pre-push checks before you finish\. \(T-20, /);
			assert.equal(await readLessons(w.config.stateDir, "review"), "", "only the roles that change code read lessons");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("stops a push that would send a secret: the coordinator takes it out of every unpushed commit, and the remote never sees it", async () => {
		const token = `ghp_${"Rk7Qm2Zt9Lx4Vb8Nc1Hd6Jf3Pw5Sy0Gu2Ea7"}`;
		const w = await world({ coderFile: ["leak.ts", `export const token = "${token}";`], coordinator: "remove-leak" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-21", { gate: false });
			const t = await settle(factory, "T-21");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			const failure = await readFile(join(t.run!, "failure-1.md"), "utf8");
			assert.match(failure, /leak\.ts:1: github-token/);
			assert.ok(!failure.includes(token), "the failure report never holds the secret");
			const sent = w.git(w.repo, "log", "-p", "--all", "--format=%B", `origin/${t.branch}`).toString();
			assert.ok(!sent.includes(token), "no pushed commit holds the token");
			assert.ok(t.events.some((e) => /possible secret/.test(e.text)));
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("blocks the ticket with the coordinator's reason when it cannot or must not fix the failure", async () => {
		const w = await world({ coordinator: "give-up" });
		await writeFile(join(w.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\necho 'storybook: error TS2345' >&2\nexit 1\n");
		await chmod(join(w.repo, ".git", "hooks", "pre-push"), 0o755);
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-22", { gate: false });
			const t = await settle(factory, "T-22");
			assert.equal(t.state, "blocked");
			assert.match(t.blocked ?? "", /^pr: the coordinator could not fix it: develop already fails this check/);
			assert.equal(t.steps.filter((s) => s.role === "coordinate").length, 1, "no second repair after a deliberate stop");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("does not take a VERIFY_CMD killed on the base (out of memory) for a red base: the gate stays on", async () => {
		// Killed on the base (no file.txt yet), passes after the coder. No coordinator here (MAX_REPAIRS=0).
		const w = await world({}, { VERIFY_CMD: "test -f file.txt || { echo 'tsc --noEmit: Command was killed with SIGKILL'; exit 1; }", MAX_REPAIRS: "0" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-23", { gate: false });
			const t = await settle(factory, "T-23");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.ok(t.events.some((e) => /^VERIFY_CMD was killed on main \(out of memory or SIGKILL, verify-1\.log\): no result, so the gate stays on/.test(e.text)));
			assert.ok(!t.events.some((e) => /already fails VERIFY_CMD/.test(e.text)), "not reported as a red base");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("hands a check killed for memory to the coordinator, which finds a way to run the same check that fits, and the factory keeps it", async () => {
		const w = await world({ coordinator: "verify-concurrency" }, { VERIFY_CMD: "sh check.sh" });
		// The repo's check: killed (out of memory) unless it runs one task at a time.
		await writeFile(join(w.repo, "check.sh"), '[ "$1" = "--concurrency=1" ] && exit 0\necho "tsc: Command was killed with SIGKILL (Forced termination)"\nexit 1\n');
		w.git(w.repo, "add", "check.sh");
		w.git(w.repo, "commit", "-qm", "the check");
		w.git(w.repo, "push", "-q", "origin", "main");
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-24", { gate: false });
			const t = await settle(factory, "T-24");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.ok(t.steps.some((s) => s.name === "coordinate-1-1"), t.steps.map((s) => s.name).join(" "));
			assert.ok(t.events.some((e) => e.text.startsWith("VERIFY_CMD now runs as: sh check.sh --concurrency=1")), t.events.map((e) => e.text).join("\n"));
			assert.deepEqual(t.verify.map((v) => [v.round, v.ok]), [[1, true], [2, true], [4, true]], "the base and the code were really checked");
			assert.equal(JSON.parse(await readFile(join(w.config.stateDir, "verify.json"), "utf8")).command, "sh check.sh --concurrency=1");
			assert.match(await readLessons(w.config.stateDir, "code"), /--concurrency=1/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("hands a coder that gave up for the environment to the coordinator, which finishes its work without running the coder again", async () => {
		const w = await world({ coderGivesUp: "The sandbox container stopped: every bash call fails, so I cannot commit. The change is done in the worktree.", coordinator: "finish-coder" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-26", { gate: false });
			const t = await settle(factory, "T-26");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.deepEqual(t.steps.filter((s) => s.role === "code" || s.role === "coordinate").map((s) => s.name), ["code-1-1", "coordinate-1-1"], "the coder's step is kept, not run again");
			assert.match(await readFile(join(t.run!, "failure-1.md"), "utf8"), /- Kind: blocked[\s\S]*The sandbox container stopped/);
			assert.match(w.git(t.worktree!, "log", "--format=%s", "-5").toString(), /code \(the coordinator finished it\)/);
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("pushes only what the ticket needs: build output stops the push, and the coordinator takes it out of the commits", async () => {
		const w = await world({ coderFile: ["dist/bundle.js", "console.log('built');"], coordinator: "remove-listed" });
		const factory = await Factory.open(w.deps);
		try {
			await factory.start("T-27", { gate: false });
			const t = await settle(factory, "T-27");
			assert.equal(t.state, "in_review", t.blocked ?? "");
			assert.match(await readFile(join(t.run!, "failure-1.md"), "utf8"), /- Kind: scope[\s\S]*- dist\/bundle\.js: build output/);
			const pushed = w.git(w.repo, "ls-tree", "-r", "--name-only", `origin/${t.branch}`).toString();
			assert.ok(!pushed.includes("dist/bundle.js"), "the build output never reached the remote");
			assert.ok(pushed.includes("file.txt"), "the ticket's own change did");
		} finally {
			await factory.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("starts the build the moment you approve, not at the gate's next poll", async () => {
		const w = await world();
		const factory = await Factory.open({ ...w.deps, gatePollMs: 60_000 });
		try {
			await factory.start("T-25", { gate: true });
			await waitFor(async () => (await factory.ticket("T-25"))?.state === "waiting_approval", "the gate");
			const approved = Date.now();
			await factory.approve("T-25");
			await waitFor(async () => (await factory.ticket("T-25"))?.state === "running", "the build", 5000);
			assert.ok(Date.now() - approved < 5000, "woken, not polled");
			await factory.stop("T-25");
			await settle(factory, "T-25");
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

// The ticket pipeline as one durable task (examples 12-tasks, 13-recovery, 24-child-tasks): its
// stages are phases that each save a checkpoint. A restarted factory continues every
// ticket from its last checkpoint. Each agent step is a conversation owned by this task (examples
// 03-owned-conversations, 22-subagent-foreground, 23-subagent-background), created in the same commit
// as the checkpoint that records it, and its prompt is submitted with a request ID: a restart finds the
// same conversation and the same submission, and the agent continues mid-step.
//
//   start -> admit -> fetch -> worktree -> spec -> plan -> post-spec -> gate (you approve)
//   -> setup -> verify-base -> test -> code -> verify-code [-> code #2] -> docs -> pr-summary
//   -> pr -> review <-> fix -> pr-summary #2 -> judge -> report
//
// Effects outside the session are made safe to repeat: tracker statuses and pushes are idempotent,
// the PR is looked up before it is created, and comments are memoized before they are posted (a
// crash in between loses a comment rather than posting it twice).
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	type JsonObject,
	defineExtension,
	defineTask,
	type ModelRef,
	ProviderDoc,
	type RunningTask,
	type TaskRuntime,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { addEvent, type Revision, StepDoc, type StepRecord, type StepUsage, type Ticket, TicketDoc, type TicketEvent, TicketIndex } from "./docs.ts";
import { type EnvFactory, ensureContainer, removeContainer } from "./env.ts";
import { branchName, cellEnv, currentBranch, type GitIdentity, freezeTests, git, gitOk, head, prepareWorktree, push, run, testsKept, writeGuardHooks } from "./git.ts";
import { learn, learnedVerify, learnVerify, readLessons } from "./lessons.ts";
import { formatFindings, redact, scanBranch } from "./secrets.ts";
import type { GitHost } from "./github.ts";
import { family, type Lanes, modelName, pickModel } from "./lanes.ts";
import { buildPrompt, hasRole, STEP_EXTENSIONS } from "./roles.ts";
import { steFaults, steRoles } from "./ste.ts";
import { TicketGone, type Tracker } from "./tracker.ts";

export type PipelineDeps = {
	readonly config: Config;
	readonly tracker: Tracker;
	readonly gitHost: GitHost;
	readonly lanes: Lanes;
	readonly models: Models;
	readonly envFor: EnvFactory;
	readonly identity: GitIdentity;
	readonly log: (line: string) => void;
	/** How often the gate checks for your approval (ms); the tracker is asked every 12th time. */
	readonly gatePollMs?: number;
	/** How often a queued ticket checks for a free slot (ms). */
	readonly admitPollMs?: number;
};

export type PipelineInput = {
	readonly ticketId: string;
	/** Wait for your approval of the spec before building. */
	readonly gate: boolean;
	/** Start with the build: the spec was approved in an earlier run. */
	readonly build: boolean;
	/** Start over: new worktree from the base branch, old outputs removed. */
	readonly fresh: boolean;
};

type Step = { role: string; round: number; attempt: number; conversationId: number; model: string; started: number };
type Phase =
	| "start" | "admit" | "fetch" | "worktree" | "spec" | "plan" | "post-spec" | "gate" | "setup" | "verify-base"
	| "test" | "code" | "verify-code" | "docs" | "pr-summary" | "pr" | "review" | "fix" | "push-fix" | "pr-summary-2" | "judge" | "report";
export type Checkpoint = {
	phase: Phase;
	/** The running agent step, or null between steps. */
	step: Step | null;
	/** HEAD when the phase's first attempt started: readers must leave it there. */
	stepHead: string | null;
	/** Review round (1-based) for review and fix; coder try for code (1 or 2). */
	round: number;
	fixed: boolean;
	verdict: "PASS" | "FIX" | null;
	baselineRed: boolean;
	frozen: Record<string, string>;
	/** Polls of a waiting phase (gate, admit): a waiting phase must commit a changed checkpoint. */
	polls: number;
	setupDone: boolean;
	freshDone: boolean;
	/** The coordinator is repairing a failure of this phase (its step is `coordinate-<n>`); the phase runs again after. */
	repair?: { n: number; phase: Phase; kind: string; resume?: Step | null } | null;
	/** Repairs so far in this run, per phase (MAX_REPAIRS each). */
	repairs?: Record<string, number>;
};
export type PipelineResult = { outcome: "in_review" | "draft" | "waiting" | "needs_input" | "blocked"; pr: string | null; reason: string | null };

/** The phases in the order a run goes through them, with what each does (the dashboard's timeline). */
export const PHASES: readonly { phase: Phase; label: string }[] = [
	{ phase: "start", label: "Start" },
	{ phase: "admit", label: "Wait for a free slot" },
	{ phase: "fetch", label: "Fetch the ticket" },
	{ phase: "worktree", label: "Prepare the worktree" },
	{ phase: "spec", label: "Write the spec" },
	{ phase: "plan", label: "Plan" },
	{ phase: "post-spec", label: "Post the spec" },
	{ phase: "gate", label: "Wait for your approval" },
	{ phase: "setup", label: "Set up (SETUP_CMD)" },
	{ phase: "verify-base", label: "Check the base branch" },
	{ phase: "test", label: "Write failing tests" },
	{ phase: "code", label: "Write the code" },
	{ phase: "verify-code", label: "Verify the code" },
	{ phase: "docs", label: "Docs" },
	{ phase: "pr-summary", label: "PR summary" },
	{ phase: "pr", label: "Open the PR" },
	{ phase: "review", label: "Review" },
	{ phase: "fix", label: "Fix review findings" },
	{ phase: "push-fix", label: "Push the fixes" },
	{ phase: "pr-summary-2", label: "Update the PR summary" },
	{ phase: "judge", label: "Judge" },
	{ phase: "report", label: "Report" },
];
const label = (phase: string) => PHASES.find((p) => p.phase === phase)?.label ?? phase;

/** "2m 05s" */
export const duration = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
/** One step's model use (its conversation's pi.usage), summed over its models. */
export function sumUsage(state: { models: Record<string, UsageTotals> } | undefined): StepUsage | null {
	if (state === undefined) return null;
	const out: StepUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
	for (const u of Object.values(state.models)) {
		out.input += u.input;
		out.output += u.output;
		out.cacheRead += u.cacheRead;
		out.cacheWrite += u.cacheWrite;
		out.tokens += u.totalTokens;
		out.cost += u.cost.total;
	}
	return out;
}
const usageText = (u: StepUsage | null) => (u === null || u.tokens === 0 ? "" : ` · ${u.tokens >= 1000 ? `${(u.tokens / 1000).toFixed(1)}k` : u.tokens} tokens · $${u.cost.toFixed(2)}`);

const initial = (): Checkpoint => ({
	phase: "start",
	step: null,
	stepHead: null,
	round: 1,
	fixed: false,
	verdict: null,
	baselineRed: false,
	frozen: {},
	polls: 0,
	setupDone: false,
	freshDone: false,
	repair: null,
	repairs: {},
});

/** Thrown inside a phase: the ticket is blocked with this reason (posted, status S_BLOCKED). */
class Blocked extends Error {}
/**
 * A failure a code change may fix (a check that fails on the branch, a refused push, a secret the
 * scan found): the coordinator gets it with `details`, then the phase runs again (MAX_REPAIRS).
 */
class Repairable extends Blocked {
	readonly kind: string;
	readonly details: string;
	constructor(kind: string, message: string, details: string) {
		super(message);
		this.kind = kind;
		this.details = details;
	}
}
/** A check that did not finish: killed by the system (out of memory) rather than failing. */
const KILLED = /\bSIGKILL\b|\bKilled\b|JavaScript heap out of memory|\bENOMEM\b|out of memory|exit code 137\b/i;

const exists = (path: string) => stat(path).then(() => true, () => false);
const readText = (path: string) => readFile(path, "utf8").catch(() => "");
const lastLine = (text: string) => text.split("\n").map((l) => l.replace(/[ \t\r]+$/, "")).filter((l) => l !== "").at(-1) ?? "";
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

/** Files a step writes, cleared before the step starts (never when it continues after a restart). */
const OUTPUTS: Record<string, (round: number) => string[]> = {
	spec: () => ["spec.md"],
	plan: () => ["plan.md"],
	test: () => [],
	code: () => ["blocked.md"],
	docs: () => [],
	"pr-summary": () => ["pr-title.txt", "pr-body.md"],
	review: (round) => [`review-${round}.md`],
	fix: () => [],
	judge: () => ["judge.json"],
	coordinate: (round) => [`repair-${round}.md`, "blocked.md"],
};
/** Phases every run goes through before it continues where the last one stopped. */
const SETUP_PHASES = new Set<Phase>(["start", "admit", "fetch", "worktree"]);
/** Everything a fresh run removes from the run folder. */
const RUN_OUTPUTS = [
	"spec.md", "plan.md", "tests.md", "test-changes.md", "blocked.md", "docs.md", "fix-notes.md", "pr-title.txt",
	"pr-body.md", "judge.json", "judge.txt", "verify-failed.md", "guard.log",
];

export function createPipeline(deps: PipelineDeps) {
	const { config, tracker, gitHost, lanes, models } = deps;
	const gatePollMs = deps.gatePollMs ?? 5000;
	// A waiting phase (the gate, a pause, the queue) sleeps until its next poll or until it is woken:
	// an approval, a continue or a free slot takes effect at once, not at the next poll.
	const wakers = new Map<string, Set<() => void>>();
	const wake = (ticketId?: string) => {
		for (const [id, set] of wakers) if (ticketId === undefined || id === ticketId) for (const done of [...set]) done();
	};
	const nap = (ms: number, signal: AbortSignal, ticketId: string) =>
		new Promise<void>((resolve) => {
			const set = wakers.get(ticketId) ?? new Set<() => void>();
			wakers.set(ticketId, set);
			const done = () => {
				clearTimeout(timer);
				set.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener("abort", done, { once: true });
			set.add(done);
		});
	const admitPollMs = deps.admitPollMs ?? 10_000;

	type R = TaskRuntime<PipelineInput, Checkpoint, PipelineResult, object>;
	type T = RunningTask<PipelineInput, Checkpoint, PipelineResult>;
	type Edit = (ticket: Ticket) => void;

	const editTicket = async (tx: Tx, id: string, edit: Edit) => {
		const ticket = (await tx.doc(TicketDoc, id, id)) as Ticket;
		edit(ticket);
		ticket.updated = Date.now();
	};
	/** Commit the next checkpoint (merged over the current one), with ticket changes, atomically. */
	const advance = (task: T, runtime: R, context: Context, next: Partial<Checkpoint>, edit?: Edit) =>
		runtime.commit(async (tx, current) => {
			const was = current.state.checkpoint;
			const checkpoint = { ...was, ...next };
			// A new phase starts without a step (and so does a new round of the same agent).
			const entering = checkpoint.phase !== was.phase || checkpoint.round !== was.round;
			if (entering) Object.assign(checkpoint, { step: null, stepHead: null });
			await editTicket(tx, task.input.ticketId, (ticket) => {
				ticket.phase = checkpoint.phase;
				// Where a later run continues if this one is stopped or blocked.
				if (entering && !SETUP_PHASES.has(checkpoint.phase)) ticket.resume = { ...checkpoint, polls: 0 } as unknown as JsonObject;
				const rounds = checkpoint.round > 1 && (checkpoint.phase === "review" || checkpoint.phase === "fix" || checkpoint.phase === "code");
				if (entering) addEvent(ticket, { kind: "phase", text: `${label(checkpoint.phase)}${rounds ? ` (round ${checkpoint.round})` : ""}` });
				edit?.(ticket);
			});
			return { status: "running", checkpoint };
		}, context);
	const finish = async (task: T, runtime: R, context: Context, result: PipelineResult, edit: Edit) => {
		setTimeout(() => wake(), 0); // the slot frees with this commit: queued tickets look now
		// The ticket's sandbox container goes with its run (a later run makes a new one).
		const name = container(await ticketOf(task, runtime, context));
		if (name !== null) await removeContainer(name);
		await runtime.commit(async (tx) => {
			await editTicket(tx, task.input.ticketId, (ticket) => {
				edit(ticket);
				ticket.slot = null;
				ticket.paused = null;
				if (result.outcome === "in_review" || result.outcome === "draft") ticket.resume = null;
				const ended: Record<PipelineResult["outcome"], Pick<TicketEvent, "level" | "text">> = {
					in_review: { level: "info", text: `Done: PR ready for human review${result.pr ? ` (${result.pr})` : ""}` },
					draft: { level: "warn", text: "Done: the PR stays a draft, review findings remain" },
					waiting: { level: "info", text: "Waiting" },
					needs_input: { level: "warn", text: "Stopped: the spec has open questions" },
					blocked: { level: "error", text: `Blocked: ${result.reason ?? ""}` },
				};
				addEvent(ticket, { kind: "run", ...ended[result.outcome] });
			});
			return { status: "terminal", outcome: { status: "completed", result } };
		}, context);
	};

	const ticketOf = async (task: T, runtime: R, context: Context): Promise<Ticket> =>
		(await runtime.snapshot(TicketDoc, task.input.ticketId, context)) as Ticket;
	const paths = (ticket: Ticket) => ({ run: ticket.run!, worktree: ticket.worktree!, branch: ticket.branch! });
	const log = (ticket: Ticket, line: string) => deps.log(`${ticket.cid} ${line}`);
	const container = (ticket: Ticket) => (config.sandbox === "docker" ? `factory-${ticket.cid.toLowerCase().replace(/[^a-z0-9]/g, "-")}` : null);
	const cell = (ticket: Ticket) =>
		cellEnv({ cid: ticket.cid, slot: ticket.slot ?? 0, hooksDir: join(ticket.run!, "git-hooks"), portStart: config.cellPortStart, portSpan: config.cellPortSpan, identity: deps.identity });

	/** Record an event on the ticket in a commit of its own (for effects outside the session). */
	const note = (runtime: R, context: Context, ticketId: string, event: Pick<TicketEvent, "kind" | "text"> & Partial<TicketEvent>) =>
		runtime.commit(async (tx) => {
			await editTicket(tx, ticketId, (t) => addEvent(t, event));
			return undefined;
		}, context);
	const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

	/** Text the factory posts outside (PR, tracker): every secret it holds becomes [redacted], and the log says so. */
	const scrub = async (runtime: R, context: Context, ticket: Ticket, label: string, text: string): Promise<string> => {
		const out = redact(text);
		if (out.count > 0) await note(runtime, context, ticket.id, { kind: "guard", level: "warn", text: `Redacted ${out.count} possible secret(s) from ${label} before posting it` });
		return out.text;
	};
	/**
	 * Push the ticket's branch, with the guardrails: first the secret scan of everything the push would
	 * send (new lines, new files, commit messages), then git push, which runs the repo's pre-push hooks.
	 * Either failure goes to the coordinator.
	 */
	const pushSafely = async (ticket: Ticket) => {
		const tracking = `refs/remotes/origin/${ticket.branch}`;
		const since = (await git(ticket.worktree!, "rev-parse", "-q", "--verify", tracking)).code === 0 ? tracking : `refs/remotes/origin/${config.base}`;
		const findings = await scanBranch(ticket.worktree!, since);
		if (findings.length > 0) {
			throw new Repairable("secrets", `the push stopped: the secret scan found ${findings.length} possible secret(s) in what it would send`, `SINCE=${since}\n\n${formatFindings(findings)}`);
		}
		try {
			await push(ticket.worktree!, ticket.branch!);
		} catch (error) {
			throw new Repairable("push", "git push was refused (the repo's pre-push hooks, or the remote)", message(error));
		}
	};

	/** A comment on the ticket, at most once per key (memo first: a crash loses it, never doubles it). */
	const commentOnce = async (runtime: R, context: Context, ticket: Ticket, key: string, text: string, always = false) => {
		if (!(always || config.trackerComments)) return;
		if ((await runtime.memo<boolean>(`comment:${key}`, context)) !== undefined) return;
		await runtime.memo(`comment:${key}`, true, context);
		const clean = await scrub(runtime, context, ticket, "a ticket comment", text);
		const failed = await tracker.comment(ticket.id, clean.slice(0, 30_000)).then(() => null, (error: unknown) => message(error));
		if (failed !== null) log(ticket, `comment failed: ${failed}`);
		const first = text.split("\n")[0]!.slice(0, 120);
		await note(runtime, context, ticket.id, failed === null ? { kind: "tracker", text: `Comment posted on the ticket: ${first}` } : { kind: "tracker", level: "warn", text: `Comment failed: ${failed}` });
	};
	/** A run-folder file attached to the ticket as `<ticket>-<file>`, once per run (memo first, as comments). Best effort. */
	const attachOnce = async (runtime: R, context: Context, ticket: Ticket, file: string, content: string, version = "") => {
		if (!config.trackerAttach || content.trim() === "") return;
		const key = `attach:${file}${version ? `:${version}` : ""}`;
		if ((await runtime.memo<boolean>(key, context)) !== undefined) return;
		await runtime.memo(key, true, context);
		const name = `${ticket.cid}-${file}`;
		const clean = await scrub(runtime, context, ticket, name, content);
		const failed = await tracker.attach(ticket.id, name, clean).then(() => null, (error: unknown) => message(error));
		if (failed !== null) log(ticket, `attach ${name} failed: ${failed}`);
		await note(runtime, context, ticket.id, failed === null ? { kind: "tracker", text: `Attached ${name} to the ticket` } : { kind: "tracker", level: "warn", text: `Attaching ${name} failed: ${failed}` });
	};
	const setStatus = async (runtime: R, context: Context, ticket: Ticket, status: string) => {
		const failed = await tracker.setStatus(ticket.id, status).then(() => null, (error: unknown) => message(error));
		if (failed !== null) log(ticket, `status ${status} failed: ${failed}`);
		await note(runtime, context, ticket.id, failed === null ? { kind: "tracker", text: `Ticket status: ${status}` } : { kind: "tracker", level: "warn", text: `Ticket status ${status} failed: ${failed}` });
	};

	/** Run a command in the ticket's environment (its container in docker mode); output to RUN/<logName>. */
	const exec = async (ticket: Ticket, command: string, logName: string, context: Context): Promise<number> => {
		const env = deps.envFor({ worktree: ticket.worktree!, run: ticket.run!, cell: cell(ticket), container: container(ticket) });
		const file = join(ticket.run!, logName);
		await writeFile(file, "");
		let pending = Promise.resolve();
		const result = await env.exec(command, {
			cwd: ticket.worktree!,
			timeout: Math.max(1, Math.round(config.agentTimeoutMs / 1000)),
			onOutput: (text) => {
				pending = pending.then(() => appendFile(file, text));
			},
		}, context);
		await pending;
		if (!result.ok) {
			await appendFile(file, `\n[factory] ${result.error.code}: ${result.error.message}\n`);
			return 124;
		}
		return result.value.exitCode;
	};

	/**
	 * verify <round>: the factory runs VERIFY_CMD itself and does not take an agent's word. Round 1 is
	 * the untouched base branch; when that already fails the gate only reports.
	 */
	const verify = async (ticket: Ticket, round: number, baselineRed: boolean, context: Context): Promise<{ ok: boolean; killed: boolean; tail: string }> => {
		if (!config.verifyCmd) return { ok: true, killed: false, tail: "" };
		const code = await exec(ticket, await verifyCommand(), `verify-${round}.log`, context);
		const failed = join(ticket.run!, "verify-failed.md");
		const tail = (await readText(join(ticket.run!, `verify-${round}.log`))).split("\n").slice(-120).join("\n");
		// Killed (out of memory, SIGKILL) is no result at all: never a red base, and not the code's fault.
		const killed = code !== 0 && KILLED.test(tail);
		if (code === 0 || baselineRed) await rm(failed, { force: true });
		else {
			await writeFile(failed, `The factory ran VERIFY_CMD (${config.verifyCmd}) on HEAD ${(await head(ticket.worktree!)).slice(0, 12)} and it failed (exit ${code}). Last lines:\n\n\`\`\`\n${tail.split("\n").slice(-80).join("\n")}\n\`\`\`\n`);
		}
		return { ok: code === 0, killed, tail };
	};
	const KILLED_HELP = `give the sandbox more memory (SANDBOX_ARGS="--memory 8g", and Docker's own memory limit) or lower the check's parallelism, then Run again`;
	/** VERIFY_CMD, or the way to run it that the coordinator found fits this machine. */
	const verifyCommand = async () => (await learnedVerify(config.stateDir, config.verifyCmd)) ?? config.verifyCmd;
	/** The coordinator can still take a failure of this phase. */
	const canRepair = async (task: T, phase: Phase) => config.maxRepairs > 0 && ((task.state.checkpoint.repairs ?? {})[phase] ?? 0) < config.maxRepairs && (await hasRole(config.here, "coordinate"));

	/**
	 * Start the next attempt of a step: pick its model (the first usable one in the role's lane that
	 * has not failed this step), clear its outputs, and create its conversation in the same commit
	 * that records it in the checkpoint. Throws Blocked when no model is left.
	 */
	const startStep = async (task: T, runtime: R, context: Context, role: string, round: number): Promise<void> => {
		const cp = task.state.checkpoint;
		const ticket = await ticketOf(task, runtime, context);
		const { run, worktree } = paths(ticket);
		const earlier = ticket.steps.filter((s) => s.role === role && s.round === round);
		const attempt = earlier.length + 1;
		const coder = ticket.steps.findLast((s) => s.role === "code" && s.status === "done");
		const avoid = (role === "review" || role === "judge") && coder ? family(parseRef(coder.model)) : null;
		// A model that failed this step in this run is skipped; a later run tries it again.
		const failed = new Set(earlier.filter((s) => s.status === "failed" && s.taskId === task.id).map((s) => s.model));
		const skip = (m: ModelRef) => (failed.has(modelName(m)) ? "failed earlier in this step" : null);
		let { model, skipped } = await pickModel({ lanes, models, role, attempt: 1, avoidFamily: avoid, skip });
		if (model === null && avoid !== null) {
			// No other model family has a login: a reviewer of the coder's family beats no review.
			const same = await pickModel({ lanes, models, role, attempt: 1, avoidFamily: null, skip });
			if (same.model !== null) {
				model = same.model;
				skipped = [...skipped, `no other model family has a login, so ${modelName(same.model)} reviews code of its own family (${avoid})`];
				log(ticket, `${role}-${round}: ${skipped.at(-1)}`);
			}
		}
		if (skipped.length > 0) {
			await appendFile(join(run, "route.log"), `${new Date().toISOString()} ${role}-${round}-${attempt}: ${skipped.join("; ")}\n`);
			await note(runtime, context, ticket.id, { kind: "step", level: "warn", step: `${role}-${round}-${attempt}`, text: `Models skipped: ${skipped.join("; ")}` });
		}
		if (model === null) throw new Blocked(`no model left for the ${role} agent: every model in its lane failed or has no login (see route.log)`);
		// A new attempt starts clean: its old outputs go, so a missing output is this attempt's fault.
		for (const file of OUTPUTS[role]?.(round) ?? []) await rm(join(run, file), { force: true });
		const stepHead = cp.stepHead ?? (await head(worktree));
		const name = `${role}-${round}-${attempt}`;
		await runtime.commit(async (tx, current) => {
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
			await configure(tx, conversation.id, { model, cwd: worktree, extensions: STEP_EXTENSIONS, tools: null, modelTools: null });
			Object.assign(await tx.doc(StepDoc, conversation.id), { ticketId: ticket.id, name, role, worktree, run, slot: ticket.slot ?? 0 });
			// The provider session id the step's requests carry: the throttle holds a paused ticket's requests by it.
			const { sessionId } = await tx.doc(ProviderDoc, conversation.id);
			const record: StepRecord = {
				name, role, round, attempt, model: modelName(model), conversationId: conversation.id, taskId: task.id,
				status: "running", started: Date.now(), ended: null, error: null, sessionId, pausedMs: 0, usage: null,
			};
			await editTicket(tx, ticket.id, (t) => {
				t.steps.push(record);
				addEvent(t, { kind: "step", step: name, text: `${name} started on ${modelName(model)}` });
			});
			const step: Step = { role, round, attempt, conversationId: conversation.id, model: modelName(model), started: record.started };
			return { status: "running", checkpoint: { ...current.state.checkpoint, step, stepHead } };
		}, context);
		log(ticket, `${name} on ${modelName(model)}`);
	};

	/**
	 * Submit the recorded step's prompt under its request ID and wait for the answer. After a restart
	 * the same request ID finds the same submission, so the agent continues where it stopped.
	 * AGENT_TIMEOUT bounds the step: the conversation is stopped and the attempt fails.
	 */
	const awaitStep = async (task: T, runtime: R, context: Context, step: Step): Promise<boolean> => {
		const ticket = await ticketOf(task, runtime, context);
		const { run, worktree, branch } = paths(ticket);
		const name = `${step.role}-${step.round}-${step.attempt}`;
		const handle = await runtime.conversation(step.conversationId as ConversationId, context);
		if (handle === undefined) throw new Blocked(`the conversation of step ${name} is gone`);
		const prompt = await buildPrompt({
			here: config.here, role: step.role, round: step.round, cid: ticket.cid, branch, base: config.base, run, worktree, pr: ticket.pr,
			verifyCmd: config.verifyCmd, portBase: config.cellPortStart + (ticket.slot ?? 0) * config.cellPortSpan,
			portSpan: config.cellPortSpan, repoSkillDirs: config.repoSkillDirs, skillsPath: config.skillsPath,
			lessons: await readLessons(config.stateDir, step.role),
			log: (line) => log(ticket, line),
		});
		const submission = await handle.submit({ type: "input", content: prompt, requestId: `step:${name}` }, context);
		// AGENT_TIMEOUT counts the step's own time: time the ticket spent paused moves the deadline.
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watching = true;
		const deadline = async () => {
			const t = await ticketOf(task, runtime, context);
			const record = t.steps.find((s) => s.name === name);
			return step.started + config.agentTimeoutMs + (record?.pausedMs ?? 0) + (t.paused ? Date.now() - t.paused.at : 0);
		};
		const watch = (ms: number) => {
			timer = setTimeout(async () => {
				if (!watching) return;
				const left = (await deadline().catch(() => Date.now() + 30_000)) - Date.now();
				if (!watching) return;
				if (left > 0) return watch(Math.min(left, 30_000));
				timedOut = true;
				void handle.abort(context).catch(() => undefined);
			}, ms);
		};
		watch(Math.max(1000, Math.min((await deadline()) - Date.now(), 30_000)));
		let settled;
		try {
			settled = await submission.wait(context);
		} finally {
			watching = false;
			clearTimeout(timer);
		}
		const ok = settled.status === "done";
		const error = ok ? null : timedOut ? `timed out after ${Math.round(config.agentTimeoutMs / 1000)}s` : (settled.reason ?? "failed");
		if (!ok) log(ticket, `${name} on ${step.model} failed: ${error}`);
		const usage = sumUsage(await runtime.snapshot(UsageDoc, step.conversationId as ConversationId, context).catch(() => undefined));
		await runtime.commit(async (tx) => {
			await editTicket(tx, ticket.id, (t) => {
				const record = t.steps.find((s) => s.name === name);
				if (record === undefined || record.status !== "running") return;
				Object.assign(record, { status: ok ? "done" : "failed", ended: Date.now(), error, usage });
				const took = duration(Date.now() - record.started - (record.pausedMs ?? 0));
				addEvent(t, ok
					? { kind: "step", step: name, text: `${name} done in ${took}${usageText(usage)}` }
					: { kind: "step", step: name, level: "error", text: `${name} failed after ${took}: ${error}${usageText(usage)}` });
			});
			return undefined;
		}, context);
		return ok;
	};

	/**
	 * The phase's agent step. Returns true once it answered: the phase then checks its outputs and
	 * moves on. Returns false after starting an attempt (the first, or the next after a failure): the
	 * phase runs again from that checkpoint and waits for it.
	 */
	const runAgent = async (task: T, runtime: R, context: Context, role: string, round: number): Promise<boolean> => {
		const step = task.state.checkpoint.step;
		if (step !== null && step.role === role && step.round === round && (await awaitStep(task, runtime, context, step))) return true;
		await startStep(task, runtime, context, role, round);
		return false;
	};

	/**
	 * Send `content` to a step's conversation (one that already answered) and wait for the answer.
	 * The request ID makes it safe to repeat: after a restart the same submission is found.
	 */
	const ask = async (runtime: R, context: Context, conversationId: number, content: string, requestId: string): Promise<string | null> => {
		const handle = await runtime.conversation(conversationId as ConversationId, context);
		if (handle === undefined) return "its conversation is gone";
		const submission = await handle.submit({ type: "input", content, requestId }, context);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), config.agentTimeoutMs)));
		const settled = await Promise.race([submission.wait(context), timeout]).finally(() => clearTimeout(timer));
		if (settled === "timeout") {
			await handle.abort(context).catch(() => undefined);
			return `timed out after ${Math.round(config.agentTimeoutMs / 1000)}s`;
		}
		return settled.status === "done" ? null : (settled.reason ?? "failed");
	};
	/** A step's usage again (its conversation answered more since it ended). */
	const refreshUsage = async (runtime: R, context: Context, ticketId: string, step: StepRecord) => {
		const usage = sumUsage(await runtime.snapshot(UsageDoc, step.conversationId as ConversationId, context).catch(() => undefined));
		await runtime.commit(async (tx) => {
			await editTicket(tx, ticketId, (t) => {
				const record = t.steps.find((s) => s.name === step.name);
				if (record) record.usage = usage;
			});
			return undefined;
		}, context);
	};
	/**
	 * Simplified Technical English: lint a file a role in STE_ROLES wrote. Hard faults go back to its
	 * author once (a write through bash is not gated by the hook); what still fails is logged, not blocked.
	 */
	const steCheck = async (runtime: R, context: Context, ticket: Ticket, file: string, step: StepRecord, tag: string) => {
		if (!steRoles().has(step.role)) return;
		const path = join(ticket.run!, file);
		let faults = steFaults(path, await readText(path));
		if (faults.hard === 0) return;
		await note(runtime, context, ticket.id, { kind: "ste", level: "warn", step: step.name, text: `${file} breaks ${faults.hard} Simplified Technical English rule(s): ${step.name} fixes them` });
		const failed = await ask(runtime, context, step.conversationId, `${faults.reason}\n\nThe factory checked RUN_DIR/${file}. Rewrite the sentences named above in RUN_DIR/${file}, with the write or edit tool. Keep the meaning. Change nothing else. Reply with one short line.`, `ste:${tag}`);
		faults = steFaults(path, await readText(path));
		await note(runtime, context, ticket.id, faults.hard === 0
			? { kind: "ste", step: step.name, text: `${file} now follows Simplified Technical English` }
			: { kind: "ste", level: "warn", step: step.name, text: `${file} still breaks ${faults.hard} rule(s)${failed ? ` (${failed})` : ""}: see the log of ${step.name}` });
	};
	const latestDone = (ticket: Ticket, role: string) => ticket.steps.findLast((s) => s.role === role && s.status === "done");
	/** A change you asked for at the gate: the spec writer (or the planner) makes it; a spec change then goes to the planner. */
	const revise = async (task: T, runtime: R, context: Context, ticket: Ticket, rev: Revision) => {
		const mark = (change: (r: Revision, t: Ticket) => void) =>
			runtime.commit(async (tx) => {
				await editTicket(tx, ticket.id, (t) => {
					const r = t.revisions?.find((x) => x.id === rev.id);
					if (r) change(r, t);
				});
				return undefined;
			}, context);
		if (rev.status === "queued") await mark((r, t) => {
			r.status = "running";
			addEvent(t, { kind: "gate", text: `Revising ${rev.file}: ${rev.comment.slice(0, 200)}` });
		});
		const before = await head(ticket.worktree!);
		const files = rev.file === "spec.md" ? ["spec.md", "plan.md"] : ["plan.md"];
		const quote = rev.quote.trim() ? `The part they selected:\n${rev.quote.trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n` : "";
		let error: string | null = null;
		for (const file of files) {
			const step = latestDone(ticket, file === "spec.md" ? "spec" : "plan");
			if (step === undefined) {
				error = `no ${file === "spec.md" ? "spec writer" : "planner"} step to ask`;
				break;
			}
			const prompt = file === rev.file
				? `A person reviewing ${file} before they approve it asks for a change.\n\n${quote}Their request:\n${rev.comment.trim()}\n\nUpdate RUN_DIR/${file} with the write or edit tool: make this change, and keep the rest unless the change needs more. Keep the format your first instructions give (also the Diagram section${file === "spec.md" ? " and the last STATUS line" : ""}). Reply with one short line that says what you changed.`
				: `The spec changed after a review (RUN_DIR/spec.md). The change they asked for: ${rev.comment.trim()}\n\nRead spec.md again and update RUN_DIR/plan.md so it matches it: the tests and files for new or changed acceptance criteria, and the Diagram. Change nothing else. Reply with one short line.`;
			const failed = await ask(runtime, context, step.conversationId, prompt, `revise:${rev.id}:${file}`);
			await refreshUsage(runtime, context, ticket.id, step);
			if (failed !== null) {
				error = `${step.name}: ${failed}`;
				break;
			}
			await steCheck(runtime, context, ticket, file, step, `revise:${rev.id}:${file}`);
		}
		if (error === null && (await head(ticket.worktree!)) !== before) error = "an agent committed to the branch, but it may only read";
		await mark((r, t) => {
			Object.assign(r, { status: error === null ? "done" : "failed", ended: Date.now(), error });
			addEvent(t, error === null
				? { kind: "gate", text: `${rev.file} revised${rev.file === "spec.md" ? ", and plan.md updated to match" : ""}` }
				: { kind: "gate", level: "error", text: `The change to ${rev.file} failed: ${error}` });
		});
	};

	const readOnly = async (ticket: Ticket, stepHead: string | null, label: string) => {
		if (stepHead !== null && (await head(ticket.worktree!)) !== stepHead) throw new Blocked(`${label} committed to ${ticket.branch}, but it may only read`);
	};
	const onBranch = async (ticket: Ticket, label: string) => {
		if ((await currentBranch(ticket.worktree!)) !== ticket.branch) throw new Blocked(`${label} left branch ${ticket.branch}`);
	};
	const keptTests = async (ticket: Ticket, frozen: Record<string, string>, label: string) => {
		const { gone, changed } = await testsKept(ticket.worktree!, frozen, await readText(join(ticket.run!, "test-changes.md")));
		if (gone.length > 0) throw new Blocked(`${label} deleted tests written from the spec: ${gone.join(" ")}`);
		if (changed.length > 0) throw new Blocked(`${label} changed tests written from the spec without naming them in test-changes.md: ${changed.join(" ")}`);
	};

	type Handler = (task: T, runtime: R, context: Context) => Promise<void>;
	const phases: Record<Phase, Handler> = {
		start: async (task, runtime, context) => {
			const info = await tracker.info(task.input.ticketId);
			const run = join(config.runsDir, info.cid);
			await mkdir(run, { recursive: true });
			const old = await ticketOf(task, runtime, context);
			const fresh = task.input.fresh && !task.state.checkpoint.freshDone;
			if (fresh) for (const file of RUN_OUTPUTS) await rm(join(run, file), { force: true });
			const branch = !fresh && old.branch ? old.branch : await freeBranch(config.repo, branchName(info.cid, info.title, config.branchType), old.branch !== null);
			await advance(task, runtime, context, { phase: "admit", freshDone: true }, (t) => {
				Object.assign(t, { cid: info.cid, title: info.title, url: info.url, branch, run, worktree: join(config.treesDir, info.cid), blocked: null });
				t.state = "queued";
				if (fresh) Object.assign(t, { specStatus: null, approved: null, verify: [], reviews: [], pr: null, judge: null, resume: null });
				if (task.input.build) t.mode = "build";
			});
		},
		admit: async (task, runtime, context) => {
			// MAX_PARALLEL tickets at once, each with its own cell slot (ports). Decided in one commit.
			let admitted = false;
			await runtime.commit(async (tx, current) => {
				const index = await tx.doc(TicketIndex);
				const busy = new Set<number>();
				let running = 0;
				for (const id of index.ids) {
					if (id === task.input.ticketId) continue;
					const other = (await tx.doc(TicketDoc, id, id)) as Ticket;
					if (other.slot !== null) {
						busy.add(other.slot);
						running++;
					}
				}
				const free = Array.from({ length: config.slots }, (_, i) => i).find((i) => !busy.has(i));
				const checkpoint = current.state.checkpoint;
				if (running >= config.maxParallel || free === undefined) {
					return { status: "running", checkpoint: { ...checkpoint, polls: checkpoint.polls + 1 } };
				}
				admitted = true;
				await editTicket(tx, task.input.ticketId, (t) => {
					t.slot = free;
					t.state = "running";
					t.phase = "fetch";
					addEvent(t, { kind: "phase", text: `${label("fetch")} (cell slot ${free})` });
				});
				return { status: "running", checkpoint: { ...checkpoint, phase: "fetch", polls: 0 } };
			}, context);
			if (!admitted) await nap(admitPollMs, runtime.signal, task.input.ticketId);
		},
		fetch: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			await setStatus(runtime, context, ticket, config.statuses.working);
			const { ticket: md, comments } = await tracker.fetch(ticket.id);
			await writeFile(join(ticket.run!, "ticket.md"), md);
			await writeFile(join(ticket.run!, "comments.md"), comments);
			await advance(task, runtime, context, { phase: "worktree" });
		},
		worktree: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			// Fresh: cut again from the base. If this phase runs twice (a crash before its checkpoint),
			// nothing has happened in the new worktree yet, so cutting it again is harmless.
			const how = await prepareWorktree(config.repo, config.base, ticket.branch!, ticket.worktree!, task.input.fresh);
			await writeGuardHooks(config.repo, ticket.run!, ticket.cid, ticket.branch!);
			const name = container(ticket);
			if (name !== null) {
				await ensureContainer({
					name, image: config.sandboxImage, worktree: ticket.worktree!, run: ticket.run!,
					gitDir: await gitOk(config.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
					cacheVolume: config.cacheVolume, extraArgs: config.sandboxArgs,
				});
			}
			log(ticket, `worktree ${how} on ${ticket.branch}`);
			await note(runtime, context, ticket.id, { kind: "git", text: `Worktree ${how} on ${ticket.branch}` });
			// A run after one that was stopped or blocked continues where that one was.
			if (ticket.resume !== null && !task.input.fresh) {
				const resume = ticket.resume as unknown as Checkpoint;
				log(ticket, `continues at ${resume.phase} (round ${resume.round}), where the last run stopped`);
				await note(runtime, context, ticket.id, { kind: "run", text: `Continues at "${label(resume.phase)}", where the last run stopped` });
				await advance(task, runtime, context, { ...resume, step: null, stepHead: null, polls: 0, freshDone: true });
				return;
			}
			const build = task.input.build || ticket.approved !== null;
			if (build && !(await exists(join(ticket.run!, "spec.md")))) throw new Blocked("no spec.md in the run folder: run the spec stage first");
			await advance(task, runtime, context, { phase: build ? "setup" : "spec", polls: 0 });
		},
		spec: async (task, runtime, context) => {
			if (!(await runAgent(task, runtime, context, "spec", 1))) return;
			let ticket = await ticketOf(task, runtime, context);
			await steCheck(runtime, context, ticket, "spec.md", latestDone(ticket, "spec")!, "spec");
			ticket = await ticketOf(task, runtime, context);
			await readOnly(ticket, task.state.checkpoint.stepHead, "spec writer");
			const spec = await readText(join(ticket.run!, "spec.md"));
			if (spec.trim() === "") throw new Blocked("spec writer wrote no spec.md");
			const status = lastLine(spec) === "STATUS: NEEDS_INPUT" ? "NEEDS_INPUT" : "READY";
			if (status === "NEEDS_INPUT") {
				await commentOnce(runtime, context, ticket, "needs-input", `Spec needs input before coding:\n\n${spec}`, true);
				await setStatus(runtime, context, ticket, config.statuses.blocked);
				await finish(task, runtime, context, { outcome: "needs_input", pr: null, reason: "the spec writer needs answers" }, (t) => {
					Object.assign(t, { specStatus: status, state: "blocked", blocked: "the spec has open questions: answer them in the ticket, then run it again", phase: "spec" });
				});
				return;
			}
			await advance(task, runtime, context, { phase: "plan", step: null }, (t) => {
				t.specStatus = status;
			});
		},
		plan: async (task, runtime, context) => {
			if (!(await runAgent(task, runtime, context, "plan", 1))) return;
			const ticket = await ticketOf(task, runtime, context);
			await steCheck(runtime, context, ticket, "plan.md", latestDone(ticket, "plan")!, "plan");
			await readOnly(ticket, task.state.checkpoint.stepHead, "planner");
			if ((await readText(join(ticket.run!, "plan.md"))).trim() === "") throw new Blocked("planner wrote no plan.md");
			await advance(task, runtime, context, { phase: "post-spec", step: null });
		},
		"post-spec": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const spec = await readText(join(ticket.run!, "spec.md"));
			const plan = await readText(join(ticket.run!, "plan.md"));
			// With the gate, the versions you approve are attached (setup); without it, these are final.
			if (!task.input.gate) {
				await attachOnce(runtime, context, ticket, "spec.md", spec);
				await attachOnce(runtime, context, ticket, "plan.md", plan);
			}
			await commentOnce(runtime, context, ticket, "spec", `SPEC\n\n${spec}\n\nPLAN\n\n${plan}`);
			if (task.input.gate) {
				await setStatus(runtime, context, ticket, config.statuses.specReview);
				await advance(task, runtime, context, { phase: "gate", polls: 0 }, (t) => {
					t.state = "waiting_approval";
				});
			} else {
				await setStatus(runtime, context, ticket, config.statuses.approved);
				await advance(task, runtime, context, { phase: "setup", polls: 0 });
			}
		},
		gate: async (task, runtime, context) => {
			// Waits durably for you: Approve on the dashboard (`ff approve`), or move the ticket to S_APPROVED.
			let ticket = await ticketOf(task, runtime, context);
			const polls = task.state.checkpoint.polls;
			// A change you asked for on the spec or the plan comes before your approval.
			const pending = (ticket.revisions ?? []).find((r) => r.status === "queued" || r.status === "running");
			if (pending !== undefined) {
				await revise(task, runtime, context, ticket, pending);
				await advance(task, runtime, context, { polls: polls + 1 });
				return;
			}
			if (ticket.approved === null && polls % 12 === 0) {
				const status = await tracker.info(ticket.id).then((i) => i.status, () => "");
				if (status.toLowerCase() === config.statuses.approved.toLowerCase()) {
					await runtime.commit(async (tx) => {
						await editTicket(tx, ticket.id, (t) => {
							t.approved ??= { at: Date.now(), note: "" };
							addEvent(t, { kind: "gate", text: `Spec approved: the ticket was moved to ${config.statuses.approved}` });
						});
						return undefined;
					}, context);
					ticket = await ticketOf(task, runtime, context);
				}
			}
			if (ticket.approved === null) {
				await advance(task, runtime, context, { polls: polls + 1 });
				await nap(gatePollMs, runtime.signal, ticket.id);
				return;
			}
			// Your comments go to the coder: fetch them again.
			const { ticket: md, comments } = await tracker.fetch(ticket.id);
			await writeFile(join(ticket.run!, "ticket.md"), md);
			await writeFile(join(ticket.run!, "comments.md"), ticket.approved.note ? `${comments}\n[approval note] ${ticket.approved.note}\n` : comments);
			await setStatus(runtime, context, ticket, config.statuses.working);
			await advance(task, runtime, context, { phase: "setup", polls: 0 }, (t) => {
				t.state = "running";
			});
		},
		setup: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			// Every way of approving (dashboard, ff approve, the tracker's status, approving an ended run)
			// passes here: the spec and plan you approved go onto the ticket, once per approval.
			if (ticket.approved !== null && ticket.attachedApproval !== ticket.approved.at) {
				for (const file of ["spec.md", "plan.md"]) await attachOnce(runtime, context, ticket, file, await readText(join(ticket.run!, file)), `approved-${ticket.approved.at}`);
				const at = ticket.approved.at;
				await runtime.commit(async (tx) => {
					await editTicket(tx, ticket.id, (t) => {
						t.attachedApproval = at;
					});
					return undefined;
				}, context);
			}
			if (config.setupCmd && !task.state.checkpoint.setupDone) {
				const code = await exec(ticket, config.setupCmd, "setup.log", context);
				if (code !== 0) throw new Blocked(`SETUP_CMD failed (exit ${code}), see setup.log`);
			}
			await advance(task, runtime, context, { phase: "verify-base", setupDone: true });
		},
		"verify-base": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const { ok, killed, tail } = await verify(ticket, 1, false, context);
			// Killed (out of memory): the coordinator finds a way to run the same check that fits.
			if (killed && (await canRepair(task, "verify-base"))) {
				throw new Repairable("killed", `VERIFY_CMD was killed on ${config.base} (out of memory or SIGKILL)`, `$ ${await verifyCommand()}\n${tail}`);
			}
			// Only a real failure makes the base red; a killed run says nothing, so the gate stays on.
			const red = !ok && !killed;
			if (red) log(ticket, `origin/${config.base} already fails VERIFY_CMD (verify-1.log): the verify gate will report, not block`);
			await advance(task, runtime, context, { phase: "test", baselineRed: red }, (t) => {
				if (!config.verifyCmd) return;
				t.verify.push({ round: 1, ok, log: "verify-1.log" });
				addEvent(t, ok ? { kind: "verify", text: `VERIFY_CMD passes on ${config.base}` }
					: killed ? { kind: "verify", level: "warn", text: `VERIFY_CMD was killed on ${config.base} (out of memory or SIGKILL, verify-1.log): no result, so the gate stays on. To fix: ${KILLED_HELP}` }
					: { kind: "verify", level: "warn", text: `${config.base} already fails VERIFY_CMD (verify-1.log): the verify gate will report, not block` });
			});
		},
		test: async (task, runtime, context) => {
			if (!(await runAgent(task, runtime, context, "test", 1))) return;
			const ticket = await ticketOf(task, runtime, context);
			if ((await readText(join(ticket.run!, "tests.md"))).trim() === "") throw new Blocked("test writer wrote no tests.md");
			await onBranch(ticket, "test writer");
			const frozen = await freezeTests(ticket.worktree!, config.base);
			await writeFile(join(ticket.run!, "test-files.sha256"), Object.entries(frozen).map(([f, h]) => `${h} ${f}\n`).join(""));
			await advance(task, runtime, context, { phase: "code", step: null, round: 1, frozen });
		},
		code: async (task, runtime, context) => {
			const round = task.state.checkpoint.round;
			if (!(await runAgent(task, runtime, context, "code", round))) return;
			const ticket = await ticketOf(task, runtime, context);
			const blocked = await readText(join(ticket.run!, "blocked.md"));
			// The coordinator looks first: a tool or the sandbox that failed works again, and it finishes the
			// job; a real question about the spec stays a stop.
			if (blocked.trim() !== "") throw new Repairable("blocked", `coder blocked: ${blocked.slice(0, 1500)}`, blocked);
			await onBranch(ticket, "coder");
			await keptTests(ticket, task.state.checkpoint.frozen, "coder");
			if ((await gitOk(ticket.worktree!, "rev-list", "--count", `refs/remotes/origin/${config.base}..HEAD`)) === "0") throw new Blocked("coder made no commits");
			await advance(task, runtime, context, { phase: "verify-code", step: null });
		},
		"verify-code": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const cp = task.state.checkpoint;
			const round = cp.round === 1 ? 2 : 3;
			const { ok, killed, tail } = await verify(ticket, round, cp.baselineRed, context);
			if (killed && (await canRepair(task, "verify-code"))) throw new Repairable("killed", `VERIFY_CMD was killed (out of memory or SIGKILL, verify-${round}.log)`, `$ ${await verifyCommand()}\n${tail}`);
			if (killed) throw new Blocked(`VERIFY_CMD was killed (out of memory or SIGKILL, verify-${round}.log): ${KILLED_HELP}`);
			const record = (t: Ticket) => {
				if (!config.verifyCmd) return;
				t.verify.push({ round, ok, log: `verify-${round}.log` });
				addEvent(t, { kind: "verify", level: ok ? "info" : cp.baselineRed ? "warn" : "error", text: `VERIFY_CMD ${ok ? "passes" : "fails"} after the coder's ${cp.round === 1 ? "first" : "second"} try (verify-${round}.log)` });
			};
			if (ok || cp.baselineRed) {
				await advance(task, runtime, context, { phase: "docs", round: 1 }, record);
			} else if (cp.round === 1) {
				// The coder gets one more fresh session with the failure (verify-failed.md).
				await advance(task, runtime, context, { phase: "code", round: 2 }, record);
			} else {
				throw new Repairable("verify", "VERIFY_CMD still fails after the coder's second try, see verify-3.log", `$ ${config.verifyCmd}\n${tail}`);
			}
		},
		docs: async (task, runtime, context) => {
			if (await hasRole(config.here, "docs")) {
				if (!(await runAgent(task, runtime, context, "docs", 1))) return;
				await onBranch(await ticketOf(task, runtime, context), "docs writer");
			}
			await advance(task, runtime, context, { phase: "pr-summary", step: null });
		},
		"pr-summary": async (task, runtime, context) => {
			if (!(await runAgent(task, runtime, context, "pr-summary", 1))) return;
			const ticket = await ticketOf(task, runtime, context);
			if (!(await readText(join(ticket.run!, "pr-title.txt"))).trim() || !(await readText(join(ticket.run!, "pr-body.md"))).trim()) {
				throw new Blocked("PR summary writer wrote no title or body");
			}
			await advance(task, runtime, context, { phase: "pr", step: null });
		},
		pr: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			await pushSafely(ticket);
			let pr = ticket.pr ?? (await gitHost.prFor(ticket.worktree!, ticket.branch!));
			if (pr === null) {
				const title = await scrub(runtime, context, ticket, "the PR title", (await readText(join(ticket.run!, "pr-title.txt"))).trim());
				const body = await scrub(runtime, context, ticket, "the PR body", await readText(join(ticket.run!, "pr-body.md")));
				pr = await gitHost.createDraft(ticket.worktree!, config.base, ticket.branch!, title, body);
				if (config.prLabel) await gitHost.addLabel(ticket.worktree!, pr, config.prLabel).catch((e) => log(ticket, `label: ${e instanceof Error ? e.message : e}`));
			}
			log(ticket, `PR ${pr}`);
			await advance(task, runtime, context, { phase: "review", round: 1 }, (t) => {
				addEvent(t, { kind: "pr", text: `${t.pr === null ? "Draft PR opened" : "PR"}: ${pr} (branch ${t.branch} pushed)` });
				t.pr = pr;
			});
		},
		review: async (task, runtime, context) => {
			const round = task.state.checkpoint.round;
			if (!(await runAgent(task, runtime, context, "review", round))) return;
			const ticket = await ticketOf(task, runtime, context);
			await readOnly(ticket, task.state.checkpoint.stepHead, "reviewer");
			const file = `review-${round}.md`;
			const review = await readText(join(ticket.run!, file));
			if (review.trim() === "") throw new Blocked(`reviewer wrote no ${file}`);
			const verdict = /^VERDICT: (PASS|FIX)$/m.exec(review.split("\n").filter((l) => /^VERDICT: (PASS|FIX)$/.test(l)).at(-1) ?? "")?.[1] === "PASS" ? "PASS" : "FIX";
			if ((await runtime.memo<boolean>(`pr-comment:review-${round}`, context)) === undefined) {
				await runtime.memo(`pr-comment:review-${round}`, true, context);
				await gitHost.comment(ticket.worktree!, ticket.pr!, await scrub(runtime, context, ticket, `review ${round}`, review)).catch((e) => log(ticket, `review comment: ${e instanceof Error ? e.message : e}`));
			}
			const last = verdict === "PASS" || round >= config.maxReviewRounds;
			await advance(task, runtime, context, { phase: last ? (task.state.checkpoint.fixed ? "pr-summary-2" : "judge") : "fix", step: null, verdict }, (t) => {
				t.reviews.push({ round, verdict, file });
				const end = verdict === "FIX" && last ? ` (no rounds left: MAX_REVIEW_ROUNDS=${config.maxReviewRounds})` : "";
				addEvent(t, { kind: "review", level: verdict === "PASS" ? "info" : "warn", text: `Review ${round}: ${verdict}${end}; posted on the PR` });
			});
		},
		fix: async (task, runtime, context) => {
			const round = task.state.checkpoint.round;
			if (!(await runAgent(task, runtime, context, "fix", round))) return;
			const ticket = await ticketOf(task, runtime, context);
			await onBranch(ticket, "fixer");
			await keptTests(ticket, task.state.checkpoint.frozen, "fixer");
			// A failure goes to the next reviewer as verify-failed.md, who must count it as a P1.
			const { ok } = await verify(ticket, 3 + round, task.state.checkpoint.baselineRed, context);
			await advance(task, runtime, context, { phase: "push-fix", step: null, fixed: true }, (t) => {
				if (!config.verifyCmd) return;
				t.verify.push({ round: 3 + round, ok, log: `verify-${3 + round}.log` });
				addEvent(t, { kind: "verify", level: ok ? "info" : "warn", text: `VERIFY_CMD ${ok ? "passes" : "fails"} after fix ${round} (verify-${3 + round}.log)` });
			});
		},
		"push-fix": async (task, runtime, context) => {
			// Its own phase: a refused push goes to the coordinator, and only the push runs again.
			const ticket = await ticketOf(task, runtime, context);
			await pushSafely(ticket);
			await advance(task, runtime, context, { phase: "review", round: task.state.checkpoint.round + 1, step: null }, (t) => {
				addEvent(t, { kind: "git", text: `Fixes pushed to ${ticket.branch}` });
			});
		},
		"pr-summary-2": async (task, runtime, context) => {
			// The code changed since the first summary.
			if (!(await runAgent(task, runtime, context, "pr-summary", 2))) return;
			const ticket = await ticketOf(task, runtime, context);
			const title = (await readText(join(ticket.run!, "pr-title.txt"))).trim();
			const body = await readText(join(ticket.run!, "pr-body.md"));
			if (title && body.trim()) {
				const [t, b] = [await scrub(runtime, context, ticket, "the PR title", title), await scrub(runtime, context, ticket, "the PR body", body)];
				await gitHost.edit(ticket.worktree!, ticket.pr!, t, b).catch((e) => log(ticket, `PR edit: ${e instanceof Error ? e.message : e}`));
			}
			await advance(task, runtime, context, { phase: "judge", step: null });
		},
		judge: async (task, runtime, context) => {
			// Best effort: a failed judge is logged and the ticket carries on.
			let judge: Ticket["judge"] = null;
			try {
				if (!(await runAgent(task, runtime, context, "judge", 1))) return;
				const ticket = await ticketOf(task, runtime, context);
				const parsed = JSON.parse(await readText(join(ticket.run!, "judge.json"))) as { score?: unknown; summary?: unknown; criteria?: { status?: string }[]; hallucinations?: unknown[] };
				if (typeof parsed.score === "number") {
					judge = { score: parsed.score, summary: typeof parsed.summary === "string" ? parsed.summary : "" };
					const met = (parsed.criteria ?? []).filter((c) => c.status === "met").length;
					const text = `Judge: ${parsed.score}/5. ${judge.summary}\nCriteria met: ${met}/${(parsed.criteria ?? []).length}. Hallucinations: ${(parsed.hallucinations ?? []).length}.\n`;
					await writeFile(join(ticket.run!, "judge.txt"), text);
					if ((await runtime.memo<boolean>("pr-comment:judge", context)) === undefined) {
						await runtime.memo("pr-comment:judge", true, context);
						await gitHost.comment(ticket.worktree!, ticket.pr!, await scrub(runtime, context, ticket, "the judge's comment", text)).catch(() => undefined);
					}
				}
			} catch (error) {
				if (error instanceof Blocked) deps.log(`judge skipped: ${error.message}`);
				else if (!(error instanceof SyntaxError)) throw error;
			}
			await advance(task, runtime, context, { phase: "report", step: null }, (t) => {
				t.judge = judge;
				addEvent(t, judge ? { kind: "review", text: `Judge: ${judge.score}/5. ${judge.summary}`.slice(0, 400) } : { kind: "review", level: "warn", text: "Judge skipped (best effort)" });
			});
		},
		report: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const pass = task.state.checkpoint.verdict === "PASS";
			const graded = ticket.judge ? ` Judge score: ${ticket.judge.score}/5.` : "";
			if (pass) await gitHost.ready(ticket.worktree!, ticket.pr!).catch(() => undefined);
			await commentOnce(runtime, context, ticket, "report", pass
				? `PR ready for human review: ${ticket.pr}\nAI review passed (no P1/P2).${graded}`
				: `PR (draft): ${ticket.pr}\nAI review still has P1/P2 findings after ${config.maxReviewRounds} rounds. Needs a human. See PR comments.${graded}`);
			await setStatus(runtime, context, ticket, config.statuses.inReview);
			await finish(task, runtime, context, { outcome: pass ? "in_review" : "draft", pr: ticket.pr, reason: null }, (t) => {
				t.state = "in_review";
				t.phase = "report";
			});
		},
	};

	/**
	 * Call the coordinator for a Repairable failure: the failure goes to RUN_DIR/failure-<n>.md, and the
	 * checkpoint records the repair. False when MAX_REPAIRS for this phase are used (the ticket blocks).
	 */
	const startRepair = async (task: T, runtime: R, context: Context, phase: Phase, error: Repairable): Promise<boolean> => {
		if (config.maxRepairs <= 0 || !(await hasRole(config.here, "coordinate"))) return false;
		const cp = task.state.checkpoint;
		const repairs = cp.repairs ?? {};
		const tries = (repairs[phase] ?? 0) + 1;
		if (tries > config.maxRepairs) return false;
		const n = Object.values(repairs).reduce((a, b) => a + b, 0) + 1;
		const ticket = await ticketOf(task, runtime, context);
		const base = ticket.verify.find((v) => v.round === 1);
		const baseCheck = !config.verifyCmd ? "no VERIFY_CMD is set"
			: base === undefined ? "not run yet"
			: base.ok ? `VERIFY_CMD (${config.verifyCmd}) passed on ${config.base}`
			: cp.baselineRed ? `VERIFY_CMD (${config.verifyCmd}) already failed on ${config.base} before this ticket (verify-1.log)`
			: `VERIFY_CMD (${config.verifyCmd}) did not finish on ${config.base} (killed, verify-1.log): no result`;
		const did = error.kind === "push" ? `git push origin HEAD:refs/heads/${ticket.branch} (this runs the repo's pre-push hooks on the branch)`
			: error.kind === "secrets" ? "the factory's secret scan of everything the push would send: added lines, added files, commit messages"
			: error.kind === "blocked" ? `the coder (${cp.step ? `${cp.step.role}-${cp.step.round}-${cp.step.attempt}` : "the step"}) stopped and wrote blocked.md (below). Its work, committed or not, is in the worktree`
			: error.kind === "killed" ? `VERIFY_CMD in the sandbox: ${await verifyCommand()}${config.verifyCmd !== (await verifyCommand()) ? ` (the learned way to run ${config.verifyCmd})` : ""}. It was killed by the system before it finished: no result. The sandbox has the memory Docker gives it${config.sandboxArgs.length ? ` (SANDBOX_ARGS: ${config.sandboxArgs.join(" ")})` : " (no SANDBOX_ARGS limit)"}`
			: `VERIFY_CMD: ${await verifyCommand()}`;
		const earlier = Array.from({ length: n - 1 }, (_, i) => `failure-${i + 1}.md, repair-${i + 1}.md`).join("; ") || "none";
		const tracking = `refs/remotes/origin/${ticket.branch}`;
		const since = (await git(ticket.worktree!, "rev-parse", "-q", "--verify", tracking)).code === 0 ? tracking : `refs/remotes/origin/${config.base}`;
		const output = redact(error.details).text.split("\n").slice(-200).join("\n");
		// The memory the sandbox really has: a heap limit (--max-old-space-size) must stay well below it.
		const name = container(ticket);
		let memory = "";
		if (name !== null && (error.kind === "killed" || error.kind === "blocked" || error.kind === "verify")) {
			const limit = Number((await run("docker", ["inspect", "-f", "{{.HostConfig.Memory}}", name])).stdout.trim()) || 0;
			const total = Number((await run("docker", ["info", "--format", "{{.MemTotal}}"])).stdout.trim()) || 0;
			const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
			if (limit || total) memory = `- Sandbox memory: ${limit ? gb(limit) : `no limit of its own; Docker has ${gb(total)} for everything`}. Keep any Node heap (--max-old-space-size) well below it.`;
		}
		await writeFile(join(ticket.run!, `failure-${n}.md`), [
			`# Failure ${n}: ${label(phase)}`,
			"",
			`- Kind: ${error.kind}`,
			`- Phase: ${phase} (${label(phase)}); this is try ${tries} of ${config.maxRepairs} for it`,
			`- What failed: ${error.message}`,
			`- What the factory ran: ${did}`,
			`- Ticket: ${ticket.cid}, branch ${ticket.branch}, HEAD ${(await head(ticket.worktree!)).slice(0, 12)}`,
			`- BASE: refs/remotes/origin/${config.base}`,
			`- SINCE (what the remote already has): ${since}`,
			`- The base before this ticket: ${baseCheck}`,
			`- Earlier repairs in this run: ${earlier}`,
			...(memory ? [memory] : []),
			"",
			"## Output",
			"",
			"```",
			output,
			"```",
			"",
		].join("\n"));
		// The phase's own finished step (the coder's) is kept: after the repair it is not run again.
		await advance(task, runtime, context, { repair: { n, phase, kind: error.kind, resume: cp.step }, repairs: { ...repairs, [phase]: tries }, step: null }, (t) => {
			addEvent(t, { kind: "repair", level: "warn", text: `Coordinator called (${tries}/${config.maxRepairs} for "${label(phase)}"): ${error.message}` });
		});
		return true;
	};
	/** The coordinator's step, then its checks; the failed phase runs again after it. */
	const coordinate = async (task: T, runtime: R, context: Context) => {
		const rep = task.state.checkpoint.repair!;
		if (!(await runAgent(task, runtime, context, "coordinate", rep.n))) return;
		const ticket = await ticketOf(task, runtime, context);
		await onBranch(ticket, "coordinator");
		if (Object.keys(task.state.checkpoint.frozen ?? {}).length > 0) await keptTests(ticket, task.state.checkpoint.frozen, "coordinator");
		const report = await readText(join(ticket.run!, `repair-${rep.n}.md`));
		const lesson = report.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("LESSON:")).at(-1)?.slice(7).trim() ?? "";
		if (lesson !== "" && !/^none\.?$/i.test(lesson)) {
			const kept = await learn(config.stateDir, lesson, ticket.cid);
			if (kept !== null) await note(runtime, context, ticket.id, { kind: "lesson", text: `Lesson for the next agents: ${kept}` });
		}
		// A killed check: the coordinator names a way to run the same check that fits (VERIFY: <command>).
		const proposed = report.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("VERIFY:")).at(-1)?.slice(7).trim().replace(/^`|`$/g, "") ?? "";
		if (proposed !== "" && config.verifyCmd) {
			const problem = await learnVerify(config.stateDir, config.verifyCmd, proposed, ticket.cid);
			await note(runtime, context, ticket.id, problem === null
				? { kind: "lesson", text: `VERIFY_CMD now runs as: ${proposed} (learned by the coordinator; state/verify.json, delete it to go back)` }
				: { kind: "guard", level: "warn", text: `The coordinator's way to run VERIFY_CMD was refused: ${problem}` });
		}
		const blocked = (await readText(join(ticket.run!, "blocked.md"))).trim();
		if (blocked !== "") throw new Blocked(`the coordinator could not fix it: ${redact(blocked).text.slice(0, 1500)}`);
		const summary = (report.split("\n").find((l) => l.trim() !== "")?.trim() ?? "no report").replace(/[.\s]+$/, "");
		await advance(task, runtime, context, { repair: null, step: rep.resume ?? null }, (t) => {
			addEvent(t, { kind: "repair", text: `Coordinator: ${redact(summary).text.slice(0, 300)}. "${label(rep.phase)}" runs again` });
		});
	};

	/** Every phase: a Blocked error (or any other failure) blocks the ticket instead of faulting the task. */
	const guarded = (phase: Phase): Handler => async (task, runtime, context) => {
		// Paused: hold before the phase (a waiting phase must commit a changed checkpoint).
		if ((await ticketOf(task, runtime, context)).paused) {
			await runtime.commit(async (_tx, current) => ({ status: "running", checkpoint: { ...current.state.checkpoint, polls: current.state.checkpoint.polls + 1 } }), context);
			await nap(gatePollMs, runtime.signal, task.input.ticketId);
			return;
		}
		const repairing = Boolean(task.state.checkpoint.repair);
		try {
			if (repairing) await coordinate(task, runtime, context);
			else await phases[phase](task, runtime, context);
		} catch (error) {
			if (runtime.signal.aborted) throw error; // stopping or closing: the abort handler or the next run decides
			// A failure code may fix goes to the coordinator first (never a failure of the coordinator itself).
			if (error instanceof Repairable && !repairing && (await startRepair(task, runtime, context, phase, error))) return;
			const ticket = await ticketOf(task, runtime, context);
			// A deleted ticket: say so plainly, and do not post to it (every call would fail the same way).
			const gone = error instanceof TicketGone;
			const reason = gone
				? `${error.message}${ticket.source ? ": make a new one with New ClickUp ticket (or Fix this on the Sentry issue)" : ": restore it in ClickUp, then Run again, or Remove it"}`
				: error instanceof Error ? error.message : String(error);
			deps.log(`${ticket.cid} FAIL in ${phase}: ${reason}`);
			if (!gone) {
				await commentOnce(runtime, context, ticket, `fail:${phase}`, `Factory stopped: ${reason}\nLogs: ${ticket.run}\nTo retry: ff run ${ticket.cid}`);
				await setStatus(runtime, context, ticket, config.statuses.blocked);
			}
			await finish(task, runtime, context, { outcome: "blocked", pr: ticket.pr, reason }, (t) => {
				t.state = "blocked";
				t.phase = phase;
				t.blocked = `${phase}: ${reason}`;
				t.gone = gone;
			});
		}
	};

	const Pipeline = defineTask<PipelineInput, Checkpoint, PipelineResult>({
		name: "factory.pipeline",
		version: 1,
		initial,
		phases: Object.fromEntries((Object.keys(phases) as Phase[]).map((p) => [p, guarded(p)])) as never,
		// Stop (ff stop, or the dashboard): owned step conversations are aborted first, bottom-up.
		abort: async (task, runtime, context) => {
			wake(); // a slot is free: queued tickets look now
		const container_ = container(await ticketOf(task as T, runtime as R, context));
			if (container_ !== null) await removeContainer(container_);
			await runtime.commit(async (tx) => {
				await editTicket(tx, task.input.ticketId, (t) => {
					t.state = "stopped";
					t.slot = null;
					t.paused = null;
					addEvent(t, { kind: "control", level: "warn", text: "Stopped" });
				});
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	return { Pipeline, extension: defineExtension({ name: "factory-pipeline", tasks: [Pipeline] }), wake };
}

/**
 * A fresh run never rewrites a branch that was pushed (the factory never force-pushes): when the
 * ticket's branch is on origin, it gets the next free name, `<branch>-2`, `-3`, ... A branch that
 * was never pushed is cut again from the base.
 */
async function freeBranch(repo: string, name: string, ranBefore: boolean): Promise<string> {
	if (!ranBefore) return name;
	const remote = await git(repo, "ls-remote", "--heads", "origin");
	if (remote.code !== 0) throw new Blocked(`git ls-remote origin: ${remote.stderr.trim()}`);
	const heads = new Set(remote.stdout.split("\n").map((line) => line.split("\t")[1]).filter(Boolean));
	for (let n = 1; n < 100; n++) {
		const candidate = n === 1 ? name : `${name}-${n}`;
		if (!heads.has(`refs/heads/${candidate}`)) return candidate;
	}
	throw new Blocked(`no free branch name for ${name}`);
}

const parseRef = (name: string): ModelRef => {
	const slash = name.indexOf("/");
	return { provider: name.slice(0, slash), modelId: name.slice(slash + 1) };
};

export const _test = { lastLine, initial };
export { git };

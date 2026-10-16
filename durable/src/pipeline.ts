// The ticket pipeline as one durable task (examples 12-tasks, 13-recovery, 24-child-tasks): the
// stages factory.sh ran, as phases that each save a checkpoint. A restarted factory continues every
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
	type RunningTask,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { StepDoc, type StepRecord, type Ticket, TicketDoc, TicketIndex } from "./docs.ts";
import { type EnvFactory, ensureContainer, removeContainer } from "./env.ts";
import { branchName, cellEnv, currentBranch, type GitIdentity, freezeTests, git, gitOk, head, prepareWorktree, push, testsKept, writeGuardHooks } from "./git.ts";
import type { GitHost } from "./github.ts";
import { family, type Lanes, modelName, pickModel } from "./lanes.ts";
import { buildPrompt, hasRole, STEP_EXTENSIONS } from "./roles.ts";
import type { Tracker } from "./tracker.ts";

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
	| "test" | "code" | "verify-code" | "docs" | "pr-summary" | "pr" | "review" | "fix" | "pr-summary-2" | "judge" | "report";
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
};
export type PipelineResult = { outcome: "in_review" | "draft" | "waiting" | "needs_input" | "blocked"; pr: string | null; reason: string | null };

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
});

/** Thrown inside a phase: the ticket is blocked with this reason (posted, status S_BLOCKED). */
class Blocked extends Error {}

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
				// Where a later run continues if this one is stopped or blocked (the journal factory.sh kept).
				if (entering && !SETUP_PHASES.has(checkpoint.phase)) ticket.resume = { ...checkpoint, polls: 0 } as unknown as JsonObject;
				edit?.(ticket);
			});
			return { status: "running", checkpoint };
		}, context);
	const finish = async (task: T, runtime: R, context: Context, result: PipelineResult, edit: Edit) => {
		// The ticket's sandbox container goes with its run (a later run makes a new one).
		const name = container(await ticketOf(task, runtime, context));
		if (name !== null) await removeContainer(name);
		await runtime.commit(async (tx) => {
			await editTicket(tx, task.input.ticketId, (ticket) => {
				edit(ticket);
				ticket.slot = null;
				if (result.outcome === "in_review" || result.outcome === "draft") ticket.resume = null;
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

	/** A comment on the ticket, at most once per key (memo first: a crash loses it, never doubles it). */
	const commentOnce = async (runtime: R, context: Context, ticket: Ticket, key: string, text: string, always = false) => {
		if (!(always || config.trackerComments)) return;
		if ((await runtime.memo<boolean>(`comment:${key}`, context)) !== undefined) return;
		await runtime.memo(`comment:${key}`, true, context);
		await tracker.comment(ticket.id, text.slice(0, 30_000)).catch((error) => log(ticket, `comment failed: ${error instanceof Error ? error.message : error}`));
	};
	const setStatus = (ticket: Ticket, status: string) =>
		tracker.setStatus(ticket.id, status).catch((error) => log(ticket, `status ${status} failed: ${error instanceof Error ? error.message : error}`));

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
	const verify = async (ticket: Ticket, round: number, baselineRed: boolean, context: Context): Promise<boolean> => {
		if (!config.verifyCmd) return true;
		const code = await exec(ticket, config.verifyCmd, `verify-${round}.log`, context);
		const failed = join(ticket.run!, "verify-failed.md");
		if (code === 0 || baselineRed) await rm(failed, { force: true });
		else {
			const tail = (await readText(join(ticket.run!, `verify-${round}.log`))).split("\n").slice(-80).join("\n");
			await writeFile(failed, `The factory ran VERIFY_CMD (${config.verifyCmd}) on HEAD ${(await head(ticket.worktree!)).slice(0, 12)} and it failed (exit ${code}). Last lines:\n\n\`\`\`\n${tail}\n\`\`\`\n`);
		}
		return code === 0;
	};

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
		if (skipped.length > 0) await appendFile(join(run, "route.log"), `${new Date().toISOString()} ${role}-${round}-${attempt}: ${skipped.join("; ")}\n`);
		if (model === null) throw new Blocked(`no model left for the ${role} agent: every model in its lane failed or has no login (see route.log)`);
		// A new attempt starts clean: its old outputs go, so a missing output is this attempt's fault.
		for (const file of OUTPUTS[role]?.(round) ?? []) await rm(join(run, file), { force: true });
		const stepHead = cp.stepHead ?? (await head(worktree));
		const name = `${role}-${round}-${attempt}`;
		await runtime.commit(async (tx, current) => {
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
			await configure(tx, conversation.id, { model, cwd: worktree, extensions: STEP_EXTENSIONS, tools: null, modelTools: null });
			Object.assign(await tx.doc(StepDoc, conversation.id), { ticketId: ticket.id, name, role, worktree, run, slot: ticket.slot ?? 0 });
			const record: StepRecord = {
				name, role, round, attempt, model: modelName(model), conversationId: conversation.id, taskId: task.id,
				status: "running", started: Date.now(), ended: null, error: null,
			};
			await editTicket(tx, ticket.id, (t) => {
				t.steps.push(record);
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
			log: (line) => log(ticket, line),
		});
		const submission = await handle.submit({ type: "input", content: prompt, requestId: `step:${name}` }, context);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void handle.abort(context).catch(() => undefined);
		}, Math.max(1000, step.started + config.agentTimeoutMs - Date.now()));
		let settled;
		try {
			settled = await submission.wait(context);
		} finally {
			clearTimeout(timer);
		}
		const ok = settled.status === "done";
		const error = ok ? null : timedOut ? `timed out after ${Math.round(config.agentTimeoutMs / 1000)}s` : (settled.reason ?? "failed");
		if (!ok) log(ticket, `${name} on ${step.model} failed: ${error}`);
		await runtime.commit(async (tx) => {
			await editTicket(tx, ticket.id, (t) => {
				const record = t.steps.find((s) => s.name === name);
				if (record && record.status === "running") Object.assign(record, { status: ok ? "done" : "failed", ended: Date.now(), error });
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
				});
				return { status: "running", checkpoint: { ...checkpoint, phase: "fetch", polls: 0 } };
			}, context);
			if (!admitted) await sleep(admitPollMs, runtime.signal);
		},
		fetch: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			await setStatus(ticket, config.statuses.working);
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
			// A run after one that was stopped or blocked continues where that one was.
			if (ticket.resume !== null && !task.input.fresh) {
				const resume = ticket.resume as unknown as Checkpoint;
				log(ticket, `continues at ${resume.phase} (round ${resume.round}), where the last run stopped`);
				await advance(task, runtime, context, { ...resume, step: null, stepHead: null, polls: 0, freshDone: true });
				return;
			}
			const build = task.input.build || ticket.approved !== null;
			if (build && !(await exists(join(ticket.run!, "spec.md")))) throw new Blocked("no spec.md in the run folder: run the spec stage first");
			await advance(task, runtime, context, { phase: build ? "setup" : "spec", polls: 0 });
		},
		spec: async (task, runtime, context) => {
			if (!(await runAgent(task, runtime, context, "spec", 1))) return;
			const ticket = await ticketOf(task, runtime, context);
			await readOnly(ticket, task.state.checkpoint.stepHead, "spec writer");
			const spec = await readText(join(ticket.run!, "spec.md"));
			if (spec.trim() === "") throw new Blocked("spec writer wrote no spec.md");
			const status = lastLine(spec) === "STATUS: NEEDS_INPUT" ? "NEEDS_INPUT" : "READY";
			if (status === "NEEDS_INPUT") {
				await commentOnce(runtime, context, ticket, "needs-input", `Spec needs input before coding:\n\n${spec}`, true);
				await setStatus(ticket, config.statuses.blocked);
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
			await readOnly(ticket, task.state.checkpoint.stepHead, "planner");
			if ((await readText(join(ticket.run!, "plan.md"))).trim() === "") throw new Blocked("planner wrote no plan.md");
			await advance(task, runtime, context, { phase: "post-spec", step: null });
		},
		"post-spec": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const spec = await readText(join(ticket.run!, "spec.md"));
			const plan = await readText(join(ticket.run!, "plan.md"));
			await commentOnce(runtime, context, ticket, "spec", `SPEC\n\n${spec}\n\nPLAN\n\n${plan}`);
			if (task.input.gate) {
				await setStatus(ticket, config.statuses.specReview);
				await advance(task, runtime, context, { phase: "gate", polls: 0 }, (t) => {
					t.state = "waiting_approval";
				});
			} else {
				await setStatus(ticket, config.statuses.approved);
				await advance(task, runtime, context, { phase: "setup", polls: 0 });
			}
		},
		gate: async (task, runtime, context) => {
			// Waits durably for you: Approve on the dashboard (`ff approve`), or move the ticket to S_APPROVED.
			let ticket = await ticketOf(task, runtime, context);
			const polls = task.state.checkpoint.polls;
			if (ticket.approved === null && polls % 12 === 0) {
				const status = await tracker.info(ticket.id).then((i) => i.status, () => "");
				if (status.toLowerCase() === config.statuses.approved.toLowerCase()) {
					await runtime.commit(async (tx) => {
						await editTicket(tx, ticket.id, (t) => {
							t.approved ??= { at: Date.now(), note: "" };
						});
						return undefined;
					}, context);
					ticket = await ticketOf(task, runtime, context);
				}
			}
			if (ticket.approved === null) {
				await advance(task, runtime, context, { polls: polls + 1 });
				await sleep(gatePollMs, runtime.signal);
				return;
			}
			// Your comments go to the coder: fetch them again.
			const { ticket: md, comments } = await tracker.fetch(ticket.id);
			await writeFile(join(ticket.run!, "ticket.md"), md);
			await writeFile(join(ticket.run!, "comments.md"), ticket.approved.note ? `${comments}\n[approval note] ${ticket.approved.note}\n` : comments);
			await setStatus(ticket, config.statuses.working);
			await advance(task, runtime, context, { phase: "setup", polls: 0 }, (t) => {
				t.state = "running";
			});
		},
		setup: async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			if (config.setupCmd && !task.state.checkpoint.setupDone) {
				const code = await exec(ticket, config.setupCmd, "setup.log", context);
				if (code !== 0) throw new Blocked(`SETUP_CMD failed (exit ${code}), see setup.log`);
			}
			await advance(task, runtime, context, { phase: "verify-base", setupDone: true });
		},
		"verify-base": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const ok = await verify(ticket, 1, false, context);
			if (!ok) log(ticket, `origin/${config.base} already fails VERIFY_CMD (verify-1.log): the verify gate will report, not block`);
			await advance(task, runtime, context, { phase: "test", baselineRed: !ok }, (t) => {
				if (config.verifyCmd) t.verify.push({ round: 1, ok, log: "verify-1.log" });
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
			if (blocked.trim() !== "") throw new Blocked(`coder blocked: ${blocked.slice(0, 1500)}`);
			await onBranch(ticket, "coder");
			await keptTests(ticket, task.state.checkpoint.frozen, "coder");
			if ((await gitOk(ticket.worktree!, "rev-list", "--count", `origin/${config.base}..HEAD`)) === "0") throw new Blocked("coder made no commits");
			await advance(task, runtime, context, { phase: "verify-code", step: null });
		},
		"verify-code": async (task, runtime, context) => {
			const ticket = await ticketOf(task, runtime, context);
			const cp = task.state.checkpoint;
			const round = cp.round === 1 ? 2 : 3;
			const ok = await verify(ticket, round, cp.baselineRed, context);
			const record = (t: Ticket) => {
				if (config.verifyCmd) t.verify.push({ round, ok, log: `verify-${round}.log` });
			};
			if (ok || cp.baselineRed) {
				await advance(task, runtime, context, { phase: "docs", round: 1 }, record);
			} else if (cp.round === 1) {
				// The coder gets one more fresh session with the failure (verify-failed.md).
				await advance(task, runtime, context, { phase: "code", round: 2 }, record);
			} else {
				throw new Blocked("VERIFY_CMD still fails after the coder's second try, see verify-3.log");
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
			await push(ticket.worktree!, ticket.branch!);
			let pr = ticket.pr ?? (await gitHost.prFor(ticket.worktree!, ticket.branch!));
			if (pr === null) {
				const title = (await readText(join(ticket.run!, "pr-title.txt"))).trim();
				pr = await gitHost.createDraft(ticket.worktree!, config.base, ticket.branch!, title, await readText(join(ticket.run!, "pr-body.md")));
				if (config.prLabel) await gitHost.addLabel(ticket.worktree!, pr, config.prLabel).catch((e) => log(ticket, `label: ${e instanceof Error ? e.message : e}`));
			}
			log(ticket, `PR ${pr}`);
			await advance(task, runtime, context, { phase: "review", round: 1 }, (t) => {
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
				await gitHost.comment(ticket.worktree!, ticket.pr!, review).catch((e) => log(ticket, `review comment: ${e instanceof Error ? e.message : e}`));
			}
			const last = verdict === "PASS" || round >= config.maxReviewRounds;
			await advance(task, runtime, context, { phase: last ? (task.state.checkpoint.fixed ? "pr-summary-2" : "judge") : "fix", step: null, verdict }, (t) => {
				t.reviews.push({ round, verdict, file });
			});
		},
		fix: async (task, runtime, context) => {
			const round = task.state.checkpoint.round;
			if (!(await runAgent(task, runtime, context, "fix", round))) return;
			const ticket = await ticketOf(task, runtime, context);
			await onBranch(ticket, "fixer");
			await keptTests(ticket, task.state.checkpoint.frozen, "fixer");
			// A failure goes to the next reviewer as verify-failed.md, who must count it as a P1.
			const ok = await verify(ticket, 3 + round, task.state.checkpoint.baselineRed, context);
			await push(ticket.worktree!, ticket.branch!);
			await advance(task, runtime, context, { phase: "review", round: round + 1, step: null, fixed: true }, (t) => {
				if (config.verifyCmd) t.verify.push({ round: 3 + round, ok, log: `verify-${3 + round}.log` });
			});
		},
		"pr-summary-2": async (task, runtime, context) => {
			// The code changed since the first summary.
			if (!(await runAgent(task, runtime, context, "pr-summary", 2))) return;
			const ticket = await ticketOf(task, runtime, context);
			const title = (await readText(join(ticket.run!, "pr-title.txt"))).trim();
			const body = await readText(join(ticket.run!, "pr-body.md"));
			if (title && body.trim()) await gitHost.edit(ticket.worktree!, ticket.pr!, title, body).catch((e) => log(ticket, `PR edit: ${e instanceof Error ? e.message : e}`));
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
						await gitHost.comment(ticket.worktree!, ticket.pr!, text).catch(() => undefined);
					}
				}
			} catch (error) {
				if (error instanceof Blocked) deps.log(`judge skipped: ${error.message}`);
				else if (!(error instanceof SyntaxError)) throw error;
			}
			await advance(task, runtime, context, { phase: "report", step: null }, (t) => {
				t.judge = judge;
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
			await setStatus(ticket, config.statuses.inReview);
			await finish(task, runtime, context, { outcome: pass ? "in_review" : "draft", pr: ticket.pr, reason: null }, (t) => {
				t.state = "in_review";
				t.phase = "report";
			});
		},
	};

	/** Every phase: a Blocked error (or any other failure) blocks the ticket instead of faulting the task. */
	const guarded = (phase: Phase): Handler => async (task, runtime, context) => {
		try {
			await phases[phase](task, runtime, context);
		} catch (error) {
			if (runtime.signal.aborted) throw error; // stopping or closing: the abort handler or the next run decides
			const reason = error instanceof Error ? error.message : String(error);
			const ticket = await ticketOf(task, runtime, context);
			deps.log(`${ticket.cid} FAIL in ${phase}: ${reason}`);
			await commentOnce(runtime, context, ticket, `fail:${phase}`, `Factory stopped: ${reason}\nLogs: ${ticket.run}\nTo retry: ff run ${ticket.cid}`);
			await setStatus(ticket, config.statuses.blocked);
			await finish(task, runtime, context, { outcome: "blocked", pr: ticket.pr, reason }, (t) => {
				t.state = "blocked";
				t.blocked = `${phase}: ${reason}`;
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
			const container_ = container(await ticketOf(task as T, runtime as R, context));
			if (container_ !== null) await removeContainer(container_);
			await runtime.commit(async (tx) => {
				await editTicket(tx, task.input.ticketId, (t) => {
					t.state = "stopped";
					t.slot = null;
				});
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	return { Pipeline, extension: defineExtension({ name: "factory-pipeline", tasks: [Pipeline] }) };
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

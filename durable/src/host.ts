// The factory host: one process owns the factory's Pi Durable session (state/factory.sqlite) and runs
// everything in it (examples 06-harness, 13-recovery, 31-reload-and-restart): the ticket pipelines,
// their agent steps, the Sentry sync and the tracker pickup. Opening it resumes all of them where the
// last process stopped. Other clients (the CLI, the dashboard) talk to this process, never to the file.
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type TaskId,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Config } from "./config.ts";
import { addEvent, type Issue, SentryInbox, StepDoc, type StepUsage, type Ticket, TicketDoc, TicketIndex } from "./docs.ts";
import { dockerEnv, type EnvFactory, nodeEnvWith, reapOrphans, removeContainer } from "./env.ts";
import { cellEnv, git, gitIdentity, removeWorktree, useOriginUrl } from "./git.ts";
import type { GitHost } from "./github.ts";
import type { Lanes } from "./lanes.ts";
import { createPipeline, duration, type PipelineInput, sumUsage } from "./pipeline.ts";
import { FactoryAgent } from "./roles.ts";
import { createSentrySync, mergeSync, type SentryApi, ticketFor } from "./sentry.ts";
import { Throttle, type ThrottleStatus } from "./throttle.ts";
import { TicketGone, type Tracker } from "./tracker.ts";

const context = BACKGROUND_CONTEXT;
export const STEER_PREFIX = "Steer from the person watching this run (follow it; where it conflicts with earlier instructions, it wins):";

/** The background loops this factory runs, so a restart does not start a second one. */
const Loops = defineDoc<{ sentry: number | null; pickup: number | null }>({
	kind: "factory.loops",
	version: 1,
	scope: "session",
	initial: () => ({ sentry: null, pickup: null }),
});

export type HostDeps = {
	readonly config: Config;
	readonly models: Models;
	readonly lanes: Lanes;
	readonly tracker: Tracker;
	readonly gitHost: GitHost;
	readonly sentry: SentryApi | null;
	readonly envFor?: EnvFactory;
	/** Tests: keep the session in memory. */
	readonly memory?: boolean;
	readonly log?: (line: string) => void;
	readonly gatePollMs?: number;
	readonly admitPollMs?: number;
	/** Model request retries before a step's model counts as failed (default 3). */
	readonly retries?: number;
	/** Open to read only: nothing is resumed or started (ff status without a running factory). */
	readonly readOnly?: boolean;
};

export type StartOptions = { gate?: boolean; build?: boolean; fresh?: boolean };

/** The pause reason the factory sets when the daily budget runs out; it continues them when it is back. */
const BUDGET = "daily budget";

/** The ticket's sandbox container (SANDBOX=docker), or null. */
export const containerName = (config: Config, cid: string) => (config.sandbox === "docker" ? `factory-${cid.toLowerCase().replace(/[^a-z0-9]/g, "-")}` : null);

export class Factory {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly deps: HostDeps;
	readonly throttle: Throttle;
	private readonly Pipeline: ReturnType<typeof createPipeline>["Pipeline"];
	/** Wake a ticket's waiting phase (the gate, a pause, the queue) now. */
	private readonly wake: (ticketId?: string) => void;
	private readonly lock: string | null;
	private budgetTimer: ReturnType<typeof setInterval> | null = null;
	/** Provider session id -> ticket id, for the throttle (filled as steps are looked up). */
	private readonly sessions = new Map<string, string>();

	private constructor(harness: Harness, root: Conversation, deps: HostDeps, Pipeline: Factory["Pipeline"], lock: string | null, throttle: Throttle, wake: (ticketId?: string) => void) {
		this.wake = wake;
		this.harness = harness;
		this.root = root;
		this.deps = deps;
		this.Pipeline = Pipeline;
		this.lock = lock;
		this.throttle = throttle;
	}

	static async open(deps: HostDeps): Promise<Factory> {
		const { config } = deps;
		const log = deps.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`));
		await mkdir(config.stateDir, { recursive: true });
		await mkdir(config.runsDir, { recursive: true });
		await mkdir(config.treesDir, { recursive: true });
		// One process owns the session: Pi Durable has no cross-process locking.
		const lock = deps.memory ? null : await takeLock(join(config.stateDir, "factory.pid"));
		useOriginUrl(config.originUrl);
		const envFor = deps.envFor ?? (config.sandbox === "docker" ? dockerEnv : nodeEnvWith(config.indexDir));
		const identity = await gitIdentity(config.repo);
		// Every model request goes through the throttle: rate limits, the daily budget, paused tickets.
		let factory: Factory | undefined;
		const throttle = await Throttle.open(config.limits, {
			file: deps.memory ? null : join(config.stateDir, "usage.json"),
			hold: (sessionId) => factory?.holdReason(sessionId) ?? Promise.resolve(null),
		});
		const models = throttle.wrap(deps.models);
		const { Pipeline, extension, wake } = createPipeline({
			config, tracker: deps.tracker, gitHost: deps.gitHost, lanes: deps.lanes, models, envFor, identity, log,
			gatePollMs: deps.gatePollMs, admitPollMs: deps.admitPollMs,
		});
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(FactoryAgent);
		registry.install(extension);
		const SentrySync = deps.sentry === null ? null : createSentrySync({ config, api: deps.sentry, log });
		if (SentrySync !== null) registry.install(defineExtension({ name: "factory-sentry", tasks: [SentrySync] }));
		const Pickup = createPickup(config, deps.tracker, log);
		registry.install(defineExtension({ name: "factory-pickup", tasks: [Pickup] }));
		const storage = deps.memory ? new MemoryStorage() : await openNodeSqliteStorage(join(config.stateDir, "factory.sqlite"));
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				// The root conversation runs nothing itself; step conversations select their extensions.
				settings: { extensions: [], retry: { maxRetries: deps.retries ?? 3 } },
				// Every tool call of a step runs in its ticket's worktree (example 29-sandbox-per-conversation).
				env: async ({ conversationId, read }, envContext) => {
					const step = await read.snapshot(StepDoc, conversationId, envContext);
					if (step === undefined || step.worktree === "") return undefined;
					const ticket = await read.snapshot(TicketDoc, step.ticketId, envContext);
					const cid = ticket?.cid ?? step.ticketId;
					const cell = cellEnv({ cid, slot: step.slot, hooksDir: join(step.run, "git-hooks"), portStart: config.cellPortStart, portSpan: config.cellPortSpan, identity });
					return envFor({ worktree: step.worktree, run: step.run, cell, container: containerName(config, cid) });
				},
				onReport: (error) => log(`pi-durable: ${error instanceof Error ? error.message : String(error)}`),
			},
			context,
		);
		const root = await harness.root(context);
		factory = new Factory(harness, root, deps, Pipeline, lock, throttle, wake);
		if (!deps.readOnly) {
			// Commands a crashed factory left running would race the resumed agents: end them first.
			for (const ticket of await factory.tickets()) {
				if (ticket.run === null || ticket.taskId === null) continue;
				if ((await harness.getTask(ticket.taskId as TaskId, context))?.state.status === "terminal") continue;
				const killed = await reapOrphans(ticket.run, containerName(config, ticket.cid));
				if (killed > 0) log(`${ticket.cid}: ended ${killed} command(s) left running by the last factory`);
			}
			await factory.ensureLoops(config.sentry.token !== "" && config.sentry.org !== "" ? SentrySync : null, config.autoPickup ? Pickup : null);
			harness.resume(); // every pipeline, step and loop continues where the last process stopped
			const watched = factory;
			watched.budgetTimer = setInterval(() => void watched.watchBudget().catch((e) => log(`budget: ${e instanceof Error ? e.message : e}`)), 15_000);
			watched.budgetTimer.unref();
		}
		return factory;
	}

	/** Start the Sentry sync and the pickup loop once; after a restart the stored ones continue. */
	private async ensureLoops(sentry: ReturnType<typeof createSentrySync> | null, pickup: ReturnType<typeof createPickup> | null) {
		await this.root.commit(async (tx) => {
			const loops = await tx.doc(Loops);
			const live = async (id: number | null) => id !== null && (await tx.task(id as TaskId))?.state.status !== "terminal";
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			if (sentry !== null && !(await live(loops.sentry))) loops.sentry = await tx.createTask(sentry, null, background);
			if (pickup !== null && !(await live(loops.pickup))) loops.pickup = await tx.createTask(pickup, null, background);
		}, context);
	}

	/** Start a ticket's pipeline, or return the one already running for it. */
	async start(ref: string, options: StartOptions = {}): Promise<{ ticketId: string; taskId: number; started: boolean }> {
		const ticketId = await this.deps.tracker.resolve(ref);
		// A ticket the factory has not run yet must exist in the tracker: no row for a typo.
		const known = await this.ticket(ticketId);
		if (!known || known.created === 0) await this.deps.tracker.info(ticketId);
		const input: PipelineInput = {
			ticketId,
			gate: options.gate ?? this.deps.config.specGate,
			build: options.build ?? false,
			fresh: options.fresh ?? false,
		};
		const Pipeline = this.Pipeline;
		return this.root.commit(async (tx) => {
			const ticket = (await tx.doc(TicketDoc, ticketId, ticketId)) as Ticket;
			if (ticket.taskId !== null && (await tx.task(ticket.taskId as TaskId))?.state.status !== "terminal") {
				return { ticketId, taskId: ticket.taskId, started: false };
			}
			// A ticket whose last run finished (its PR is in review) starts over.
			const run = ticket.state === "in_review" ? { ...input, fresh: true } : input;
			const taskId = await tx.createTask(Pipeline, run, { ownership: { kind: "conversation" }, background: true });
			Object.assign(ticket, { taskId, state: "queued", phase: "queued", blocked: null, paused: null, gone: false, mode: input.build ? "build" : "full" });
			const how = [input.build ? "build of the approved spec" : input.gate ? "spec, then your approval" : "the whole pipeline", run.fresh ? "fresh" : ""].filter(Boolean).join(", ");
			addEvent(ticket, { kind: "run", phase: "start", text: `Run started: ${how}` });
			if (ticket.created === 0) ticket.created = Date.now();
			ticket.updated = Date.now();
			const index = await tx.doc(TicketIndex);
			const at = index.ids.indexOf(ticketId);
			if (at >= 0) index.ids.splice(at, 1);
			index.ids.unshift(ticketId);
			return { ticketId, taskId, started: true };
		}, context);
	}

	/** Approve the spec of a ticket waiting at the gate. A note goes to the coder (and to the ticket). */
	async approve(ref: string, note = ""): Promise<Ticket> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const before = await this.ticket(ticketId);
		if (before === undefined) throw new Error(`the factory has not seen ticket ${ref}`);
		if (note.trim() !== "") await this.deps.tracker.comment(ticketId, `Approved: ${note.trim()}`);
		await this.root.commit(async (tx) => {
			const ticket = (await tx.doc(TicketDoc, ticketId, ticketId)) as Ticket;
			ticket.approved = { at: Date.now(), note: note.trim() };
			ticket.updated = Date.now();
			addEvent(ticket, { kind: "gate", text: `Spec approved${note.trim() ? `, with a note for the coder: ${note.trim().slice(0, 200)}` : ""}` });
		}, context);
		this.wake(ticketId); // the gate sees it now, not at its next poll
		await this.deps.tracker.setStatus(ticketId, this.deps.config.statuses.approved).catch(() => undefined);
		const after = (await this.ticket(ticketId))!;
		// An approval for a ticket that is not waiting (its run ended at the gate earlier): build it now.
		if (after.taskId === null || (await this.harness.getTask(after.taskId as TaskId, context))?.state.status === "terminal") {
			await this.start(ticketId, { build: true, gate: false });
		}
		return (await this.ticket(ticketId))!;
	}

	/** Stop a ticket: its pipeline and its running step are aborted; the worktree and branch stay. */
	async stop(ref: string): Promise<void> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const ticket = await this.ticket(ticketId);
		if (ticket?.taskId == null) throw new Error(`ticket ${ref} is not running`);
		await this.harness.abortTask(ticket.taskId as TaskId, context);
	}

	/** A message from you into the ticket's running agent step, placed after its current tool round. */
	async steer(ref: string, text: string): Promise<{ step: string }> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const ticket = await this.ticket(ticketId);
		const step = ticket?.steps.findLast((s) => s.status === "running");
		if (step === undefined) throw new Error(`no agent step of ${ref} is running`);
		const conversation = await this.harness.conversation(step.conversationId as ConversationId, context);
		if (conversation === undefined) throw new Error(`the conversation of ${step.name} is gone`);
		await conversation.submit({ type: "input", content: `${STEER_PREFIX}\n\n${text.trim()}`, whenBusy: "steer" }, context);
		await this.edit(ticketId, (t) => addEvent(t, { kind: "control", step: step.name, text: `Steer sent to ${step.name}: ${text.trim().slice(0, 300)}` }));
		return { step: step.name };
	}

	/**
	 * Ask for a change to the spec or the plan while the ticket waits for your approval. The agent that
	 * wrote the file makes it (a spec change then goes to the planner); the gate takes them in order.
	 */
	async revise(ref: string, input: { file: string; quote: string; comment: string }): Promise<Ticket> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const ticket = await this.ticket(ticketId);
		if (ticket?.state !== "waiting_approval" || !(await this.live(ticket))) throw new Error(`ticket ${ref} is not waiting for your approval`);
		if (input.file !== "spec.md" && input.file !== "plan.md") throw new Error("only spec.md and plan.md can be changed this way");
		const comment = input.comment.trim();
		if (comment === "") throw new Error("say what to change");
		await this.edit(ticketId, (t) => {
			t.revisions ??= [];
			const revisions = t.revisions;
			revisions.push({ id: String(revisions.length + 1), file: input.file as "spec.md" | "plan.md", quote: input.quote.slice(0, 4000), comment: comment.slice(0, 4000), status: "queued", at: Date.now(), ended: null, error: null });
			addEvent(t, { kind: "gate", text: `Change asked on ${input.file}: ${comment.slice(0, 200)}` });
		});
		this.wake(ticketId);
		return (await this.ticket(ticketId))!;
	}

	/**
	 * Take a ticket that is not running off the runs list, and delete the worktree the factory made for
	 * it (and its sandbox container). Nothing else: the tracker's ticket, the branch (with its commits)
	 * and the run folder stay, so running it again attaches the branch to a new worktree.
	 */
	async forget(ref: string): Promise<{ worktree: string | null }> {
		const ticketId = await this.deps.tracker.resolve(ref).catch(() => ref);
		const ticket = await this.ticket(ticketId);
		if (await this.live(ticket)) throw new Error(`ticket ${ref} is running: stop it first`);
		const { config } = this.deps;
		// Only a worktree the factory made: inside its worktrees folder.
		const worktree = ticket?.worktree && ticket.worktree.startsWith(config.treesDir + sep) && (await stat(ticket.worktree).then(() => true, () => false)) ? ticket.worktree : null;
		if (worktree !== null) await removeWorktree(config.repo, worktree);
		const name = ticket ? containerName(config, ticket.cid) : null;
		if (name !== null) await removeContainer(name);
		await this.root.commit(async (tx) => {
			const index = await tx.doc(TicketIndex);
			index.ids = index.ids.filter((x) => x !== ticketId);
			if (ticket === undefined) return;
			const doc = (await tx.doc(TicketDoc, ticketId, ticketId)) as Ticket;
			addEvent(doc, { kind: "control", text: `Removed from the runs list${worktree ? `; its worktree was deleted (branch ${doc.branch} kept)` : ""}` });
		}, context);
		return { worktree };
	}

	/** Change a ticket's document (from outside its pipeline). */
	private edit(ticketId: string, change: (ticket: Ticket) => void): Promise<void> {
		return this.root.commit(async (tx) => {
			const ticket = (await tx.doc(TicketDoc, ticketId, ticketId)) as Ticket;
			change(ticket);
			ticket.updated = Date.now();
		}, context);
	}

	private async live(ticket: Ticket | undefined): Promise<boolean> {
		return ticket?.taskId != null && (await this.harness.getTask(ticket.taskId as TaskId, context))?.state.status !== "terminal";
	}

	/**
	 * Pause a running ticket: its pipeline holds before its next phase, and its running step's next
	 * model request waits (the step's current request and tool call finish). Nothing is lost; continue
	 * with resume().
	 */
	async pause(ref: string, reason = "you"): Promise<Ticket> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const ticket = await this.ticket(ticketId);
		if (!(await this.live(ticket))) throw new Error(`ticket ${ref} is not running`);
		if (ticket!.paused === null || ticket!.paused === undefined) {
			await this.edit(ticketId, (t) => {
				t.paused = { at: Date.now(), reason };
				const step = t.steps.findLast((s) => s.status === "running");
				const where = step ? `; ${step.name} finishes its current request, then waits` : "";
				addEvent(t, { kind: reason === BUDGET ? "budget" : "control", level: "warn", text: reason === BUDGET ? `Paused: ${this.throttle.budgetText()}${where}` : `Paused by ${reason}${where}` });
			});
		}
		return (await this.ticket(ticketId))!;
	}

	/** Continue a paused ticket where it held. A ticket paused for the budget waits for the budget. */
	async resume(ref: string, by = "you"): Promise<Ticket> {
		const ticketId = await this.deps.tracker.resolve(ref);
		const ticket = await this.ticket(ticketId);
		if (!ticket?.paused) throw new Error(`ticket ${ref} is not paused`);
		if (this.throttle.budgetReached()) throw new Error(`${this.throttle.budgetText()}: raise DAILY_BUDGET_USD (and restart) or wait until tomorrow`);
		await this.edit(ticketId, (t) => {
			if (!t.paused) return;
			const held = Date.now() - t.paused.at;
			const step = t.steps.findLast((s) => s.status === "running");
			if (step) step.pausedMs = (step.pausedMs ?? 0) + held;
			addEvent(t, { kind: t.paused.reason === BUDGET ? "budget" : "control", text: `Continued by ${by} after ${duration(held)}` });
			t.paused = null;
		});
		this.wake(ticketId);
		return (await this.ticket(ticketId))!;
	}

	/** Every 15 s: pause running tickets when the budget runs out; continue them when it is back. */
	private async watchBudget(): Promise<void> {
		const reached = this.throttle.budgetReached();
		for (const ticket of await this.tickets()) {
			if (reached && !ticket.paused && (await this.live(ticket)) && ticket.state !== "waiting_approval") await this.pause(ticket.id, BUDGET);
			if (!reached && ticket.paused?.reason === BUDGET) await this.resume(ticket.id, "the factory (the budget is back)");
		}
	}

	/** For the throttle: a request of a paused ticket's step waits. */
	async holdReason(sessionId: string | undefined): Promise<string | null> {
		if (sessionId === undefined) return null;
		let ticketId = this.sessions.get(sessionId);
		if (ticketId === undefined) {
			for (const t of await this.tickets()) for (const s of t.steps) if (s.sessionId) this.sessions.set(s.sessionId, t.id);
			ticketId = this.sessions.get(sessionId);
		}
		if (ticketId === undefined) return null;
		const paused = (await this.ticket(ticketId))?.paused;
		return paused ? `${ticketId} is paused (${paused.reason === BUDGET ? this.throttle.budgetText() : `by ${paused.reason}`})` : null;
	}

	/** Model use: today's spend and limits, and what is waiting. */
	usage(): ThrottleStatus {
		return this.throttle.status();
	}

	/** What a step's model requests used so far (its conversation's pi.usage). */
	async stepUsage(conversationId: number): Promise<StepUsage | null> {
		return sumUsage(await this.harness.snapshot(UsageDoc, conversationId as ConversationId, context).catch(() => undefined));
	}

	ticket(id: string): Promise<Ticket | undefined> {
		return this.harness.snapshot(TicketDoc, id, context) as Promise<Ticket | undefined>;
	}

	async tickets(): Promise<Ticket[]> {
		const index = await this.harness.snapshot(TicketIndex, context);
		const out: Ticket[] = [];
		for (const id of index?.ids ?? []) {
			const t = await this.ticket(id);
			if (t !== undefined) out.push(t);
		}
		return out;
	}

	async inbox() {
		return (await this.harness.snapshot(SentryInbox, context)) ?? { issues: {}, environment: "", lastSync: null, lastError: null };
	}

	/**
	 * Sentry "Fix this": a ClickUp ticket with the issue and its latest stack, then its pipeline. When
	 * the issue's ticket was deleted in ClickUp, a new one replaces it (the old one leaves the runs list).
	 */
	async fixIssue(issueId: string): Promise<{ ticketId: string }> {
		const inbox = await this.inbox();
		const issue = inbox.issues[issueId];
		if (issue === undefined) throw new Error(`no Sentry issue ${issueId} in the inbox`);
		let ticketId = issue.ticketId;
		const replaced = ticketId;
		if (ticketId !== null) {
			const old = await this.ticket(ticketId);
			const gone = !(await this.live(old)) && (old?.gone === true || (await this.deps.tracker.info(ticketId).then(() => false, (e: unknown) => e instanceof TicketGone)));
			if (gone) ticketId = null;
		}
		if (ticketId === null) {
			const event = await this.deps.sentry?.latestEvent(issueId).catch(() => null);
			const { name, markdown } = ticketFor(issue, inbox.environment, event ?? null);
			const created = await this.deps.tracker.create(this.deps.config.clickup.sentryListId, name, markdown, ["sentry"]);
			ticketId = created.id;
			const id = ticketId;
			await this.root.commit(async (tx) => {
				const doc = await tx.doc(SentryInbox);
				const row = doc.issues[issueId];
				if (row) Object.assign(row, { triage: "ticketed", ticketId: id, triaged: Date.now() } satisfies Partial<Issue>);
				const ticket = (await tx.doc(TicketDoc, id, id)) as Ticket;
				ticket.source = { kind: "sentry", issueId, shortId: issue.shortId, permalink: issue.permalink };
				if (replaced !== null) {
					addEvent(ticket, { kind: "tracker", text: `New ClickUp ticket for ${issue.shortId}: the last one was deleted` });
					const old = (await tx.doc(TicketDoc, replaced, replaced)) as Ticket;
					addEvent(old, { kind: "tracker", level: "warn", text: `Replaced by a new ClickUp ticket (${id}): this one was deleted` });
					const index = await tx.doc(TicketIndex);
					index.ids = index.ids.filter((x) => x !== replaced);
				}
			}, context);
		}
		await this.start(ticketId);
		return { ticketId };
	}

	async triage(issueId: string, triage: "new" | "dismissed"): Promise<void> {
		await this.root.commit(async (tx) => {
			const row = (await tx.doc(SentryInbox)).issues[issueId];
			if (row === undefined) throw new Error(`no Sentry issue ${issueId}`);
			if (row.triage === "ticketed") throw new Error(`${row.shortId} already has a ticket`);
			Object.assign(row, { triage, triaged: triage === "new" ? null : Date.now() });
		}, context);
	}

	/** Sync Sentry now (the loop also syncs every SENTRY_POLL_INTERVAL). */
	async syncSentry(): Promise<{ issues: number; complete: boolean }> {
		if (this.deps.sentry === null) throw new Error("Sentry is not set up: set SENTRY_AUTH_TOKEN and SENTRY_ORG");
		const synced = await this.deps.sentry.issues().catch(async (error) => {
			const message = error instanceof Error ? error.message : String(error);
			await this.root.commit(async (tx) => {
				(await tx.doc(SentryInbox)).lastError = message;
			}, context);
			throw error;
		});
		await this.root.commit(async (tx) => {
			const inbox = await tx.doc(SentryInbox);
			mergeSync(inbox, synced.issues, synced.complete);
			Object.assign(inbox, { environment: this.deps.config.sentry.environment, lastSync: Date.now(), lastError: null });
		}, context);
		return { issues: synced.issues.length, complete: synced.complete };
	}

	private sprintCache: { at: number; value: Awaited<ReturnType<Tracker["sprint"]>> } | null = null;
	/** Your tasks in the current sprint (cached 30 s), each with what the factory did with it. */
	async sprint(refresh = false) {
		if (refresh || this.sprintCache === null || Date.now() - this.sprintCache.at > 30_000) {
			this.sprintCache = { at: Date.now(), value: await this.deps.tracker.sprint() };
		}
		const { sprint, tasks } = this.sprintCache.value;
		const withFactory = [];
		for (const task of tasks) withFactory.push({ ...task, factory: (await this.ticket(task.id)) ?? null });
		return { sprint, tasks: withFactory };
	}

	/** Every live task: pipelines, their steps' generations and tools, the loops (example 24). */
	async graph() {
		const state = await this.harness.taskGraph(context);
		try {
			return state.value;
		} finally {
			state.dispose();
		}
	}

	/**
	 * Free disk: a worktree is removed when its PR is merged or closed (a merged PR's local branch
	 * goes too), or when its ticket has been idle for `days`. Running tickets are never touched.
	 */
	async gc(days = this.deps.config.gcDays): Promise<string[]> {
		const done: string[] = [];
		for (const ticket of await this.tickets()) {
			if (ticket.worktree === null || ticket.branch === null) continue;
			if (ticket.taskId !== null && (await this.harness.getTask(ticket.taskId as TaskId, context))?.state.status !== "terminal") continue;
			if (!(await stat(ticket.worktree).then(() => true, () => false))) continue;
			const pr = ticket.pr === null ? null : await this.deps.gitHost.state(ticket.worktree, ticket.branch).catch(() => null);
			const idle = Date.now() - ticket.updated > days * 86_400_000;
			if (pr !== "MERGED" && pr !== "CLOSED" && !idle) continue;
			await removeWorktree(this.deps.config.repo, ticket.worktree);
			let why = pr === "MERGED" || pr === "CLOSED" ? `PR ${pr.toLowerCase()}` : `idle more than ${days} days`;
			if (pr === "MERGED" && (await git(this.deps.config.repo, "branch", "-q", "-D", ticket.branch)).code === 0) why += ", local branch deleted";
			const name = containerName(this.deps.config, ticket.cid);
			if (name !== null) await removeContainer(name);
			done.push(`removed worktree ${ticket.cid} (${why})`);
		}
		await git(this.deps.config.repo, "worktree", "prune");
		await git(this.deps.config.repo, "gc", "--auto", "--quiet");
		return done;
	}

	async close(): Promise<void> {
		if (this.budgetTimer !== null) clearInterval(this.budgetTimer);
		await this.harness.close(context);
		await this.throttle.flush();
		if (this.lock !== null) await rm(this.lock, { force: true });
	}
}

/** AUTO_PICKUP=1: every POLL_INTERVAL, start the pipelines of tickets assigned to you (a durable loop). */
function createPickup(config: Config, tracker: Tracker, log: (line: string) => void) {
	return defineTask<null, { phase: "poll"; n: number } | { phase: "wait"; n: number; until: number }, null>({
		name: "factory.pickup",
		version: 1,
		initial: () => ({ phase: "poll", n: 0 }),
		phases: {
			poll: async (task, runtime, ctx) => {
				const found = await tracker.pickup().catch((e) => {
					log(`pickup: tracker failed: ${e instanceof Error ? e.message : e}`);
					return [];
				});
				const until = Date.now() + config.pollSeconds * 1000;
				await runtime.commit(async (tx) => {
					// Start what is not running or blocked; the pipeline itself waits for a free slot.
					for (const { id, status } of found) {
						const ticket = (await tx.doc(TicketDoc, id, id)) as Ticket;
						if (ticket.state === "blocked" || ticket.state === "in_review") continue;
						if (ticket.taskId !== null && (await tx.task(ticket.taskId as TaskId))?.state.status !== "terminal") continue;
						const build = status.toLowerCase() === config.statuses.approved.toLowerCase();
						const Pipeline = runtime.registry.task("factory.pipeline");
						if (Pipeline === undefined) break;
						ticket.taskId = await tx.createTask(Pipeline as never, { ticketId: id, gate: config.specGate, build, fresh: false } as never, { ownership: { kind: "conversation" }, background: true });
						Object.assign(ticket, { state: "queued", phase: "queued", created: ticket.created || Date.now(), updated: Date.now() });
						const index = await tx.doc(TicketIndex);
						if (!index.ids.includes(id)) index.ids.unshift(id);
					}
					return { status: "running", checkpoint: { phase: "wait", n: task.state.checkpoint.n + 1, until } };
				}, ctx);
			},
			wait: async (task, runtime, ctx) => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.max(0, task.state.checkpoint.until - Date.now()));
					runtime.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
				});
				if (runtime.signal.aborted) return;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "poll", n: task.state.checkpoint.n } }), ctx);
			},
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
}

/** state/factory.pid: refuse to open a session another live process owns. */
async function takeLock(path: string): Promise<string> {
	try {
		const pid = Number((await readFile(path, "utf8")).trim());
		if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
			try {
				process.kill(pid, 0);
				throw new Error(`another factory (pid ${pid}) owns ${path.replace(/factory\.pid$/, "factory.sqlite")}: talk to it (ff status), or stop it first`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("another factory")) throw error;
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("another factory")) throw error;
	}
	const handle = await open(path, "w");
	await handle.writeFile(String(process.pid));
	await handle.close();
	return path;
}

export const _test = { takeLock, writeFile, BUDGET };

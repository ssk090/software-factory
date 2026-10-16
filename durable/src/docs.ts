// The factory's durable state, as Pi Durable documents (examples 01-documents, 03-owned-conversations,
// 11-extension-state). Every change is part of an atomic commit, so after a crash a ticket's state
// matches what its pipeline task and agents actually did. The dashboard watches these documents.
import { defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

/** What one agent step was: a conversation owned by the ticket's pipeline task. */
export type StepRecord = {
	/** `<role>-<round>-<attempt>`, e.g. `code-2-1`. */
	name: string;
	role: string;
	round: number;
	attempt: number;
	model: string;
	/** A Pi Durable ConversationId (a number). */
	conversationId: number;
	/** The pipeline task (run) the step belongs to. */
	taskId: number;
	status: "running" | "done" | "failed";
	started: number;
	ended: number | null;
	error: string | null;
};

export type TicketState =
	| "queued" // waiting for a free slot (MAX_PARALLEL)
	| "running"
	| "waiting_approval" // spec posted; you approve on the dashboard or move the ticket to S_APPROVED
	| "blocked" // failed or needs answers; `blocked` says why
	| "in_review" // PR open for a human
	| "stopped"; // you stopped it

export type Ticket = {
	id: string;
	cid: string;
	title: string;
	url: string;
	/** What was asked: the full pipeline, the spec and plan only, or the build of an approved spec. */
	mode: "full" | "spec" | "build";
	state: TicketState;
	phase: string;
	/** The pipeline task (a Pi Durable TaskId, a number). */
	taskId: number | null;
	branch: string | null;
	worktree: string | null;
	run: string | null;
	slot: number | null;
	specStatus: "READY" | "NEEDS_INPUT" | null;
	approved: { at: number; note: string } | null;
	verify: { round: number; ok: boolean; log: string }[];
	reviews: { round: number; verdict: "PASS" | "FIX"; file: string }[];
	pr: string | null;
	judge: { score: number; summary: string } | null;
	blocked: string | null;
	steps: StepRecord[];
	/**
	 * Where the next run continues: the pipeline checkpoint as the last run entered its latest phase
	 * (null after a run that finished, or before any). A run that was stopped or blocked continues
	 * from it instead of starting over; `--fresh` starts over.
	 */
	resume: JsonObject | null;
	/** Where the ticket came from, when the factory made it (a Sentry issue). */
	source: { kind: "sentry"; issueId: string; shortId: string; permalink: string } | null;
	created: number;
	updated: number;
};

export const newTicket = (id: string): Ticket => ({
	id,
	cid: id,
	title: "",
	url: "",
	mode: "full",
	state: "queued",
	phase: "queued",
	taskId: null,
	branch: null,
	worktree: null,
	run: null,
	slot: null,
	specStatus: null,
	approved: null,
	verify: [],
	reviews: [],
	pr: null,
	judge: null,
	blocked: null,
	steps: [],
	resume: null,
	source: null,
	created: 0,
	updated: 0,
});

/** One document per ticket, keyed by the tracker's ticket id. */
export const TicketDoc = defineDocFamily<Ticket, string>({
	kind: "factory.ticket",
	version: 1,
	scope: "session",
	family: true,
	initial: (id) => newTicket(id),
});

/** Every ticket the factory knows, newest first: the documents above cannot be listed. */
export const TicketIndex = defineDoc<{ ids: string[] }>({
	kind: "factory.tickets",
	version: 1,
	scope: "session",
	initial: () => ({ ids: [] }),
});

/** On every step conversation: which ticket and step it is. The environment and tools read it. */
export const StepDoc = defineDoc<{ ticketId: string; name: string; role: string; worktree: string; run: string; slot: number }>({
	kind: "factory.step",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ticketId: "", name: "", role: "", worktree: "", run: "", slot: 0 }),
});

/** A production issue from Sentry and what you decided about it. Sentry owns the issue fields. */
export type Issue = {
	id: string;
	shortId: string;
	project: string;
	title: string;
	culprit: string;
	level: string;
	status: string;
	substatus: string;
	priority: string;
	unhandled: boolean;
	events: number;
	users: number;
	firstSeen: string;
	lastSeen: string;
	permalink: string;
	/** The last complete sync no longer listed it: resolved, ignored or archived in Sentry. */
	gone: boolean;
	triage: "new" | "dismissed" | "ticketed";
	ticketId: string | null;
	triaged: number | null;
};

export const SentryInbox = defineDoc<{
	issues: Record<string, Issue>;
	environment: string;
	lastSync: number | null;
	lastError: string | null;
}>({
	kind: "factory.sentry",
	version: 1,
	scope: "session",
	initial: () => ({ issues: {}, environment: "", lastSync: null, lastError: null }),
});

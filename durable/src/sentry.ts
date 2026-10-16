// Production issues from Sentry: a durable sync loop (example 13-recovery's timer pattern) that
// keeps the SentryInbox document current, a ranking of which issue needs a fix first, and the ticket
// body for "Fix this" (the latest event's exception and in-app stack, for the spec writer).
import { defineTask } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { type Issue, SentryInbox } from "./docs.ts";
import { requestJson } from "./http.ts";

export type SentryIssue = {
	id: string;
	shortId?: string;
	title?: string;
	culprit?: string;
	level?: string;
	status?: string;
	substatus?: string;
	priority?: string;
	isUnhandled?: boolean;
	count?: string | number;
	userCount?: number;
	firstSeen?: string;
	lastSeen?: string;
	permalink?: string;
	project?: { slug?: string };
};

export interface SentryApi {
	/** Every matching issue, and whether the list is complete (no page limit was hit). */
	issues(): Promise<{ issues: SentryIssue[]; complete: boolean }>;
	latestEvent(issueId: string): Promise<unknown>;
}

/** `<https://...>; rel="next"; results="true"; cursor="..."`: the next page, if it has results. */
export function nextPage(link: string | null): string | null {
	for (const part of (link ?? "").split(",")) {
		const url = /<([^>]+)>/.exec(part)?.[1];
		if (url && /rel="next"/.test(part) && /results="true"/.test(part)) return url;
	}
	return null;
}

export class SentryClient implements SentryApi {
	private readonly config: Config["sentry"];
	constructor(config: Config["sentry"]) {
		this.config = config;
	}

	private headers() {
		if (!this.config.token || !this.config.org) throw new Error("set SENTRY_AUTH_TOKEN and SENTRY_ORG");
		return { Authorization: `Bearer ${this.config.token}` };
	}

	async issues() {
		const query = new URLSearchParams({ query: this.config.query, statsPeriod: this.config.period, limit: "100", sort: "freq" });
		query.append("environment", this.config.environment);
		for (const project of this.config.projects) query.append("project", project);
		let url: string | null = `${this.config.url}/api/0/organizations/${encodeURIComponent(this.config.org)}/issues/?${query}`;
		const issues: SentryIssue[] = [];
		for (let page = 0; url !== null && page < this.config.maxPages; page++) {
			const response: { data: SentryIssue[]; headers: Headers } = await requestJson<SentryIssue[]>("GET", url, { headers: this.headers() });
			issues.push(...response.data);
			url = nextPage(response.headers.get("link"));
		}
		return { issues, complete: url === null };
	}

	async latestEvent(issueId: string) {
		const url = `${this.config.url}/api/0/organizations/${encodeURIComponent(this.config.org)}/issues/${encodeURIComponent(issueId)}/events/latest/`;
		return (await requestJson<unknown>("GET", url, { headers: this.headers() })).data;
	}
}

const count = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0);

export function toIssue(raw: SentryIssue): Omit<Issue, "gone" | "triage" | "ticketId" | "triaged"> {
	return {
		id: String(raw.id),
		shortId: raw.shortId || String(raw.id),
		project: raw.project?.slug ?? "",
		title: raw.title ?? "",
		culprit: raw.culprit ?? "",
		level: raw.level ?? "",
		status: raw.status ?? "",
		substatus: raw.substatus ?? "",
		priority: raw.priority ?? "",
		unhandled: raw.isUnhandled === true,
		events: count(raw.count),
		users: count(raw.userCount),
		firstSeen: raw.firstSeen ?? "",
		lastSeen: raw.lastSeen ?? "",
		permalink: /^https?:\/\//.test(raw.permalink ?? "") ? raw.permalink! : "",
	};
}

/**
 * Merge one sync into the inbox. Sentry owns the issue fields; you own `triage`. A complete sync
 * marks issues it no longer lists as gone. A dismissed issue that Sentry newly marks regressed comes
 * back as new.
 */
export function mergeSync(inbox: { issues: Record<string, Issue> }, synced: readonly SentryIssue[], complete: boolean): void {
	const seen = new Set<string>();
	for (const raw of synced) {
		const fresh = toIssue(raw);
		seen.add(fresh.id);
		const old = inbox.issues[fresh.id];
		if (old === undefined) {
			inbox.issues[fresh.id] = { ...fresh, gone: false, triage: "new", ticketId: null, triaged: null };
			continue;
		}
		const regressed = old.triage === "dismissed" && fresh.substatus === "regressed" && old.substatus !== "regressed";
		Object.assign(old, fresh, { gone: false });
		if (regressed) Object.assign(old, { triage: "new", triaged: null });
	}
	if (complete) for (const issue of Object.values(inbox.issues)) if (!seen.has(issue.id)) issue.gone = true;
}

const PRIORITY: Record<string, number> = { high: 3, medium: 2, low: 1 };
const LEVEL: Record<string, number> = { fatal: 1.5, error: 1, warning: 0.5, info: 0.2, debug: 0.1 };

/**
 * How much an issue needs a fix, for sorting: Sentry's priority and level, how often it happens and
 * to how many users, how recently, and whether it was unhandled. Higher first; 0 when it is gone.
 */
export function score(issue: Issue, now = Date.now()): number {
	if (issue.gone) return 0;
	const seen = Date.parse(issue.lastSeen);
	const hours = Number.isNaN(seen) ? Number.POSITIVE_INFINITY : Math.max(0, (now - seen) / 3_600_000);
	const recency = hours <= 24 ? 1 : hours <= 24 * 7 ? 0.5 : 0.2;
	const s = (PRIORITY[issue.priority] ?? 2) * (LEVEL[issue.level] ?? 1) * Math.log10(1 + issue.events) * (1 + Math.log10(1 + issue.users)) * recency;
	return Math.round(s * (issue.unhandled ? 1.5 : 1) * 100) / 100;
}

type Frame = { filename?: string; absPath?: string; module?: string; function?: string; lineNo?: number; inApp?: boolean };
type ExceptionValue = { type?: string; value?: string; stacktrace?: { frames?: Frame[] } };

/** The ticket for a production issue: what the spec writer needs to find the root cause. */
export function ticketFor(issue: Issue, environment: string, event: unknown): { name: string; markdown: string } {
	const lines = [
		`Sentry issue ${issue.shortId} in ${issue.project || "?"} (${environment}): ${issue.title}`,
		"",
		`- Link: ${issue.permalink || "(none)"}`,
		`- Level: ${issue.level || "?"}, priority: ${issue.priority || "?"}${issue.unhandled ? ", unhandled" : ""}`,
		`- Events: ${issue.events}, users: ${issue.users}`,
		`- First seen: ${issue.firstSeen}, last seen: ${issue.lastSeen}`,
		`- Culprit: ${issue.culprit || "?"}`,
	];
	const entries = (event as { entries?: { type?: string; data?: { values?: ExceptionValue[] } }[] } | null)?.entries ?? [];
	const values = entries.find((e) => e.type === "exception")?.data?.values ?? [];
	const last = values.at(-1);
	if (last !== undefined) {
		lines.push("", "## Exception", "", "```", `${last.type ?? "Error"}: ${last.value ?? ""}`.slice(0, 2000), "```");
		const frames = (last.stacktrace?.frames ?? []).filter((f) => f.inApp).slice(-12);
		if (frames.length > 0) {
			lines.push("", "In-app stack, most recent call last:", "");
			for (const f of frames) lines.push(`- ${f.filename ?? f.absPath ?? f.module ?? "?"}:${f.lineNo ?? "?"} in ${f.function ?? "?"}`);
		}
	}
	lines.push(
		"",
		"## What to do",
		"",
		"Find the root cause of this production error and fix it. First write a test that reproduces it.",
	);
	return { name: `fix: ${issue.shortId} ${issue.title}`.slice(0, 200), markdown: lines.join("\n") };
}

/** The durable sync loop: sync, record, sleep SENTRY_POLL_INTERVAL; after a restart it continues. */
export function createSentrySync(options: { config: Config; api: SentryApi; log: (line: string) => void }) {
	const { config, api } = options;
	const SentrySync = defineTask<null, { phase: "sync"; n: number } | { phase: "wait"; n: number; until: number }, null>({
		name: "factory.sentry-sync",
		version: 1,
		initial: () => ({ phase: "sync", n: 0 }),
		phases: {
			sync: async (task, runtime, context) => {
				let synced: { issues: SentryIssue[]; complete: boolean } | null = null;
				let error: string | null = null;
				try {
					synced = await api.issues();
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
					options.log(`sentry sync failed: ${error}`);
				}
				const until = Date.now() + config.sentry.pollSeconds * 1000;
				await runtime.commit(async (tx) => {
					const inbox = await tx.doc(SentryInbox);
					inbox.environment = config.sentry.environment;
					inbox.lastError = error;
					if (synced !== null) {
						mergeSync(inbox, synced.issues, synced.complete);
						inbox.lastSync = Date.now();
					}
					return { status: "running", checkpoint: { phase: "wait", n: task.state.checkpoint.n + 1, until } };
				}, context);
			},
			wait: async (task, runtime, context) => {
				// A durable timer: the time to wake is in the checkpoint, so a restart waits only what is left.
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.max(0, task.state.checkpoint.until - Date.now()));
					runtime.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
				});
				if (runtime.signal.aborted) return;
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "sync", n: task.state.checkpoint.n } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return SentrySync;
}

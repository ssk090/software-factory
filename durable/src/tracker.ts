// The tracker: ClickUp (API v2). Ticket status, comments and fetch for the pipeline, the sprint
// view, and creating tickets from Sentry issues. `Tracker` is the seam: tests pass a fake.
import type { Config } from "./config.ts";
import { HttpError, requestJson } from "./http.ts";

export type TicketInfo = { id: string; cid: string; title: string; url: string; status: string; description: string };
export type SprintTask = {
	id: string;
	cid: string;
	title: string;
	url: string;
	status: string;
	statusColor: string;
	priority: string | null;
	due: number | null;
	list: string;
	updated: number;
};
export type Sprint = { id: string; name: string; start: number | null; due: number | null };

export interface Tracker {
	info(id: string): Promise<TicketInfo>;
	/** ticket.md and comments.md contents. */
	fetch(id: string): Promise<{ ticket: string; comments: string }>;
	setStatus(id: string, status: string): Promise<void>;
	comment(id: string, text: string): Promise<void>;
	/** A ticket key, id or URL, as the tracker's id. */
	resolve(ref: string): Promise<string>;
	/** Tickets assigned to me in S_TODO or S_APPROVED, approved first (auto pickup). */
	pickup(): Promise<{ id: string; status: string }[]>;
	sprint(): Promise<{ sprint: Sprint; tasks: SprintTask[] }>;
	create(listId: string, name: string, markdown: string, tags: string[]): Promise<{ id: string; url: string }>;
	/** Attach a file to the ticket (a new attachment each call). */
	attach(id: string, name: string, content: string): Promise<void>;
}

const API = "https://api.clickup.com/api/v2";
type Task = {
	id: string;
	custom_id?: string | null;
	name: string;
	url: string;
	status?: { status: string; color?: string };
	priority?: { priority?: string } | null;
	due_date?: string | null;
	date_updated?: string | null;
	list?: { id: string; name: string };
	markdown_description?: string;
	description?: string;
};
const ms = (value: string | null | undefined): number | null => (value && /^\d+$/.test(value) ? Number(value) : null);

/** The tracker has no such ticket (any more): it was deleted, or the id is wrong. */
export class TicketGone extends Error {
	readonly id: string;
	constructor(id: string, how: string) {
		super(`the ClickUp task ${id} is ${how}`);
		this.id = id;
	}
}

export class ClickUp implements Tracker {
	private readonly config: Config;
	constructor(config: Config) {
		this.config = config;
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const { token } = this.config.clickup;
		if (!token) throw new Error("CLICKUP_TOKEN is not set (ff login CLICKUP_TOKEN)");
		return (await requestJson<T>(method, `${API}${path}`, { headers: { Authorization: token }, body, timeoutMs: 60_000 })).data;
	}

	async info(id: string): Promise<TicketInfo> {
		const t = await this.api<Task>("GET", `/task/${encodeURIComponent(id)}?include_markdown_description=true`).catch((error: unknown) => {
			if (error instanceof HttpError && error.status === 404) throw new TicketGone(id, /deleted/i.test(error.message) ? "deleted" : "not found");
			// ClickUp answers 401 for a task id outside your workspace.
			if (error instanceof HttpError && error.status === 401 && /OAUTH_027|team not authorized/i.test(error.message)) throw new TicketGone(id, "not in your ClickUp workspace");
			throw error;
		});
		return {
			id: t.id,
			cid: t.custom_id || t.id,
			title: t.name,
			url: t.url,
			status: t.status?.status ?? "",
			description: t.markdown_description ?? t.description ?? "",
		};
	}

	async fetch(id: string) {
		const t = await this.info(id);
		const comments = await this.api<{ comments: { user?: { username?: string }; comment_text: string }[] }>("GET", `/task/${encodeURIComponent(id)}/comment`);
		return {
			ticket: `# ${t.cid}: ${t.title}\n\nURL: ${t.url}\n\n${t.description}\n`,
			comments: comments.comments.map((c) => `[${c.user?.username ?? "?"}] ${c.comment_text}\n`).join("\n"),
		};
	}

	async setStatus(id: string, status: string) {
		await this.api("PUT", `/task/${encodeURIComponent(id)}`, { status });
	}

	async comment(id: string, text: string) {
		await this.api("POST", `/task/${encodeURIComponent(id)}/comment`, { comment_text: text, notify_all: false });
	}

	async attach(id: string, name: string, content: string) {
		const { token } = this.config.clickup;
		if (!token) throw new Error("CLICKUP_TOKEN is not set (ff login CLICKUP_TOKEN)");
		const url = `${API}/task/${encodeURIComponent(id)}/attachment`;
		// Multipart (not JSON), so not through requestJson; one more try for a transient failure.
		for (let attempt = 1; ; attempt++) {
			const form = new FormData();
			form.append("attachment", new Blob([content], { type: "text/markdown" }), name);
			const response = await fetch(url, { method: "POST", headers: { Authorization: token }, body: form, signal: AbortSignal.timeout(60_000) });
			if (response.ok) return;
			const text = (await response.text().catch(() => "")).slice(0, 500);
			if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			if (response.status === 404) throw new TicketGone(id, "deleted");
			throw new HttpError(response.status, text, url);
		}
	}

	async resolve(ref: string): Promise<string> {
		// The last path segment of a URL, without query or fragment.
		let key = (ref.trim().split("/").at(-1) ?? "").split(/[?#]/)[0] ?? "";
		if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`not a ticket key, id or URL: ${ref}`);
		// A bare ticket number (7642): the custom id with the workspace's prefix (CHP-7642).
		if (/^\d{1,7}$/.test(key)) {
			const { idPrefix } = this.config.clickup;
			if (!idPrefix) throw new Error(`${key} is a ticket number: use the full key (e.g. CHP-${key}), or set CLICKUP_ID_PREFIX`);
			key = `${idPrefix}-${key}`;
		}
		// A custom id (CHP-1234) is looked up in the team; a plain id is the id.
		if (/^[A-Za-z]+-\d+$/.test(key)) {
			const t = await this.api<Task>("GET", `/task/${key.toUpperCase()}?custom_task_ids=true&team_id=${encodeURIComponent(this.config.clickup.teamId)}`).catch((error: unknown) => {
				if (error instanceof HttpError && (error.status === 404 || error.status === 401)) throw new TicketGone(key.toUpperCase(), "not found in your ClickUp workspace");
				throw error;
			});
			return t.id;
		}
		return key;
	}

	async pickup() {
		const { teamId, userId, listId } = this.config.clickup;
		const { todo, approved } = this.config.statuses;
		const sprint = this.config.clickup.sprintListId || this.config.clickup.sprintFolderId ? (await this.currentSprint()).id : "";
		const path = sprint ? `/list/${sprint}/task` : listId ? `/list/${listId}/task` : `/team/${teamId}/task`;
		const query = new URLSearchParams();
		query.append("assignees[]", userId);
		query.append("statuses[]", todo);
		query.append("statuses[]", approved);
		if (sprint) query.append("include_timl", "true");
		const tasks: Task[] = [];
		for (let page = 0; page < 20; page++) {
			query.set("page", String(page));
			const r = await this.api<{ tasks: Task[]; last_page?: boolean }>("GET", `${path}?${query}`);
			tasks.push(...r.tasks);
			if (r.last_page !== false || r.tasks.length === 0) break;
		}
		const isApproved = (t: Task) => (t.status?.status ?? "").toLowerCase() === approved.toLowerCase();
		return tasks.sort((a, b) => Number(isApproved(b)) - Number(isApproved(a))).map((t) => ({ id: t.id, status: t.status?.status ?? "" }));
	}

	/** CLICKUP_SPRINT_LIST_ID, or the list of CLICKUP_SPRINT_FOLDER_ID whose dates cover today (else the latest started). */
	async currentSprint(now = Date.now()): Promise<Sprint> {
		const { sprintListId, sprintFolderId } = this.config.clickup;
		type List = { id: string; name: string; start_date?: string | null; due_date?: string | null };
		const toSprint = (l: List): Sprint => ({ id: l.id, name: l.name, start: ms(l.start_date), due: ms(l.due_date) });
		if (sprintListId) return toSprint(await this.api<List>("GET", `/list/${encodeURIComponent(sprintListId)}`));
		if (!sprintFolderId) throw new Error("set CLICKUP_SPRINT_FOLDER_ID (the Sprints folder) or CLICKUP_SPRINT_LIST_ID");
		const { lists } = await this.api<{ lists: List[] }>("GET", `/folder/${encodeURIComponent(sprintFolderId)}/list?archived=false`);
		return pickSprint(lists.map(toSprint), now);
	}

	async sprint() {
		const sprint = await this.currentSprint();
		const query = new URLSearchParams({ include_timl: "true", subtasks: "true" });
		query.append("assignees[]", this.config.clickup.userId);
		const tasks: SprintTask[] = [];
		for (let page = 0; page < 20; page++) {
			query.set("page", String(page));
			const r = await this.api<{ tasks: Task[]; last_page?: boolean }>("GET", `/list/${sprint.id}/task?${query}`);
			for (const t of r.tasks) {
				tasks.push({
					id: t.id,
					cid: t.custom_id || t.id,
					title: t.name,
					url: t.url,
					status: t.status?.status ?? "",
					statusColor: t.status?.color ?? "",
					priority: t.priority?.priority ?? null,
					due: ms(t.due_date),
					list: t.list?.name ?? "",
					updated: ms(t.date_updated) ?? 0,
				});
			}
			if (r.last_page !== false || r.tasks.length === 0) break;
		}
		return { sprint, tasks };
	}

	async create(listId: string, name: string, markdown: string, tags: string[]) {
		if (!listId) throw new Error("set SENTRY_CLICKUP_LIST_ID (or CLICKUP_LIST_ID): the list tickets from Sentry go to");
		const body = {
			name,
			markdown_content: markdown,
			description: markdown,
			assignees: this.config.clickup.userId ? [Number(this.config.clickup.userId)] : [],
			status: this.config.statuses.todo,
			tags,
		};
		let t: Task;
		try {
			t = await this.api<Task>("POST", `/list/${encodeURIComponent(listId)}/task`, body);
		} catch (error) {
			// A list without the S_TODO status: create it in the list's default status instead.
			if (!(error instanceof Error && /HTTP 400/.test(error.message) && /status/i.test(error.message))) throw error;
			const { status: _drop, ...rest } = body;
			t = await this.api<Task>("POST", `/list/${encodeURIComponent(listId)}/task`, rest);
		}
		return { id: t.id, url: t.url };
	}
}

/** The sprint whose dates cover `now`; else the one that started last; else the last list. */
export function pickSprint(sprints: readonly Sprint[], now: number): Sprint {
	if (sprints.length === 0) throw new Error("the sprint folder has no lists");
	const covering = sprints.filter((s) => s.start !== null && s.due !== null && s.start <= now && now <= s.due);
	if (covering.length > 0) return covering.sort((a, b) => b.start! - a.start!)[0]!;
	const started = sprints.filter((s) => s.start !== null && s.start <= now).sort((a, b) => b.start! - a.start!);
	return started[0] ?? sprints.at(-1)!;
}

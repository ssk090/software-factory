// The tracker: ClickUp (API v2). The same operations tracker/clickup.sh had, plus the sprint view
// and creating tickets from Sentry issues. `Tracker` is the seam: tests pass a fake.
import type { Config } from "./config.ts";
import { requestJson } from "./http.ts";

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
		const t = await this.api<Task>("GET", `/task/${encodeURIComponent(id)}?include_markdown_description=true`);
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

	async resolve(ref: string): Promise<string> {
		// The last path segment of a URL, without query or fragment (as tracker/clickup.sh did).
		const key = (ref.trim().split("/").at(-1) ?? "").split(/[?#]/)[0] ?? "";
		if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`not a ticket key, id or URL: ${ref}`);
		// A custom id (CHP-1234) is looked up in the team; a plain id is the id.
		if (/^[A-Za-z]+-\d+$/.test(key)) {
			const t = await this.api<Task>("GET", `/task/${key.toUpperCase()}?custom_task_ids=true&team_id=${encodeURIComponent(this.config.clickup.teamId)}`);
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

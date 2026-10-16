// What an agent step changed in the ticket's worktree, for the dashboard's diff drawer: the commits
// it made, and while it runs its uncommitted edits and new files too. A step records the commit it
// started from and the one it ended on; a step from before that is found by its time window.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepRecord } from "./docs.ts";
import { git } from "./git.ts";

export type DiffLine = { kind: "add" | "del" | "ctx" | "note"; old: number | null; new: number | null; text: string };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
	path: string;
	from: string | null;
	status: "added" | "deleted" | "modified" | "renamed";
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	/** Lines left out to keep the page fast (a generated or huge file). */
	cut: number;
};
export type StepDiff = {
	from: string | null;
	/** null: the working tree (the step is running, or left edits uncommitted). */
	to: string | null;
	live: boolean;
	commits: { sha: string; subject: string }[];
	files: DiffFile[];
	additions: number;
	deletions: number;
	/** Files left out (more than MAX_FILES). */
	more: number;
};

const MAX_FILES = 200;
const MAX_LINES_PER_FILE = 2500;
const MAX_NEW_FILE_BYTES = 200_000;

/** The last commit on HEAD made before `ms`, or null. */
async function commitBefore(worktree: string, ms: number): Promise<string | null> {
	const r = await git(worktree, "log", "-1", "--format=%H", `--before=@${Math.floor(ms / 1000)}`, "HEAD");
	return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Parse `git diff` output into files, hunks and numbered lines. */
export function parseDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			file = { path: m?.[2] ?? line.slice(11), from: null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], cut: 0 };
			files.push(file);
			hunk = null;
			continue;
		}
		if (file === null) continue;
		if (hunk === null) {
			if (line.startsWith("new file mode")) file.status = "added";
			else if (line.startsWith("deleted file mode")) file.status = "deleted";
			else if (line.startsWith("rename from ")) Object.assign(file, { status: "renamed", from: line.slice(12) });
			else if (line.startsWith("rename to ")) file.path = line.slice(10);
			else if (line.startsWith("Binary files ")) file.binary = true;
		}
		const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		if (h) {
			oldNo = Number(h[1]);
			newNo = Number(h[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (hunk === null || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		const counted = file.hunks.reduce((n, x) => n + x.lines.length, 0);
		const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("\\") ? "note" : "ctx";
		if (kind === "add") file.additions++;
		if (kind === "del") file.deletions++;
		if (counted >= MAX_LINES_PER_FILE) {
			if (kind !== "note") file.cut++;
			continue;
		}
		if (kind === "add") hunk.lines.push({ kind, old: null, new: newNo++, text: line.slice(1) });
		else if (kind === "del") hunk.lines.push({ kind, old: oldNo++, new: null, text: line.slice(1) });
		else if (kind === "note") hunk.lines.push({ kind, old: null, new: null, text: line.slice(2) });
		// A context line always starts with a space; an empty line is the end of git's output.
		else if (line !== "") hunk.lines.push({ kind, old: oldNo++, new: newNo++, text: line.slice(1) });
	}
	return files;
}

/** A new, untracked file as an all-added diff (a running step's file that is not in git yet). */
async function untrackedFile(worktree: string, path: string): Promise<DiffFile> {
	const text = await readFile(join(worktree, path), "utf8").catch(() => null);
	const binary = text === null || text.includes("\u0000");
	const file: DiffFile = { path, from: null, status: "added", binary, additions: 0, deletions: 0, hunks: [], cut: 0 };
	if (binary || text === null) return file;
	if (text.length > MAX_NEW_FILE_BYTES) {
		file.cut = text.split("\n").length;
		file.additions = file.cut;
		return file;
	}
	const lines = text.replace(/\n$/, "").split("\n");
	file.additions = lines.length;
	const shown = lines.slice(0, MAX_LINES_PER_FILE);
	file.cut = lines.length - shown.length;
	file.hunks.push({ header: `@@ -0,0 +1,${lines.length} @@ (new, not committed yet)`, lines: shown.map((t, i) => ({ kind: "add", old: null, new: i + 1, text: t })) });
	return file;
}

/** What `step` changed in `worktree`: committed, and while it runs (or left them) its uncommitted edits. */
export async function stepDiff(worktree: string, step: StepRecord): Promise<StepDiff> {
	const from = step.headBefore ?? (await commitBefore(worktree, step.started));
	const running = step.status === "running";
	const end = running ? null : (step.headAfter ?? (step.ended === null ? null : await commitBefore(worktree, step.ended + 2000)));
	// The working tree: the step runs, or it ended without committing everything (a coder that gave up).
	const dirty = (await git(worktree, "status", "--porcelain")).stdout.trim() !== "";
	const head = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
	const toTree = running || (dirty && (end === null || end === head));
	const to = toTree ? null : end;
	const range = from === null ? [] : to === null ? [from] : [`${from}..${to}`];
	const raw = await git(worktree, "diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", ...range);
	let files = parseDiff(raw.stdout);
	if (toTree) {
		const untracked = (await git(worktree, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean);
		for (const path of untracked.slice(0, MAX_FILES)) files.push(await untrackedFile(worktree, path));
	}
	const log = from === null ? { stdout: "" } : await git(worktree, "log", "--format=%h%x00%s", `${from}..${to ?? "HEAD"}`);
	const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
		const [sha, subject = ""] = l.split("\u0000");
		return { sha: sha!, subject };
	});
	const more = Math.max(0, files.length - MAX_FILES);
	files = files.slice(0, MAX_FILES);
	return {
		from,
		to,
		live: running,
		commits,
		files,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
		more,
	};
}

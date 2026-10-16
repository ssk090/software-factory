// The git host: GitHub through the gh CLI (as before). `GitHost` is the seam: tests pass a fake.
import { run } from "./git.ts";

/** A review comment on a line of the PR's new code (a range when `start_line` is set); its body may hold a `suggestion` block. */
export type InlineComment = { path: string; line: number; start_line?: number; body: string };

export interface GitHost {
	/** The open PR of a branch, or null. */
	prFor(worktree: string, branch: string): Promise<string | null>;
	createDraft(worktree: string, base: string, branch: string, title: string, body: string): Promise<string>;
	edit(worktree: string, pr: string, title: string, body: string): Promise<void>;
	addLabel(worktree: string, pr: string, label: string): Promise<void>;
	comment(worktree: string, pr: string, body: string): Promise<void>;
	/** One PR review (a comment, never an approval) with its inline comments, on `commit`. */
	review(worktree: string, pr: string, commit: string, body: string, comments: readonly InlineComment[]): Promise<void>;
	ready(worktree: string, pr: string): Promise<void>;
	/** merged, closed or open, for gc. */
	state(worktree: string, branch: string): Promise<"MERGED" | "CLOSED" | "OPEN" | null>;
}

async function gh(cwd: string, args: string[], input?: string): Promise<string> {
	const r = await run("gh", args, { cwd, input, timeoutMs: 120_000 });
	if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
	return r.stdout.trim();
}

export class GitHubCli implements GitHost {
	async prFor(worktree: string, branch: string) {
		const r = await run("gh", ["pr", "view", branch, "--json", "url,state", "-q", 'select(.state == "OPEN") | .url'], { cwd: worktree, timeoutMs: 120_000 });
		return r.code === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : null;
	}
	createDraft(worktree: string, base: string, branch: string, title: string, body: string) {
		return gh(worktree, ["pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body-file", "-"], body);
	}
	async edit(worktree: string, pr: string, title: string, body: string) {
		await gh(worktree, ["pr", "edit", pr, "--title", title, "--body-file", "-"], body);
	}
	async addLabel(worktree: string, pr: string, label: string) {
		await run("gh", ["label", "create", label, "--color", "5319E7", "--description", "Pull request opened by the software factory"], { cwd: worktree });
		await gh(worktree, ["pr", "edit", pr, "--add-label", label]);
	}
	async comment(worktree: string, pr: string, body: string) {
		await gh(worktree, ["pr", "comment", pr, "--body-file", "-"], body);
	}
	async review(worktree: string, pr: string, commit: string, body: string, comments: readonly InlineComment[]) {
		const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr);
		if (m === null) throw new Error(`not a GitHub PR URL: ${pr}`);
		const payload = {
			commit_id: commit,
			event: "COMMENT",
			body,
			comments: comments.map((c) => ({
				path: c.path, line: c.line, side: "RIGHT",
				...(c.start_line !== undefined && c.start_line < c.line ? { start_line: c.start_line, start_side: "RIGHT" } : {}),
				body: c.body,
			})),
		};
		await gh(worktree, ["api", "--method", "POST", `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, "--input", "-"], JSON.stringify(payload));
	}
	async ready(worktree: string, pr: string) {
		await gh(worktree, ["pr", "ready", pr]);
	}
	async state(worktree: string, branch: string) {
		const r = await run("gh", ["pr", "view", branch, "--json", "state", "-q", ".state"], { cwd: worktree, timeoutMs: 120_000 });
		const s = r.stdout.trim();
		return r.code === 0 && (s === "MERGED" || s === "CLOSED" || s === "OPEN") ? s : null;
	}
}

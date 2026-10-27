// Backend repositories (BACKEND_REPOS): more repos a ticket can read and change next to REPO. Each has
// a clone in DATA_DIR/backends/<name>, and each ticket gets a worktree of it on the ticket's own branch
// in <ticket worktree>.backends/<name>. Agents commit there. Only the factory pushes and opens the PR.
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { repoLocked, run, type Run } from "./git.ts";

export type BackendRepo = { readonly name: string; readonly url: string; readonly slug: string };
/** A draft PR the factory opened in a backend repo. */
export type BackendPr = { repo: string; pr: string };

/** "name=url name=url": a name is a folder name, the url anything git clones. */
export function parseBackends(value: string | undefined): BackendRepo[] {
	const out: BackendRepo[] = [];
	for (const entry of (value ?? "").split(/\s+/).filter(Boolean)) {
		const m = /^([A-Za-z0-9][\w.-]*)=(.+)$/.exec(entry);
		if (m === null) throw new Error(`BACKEND_REPOS: "${entry}" is not name=url`);
		if (out.some((b) => b.name === m[1])) throw new Error(`BACKEND_REPOS: ${m[1]} is listed twice`);
		out.push({ name: m[1]!, url: m[2]!, slug: slugOf(m[2]!) });
	}
	return out;
}

/** owner/name for gh --repo, from an https, ssh or ssh-alias URL. */
export function slugOf(url: string): string {
	const m = /[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(url);
	return m ? `${m[1]}/${m[2]}` : url;
}

export const backendsDir = (worktree: string) => `${worktree}.backends`;
export const backendTree = (worktree: string, name: string) => join(backendsDir(worktree), name);
export const backendCache = (dataDir: string, name: string) => join(dataDir, "backends", name);

/**
 * The factory's own git for a backend repo. ORIGIN_URL (useOriginUrl) sets origin for every git command
 * through GIT_CONFIG_PARAMETERS. The factory drops it here, or its push would land in REPO.
 */
export function backendGit(cwd: string, ...args: string[]): Promise<Run> {
	const { GIT_CONFIG_PARAMETERS: _, ...env } = process.env;
	return run("git", ["-C", cwd, ...args], { env });
}
async function backendGitOk(cwd: string, ...args: string[]): Promise<string> {
	const r = await backendGit(cwd, ...args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 1000)}`);
	return r.stdout.trim();
}
const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * The ticket's worktree of one backend repo. The clone is made once. The worktree is kept when it is
 * on the branch, checked out again when the branch exists, else cut fresh from origin/<base>.
 */
export async function prepareBackend(options: { cache: string; url: string; base: string; branch: string; tree: string; fresh: boolean }): Promise<"kept" | "attached" | "new"> {
	const { cache, url, base, branch, tree, fresh } = options;
	return repoLocked(async () => {
		if (!(await exists(join(cache, ".git")))) {
			await mkdir(join(cache, ".."), { recursive: true });
			await rm(cache, { recursive: true, force: true });
			const cloned = await backendGit(join(cache, ".."), "clone", "-q", "--no-checkout", url, cache);
			if (cloned.code !== 0) throw new Error(`git clone ${url}: ${cloned.stderr.trim().slice(0, 500)}`);
		}
		if (!fresh && (await exists(tree)) && (await backendGit(tree, "branch", "--show-current")).stdout.trim() === branch) return "kept";
		await backendGit(cache, "worktree", "remove", "--force", tree);
		await rm(tree, { recursive: true, force: true });
		await backendGit(cache, "worktree", "prune");
		await mkdir(join(tree, ".."), { recursive: true });
		if (!fresh && (await backendGit(cache, "show-ref", "-q", `refs/heads/${branch}`)).code === 0) {
			await backendGitOk(cache, "worktree", "add", "-q", tree, branch);
			return "attached";
		}
		await backendGitOk(cache, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
		await backendGitOk(cache, "worktree", "add", "-q", "--no-track", "-B", branch, tree, `refs/remotes/origin/${base}`);
		return "new";
	});
}

/** Commits on the ticket's branch that origin/<base> does not have (0 when nothing changed). */
export async function commitsAhead(tree: string, base: string): Promise<number> {
	return Number(await backendGitOk(tree, "rev-list", "--count", `refs/remotes/origin/${base}..HEAD`));
}

// shortcut: a backend repo's own pre-push hook does not run (REPO's runs in the sandbox, and this host
// lacks the backend toolchain). Run it in the sandbox like REPO's once a backend repo has one.
export async function pushBackend(tree: string, branch: string): Promise<void> {
	await repoLocked(() => backendGitOk(tree, "push", "-q", "-u", "--no-verify", "origin", `HEAD:refs/heads/${branch}`));
}

/** Changes in the worktree that are not committed: the factory pushes commits only. */
export async function uncommitted(tree: string): Promise<boolean> {
	return (await backendGitOk(tree, "status", "--porcelain")) !== "";
}

/** The repo names on plan.md's `Repos:` line ("Repos: chip1-webui (form), api (new field)"). */
export function plannedRepos(plan: string): string[] {
	const line = (/^\s*Repos:\s*(.*)$/im.exec(plan)?.[1] ?? "").replace(/\([^)]*\)/g, "");
	return line.split(",").map((part) => part.trim().split(/[\s(]/)[0]!).filter(Boolean);
}

export async function removeBackendTree(cache: string, tree: string): Promise<void> {
	await repoLocked(async () => {
		await backendGit(cache, "worktree", "remove", "--force", tree);
		await rm(tree, { recursive: true, force: true });
		await backendGit(cache, "worktree", "prune");
	});
}

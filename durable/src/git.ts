// Git for the pipeline: one worktree and branch per ticket, the ticket guard hook, and the repo lock.
// The orchestrator's own git commands run here, outside any agent, without the guard.
import { execFile } from "node:child_process";
import { chmod, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Run = { code: number; stdout: string; stderr: string };

/** Run a program without a shell. Never rejects: the caller reads `code`. */
export function run(file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): Promise<Run> {
	return new Promise((resolve) => {
		const child = execFile(
			file,
			args,
			{ cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
				resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code !== 0 ? error.message : "")) });
			},
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

export async function git(cwd: string, ...args: string[]): Promise<Run> {
	return run("git", ["-C", cwd, ...args]);
}

/** git that must succeed: throws with git's message. */
export async function gitOk(cwd: string, ...args: string[]): Promise<string> {
	const r = await git(cwd, ...args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
	return r.stdout.trim();
}

/**
 * Commands that change the shared .git (fetch, worktree add and remove, branch delete, push, gc)
 * run one at a time: git's own ref locks fail instead of waiting. One process owns the factory, so
 * an in-process queue is the whole lock.
 */
let repoQueue: Promise<unknown> = Promise.resolve();
export function repoLocked<T>(work: () => Promise<T>): Promise<T> {
	const next = repoQueue.then(work, work);
	repoQueue = next.catch(() => undefined);
	return next;
}

/** `{type}/{ticket}/{short-desc}`: type from BRANCH_TYPE or the title's first word. */
export function branchName(cid: string, title: string, branchType = ""): string {
	const first = title.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	const guessed = /^(fix|bug)/.test(first) ? "fix" : first.startsWith("chore") ? "chore" : first.startsWith("doc") ? "docs" : first.startsWith("refactor") ? "refactor" : "feature";
	let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length > 40) {
		slug = slug.slice(0, 41);
		const cut = slug.lastIndexOf("-");
		slug = cut > 0 ? slug.slice(0, cut) : slug.slice(0, 40);
	}
	return `${branchType || guessed}/${cid}${slug ? `/${slug}` : ""}`;
}

/** Folders where `branch` is checked out, other than `worktree` (and that still exist). */
export async function branchElsewhere(repo: string, branch: string, worktree: string): Promise<string | null> {
	const out = await gitOk(repo, "worktree", "list", "--porcelain");
	let here: string | null = null;
	try {
		here = await realpath(worktree);
	} catch {
		here = null;
	}
	for (const block of out.split(/\n\n+/)) {
		const lines = block.split("\n");
		const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
		if (path === undefined || !lines.includes(`branch refs/heads/${branch}`) || lines.some((l) => l.startsWith("prunable"))) continue;
		let real = path;
		try {
			real = await realpath(path);
		} catch {
			continue;
		}
		if (real !== here) return path;
	}
	return null;
}

const exists = async (path: string) => stat(path).then(() => true, () => false);

/**
 * The ticket's worktree: kept when it is already on the branch (a resumed run keeps its unpushed
 * commits), checked out again when the branch exists, else cut fresh from origin/BASE.
 */
export async function prepareWorktree(repo: string, base: string, branch: string, worktree: string, fresh: boolean): Promise<"kept" | "attached" | "new"> {
	const other = await branchElsewhere(repo, branch, worktree);
	if (other !== null) throw new Error(`branch ${branch} is checked out in ${other}: remove that worktree first`);
	if (!fresh && (await exists(worktree)) && (await git(worktree, "branch", "--show-current")).stdout.trim() === branch) return "kept";
	return repoLocked(async () => {
		if (!fresh && (await git(repo, "show-ref", "-q", `refs/heads/${branch}`)).code === 0) {
			await git(repo, "worktree", "prune");
			await rm(worktree, { recursive: true, force: true });
			await gitOk(repo, "worktree", "add", "-q", worktree, branch);
			return "attached";
		}
		let fetched: Run = { code: 1, stdout: "", stderr: "" };
		for (let i = 0; i < 3 && fetched.code !== 0; i++) {
			fetched = await git(repo, "fetch", "-q", "origin", base);
			if (fetched.code !== 0) await new Promise((r) => setTimeout(r, 2000));
		}
		if (fetched.code !== 0) throw new Error(`git fetch origin ${base}: ${fetched.stderr.trim()}`);
		await git(repo, "worktree", "remove", "--force", worktree);
		await rm(worktree, { recursive: true, force: true });
		await git(repo, "worktree", "prune");
		await mkdir(join(worktree, ".."), { recursive: true });
		// Fully qualified: a local branch that happens to be named origin/<base> must not make it ambiguous.
		await gitOk(repo, "worktree", "add", "-q", "--no-track", "-B", branch, worktree, `refs/remotes/origin/${base}`);
		return "new";
	});
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
	await repoLocked(async () => {
		await git(repo, "worktree", "remove", "--force", worktree);
		await rm(worktree, { recursive: true, force: true });
		await git(repo, "worktree", "prune");
	});
}

export async function push(worktree: string, branch: string): Promise<void> {
	await repoLocked(() => gitOk(worktree, "push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`));
}

export const head = (worktree: string) => gitOk(worktree, "rev-parse", "HEAD");
export const currentBranch = async (worktree: string) => (await git(worktree, "branch", "--show-current")).stdout.trim();

const HOOKS = [
	"applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
	"commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-auto-gc", "post-rewrite",
	"push-to-checkout", "post-index-change", "sendemail-validate",
];
const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * RUN/git-hooks, the ticket guard: reference-transaction refuses any ref change
 * except the ticket's own branch. Every other hook, and the guard once it allows a change, runs the
 * repo's own hook, so husky and similar keep working.
 */
export async function writeGuardHooks(repo: string, runDir: string, cid: string, branch: string): Promise<string> {
	const dir = join(runDir, "git-hooks");
	const common = await realpath(await gitOk(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "forward"),
		`#!/bin/sh
# Run the repo's own hook <name>: core.hooksPath without the factory's override, else .git/hooks.
name=$1; shift
dir=$(GIT_CONFIG_COUNT=0 git config core.hooksPath)
[ -n "$dir" ] || dir="$(git rev-parse --git-common-dir)/hooks"
case $dir in /*) ;; *) dir="$(git rev-parse --show-toplevel)/$dir" ;; esac
[ -x "$dir/$name" ] || exit 0
exec "$dir/$name" "$@"
`,
	);
	for (const hook of HOOKS) await writeFile(join(dir, hook), `#!/bin/sh\nexec "$(dirname "$0")/forward" ${hook} "$@"\n`);
	await writeFile(
		join(dir, "reference-transaction"),
		`#!/bin/sh
# Ticket guard (written by the factory): an agent of ${cid.replace(/[^\w.-]/g, "_")} may change only its own branch.
BR=${sq(branch)}
COMMON=${sq(common)}
LOG=${sq(join(runDir, "guard.log"))}
in=$(cat)
# another repository (an agent cloned something): not ours to guard
here=$(cd "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
if [ "$1" = prepared ] && [ "$here" = "$COMMON" ]; then
  bad=
  while read -r old new ref; do
    [ -n "$ref" ] || continue
    case $ref in
      "refs/heads/$BR"|refs/remotes/*|refs/rewritten/*|refs/worktree/*|refs/bisect/*) ;;
      refs/*|worktrees/*|main-worktree/*) bad="$bad $ref" ;;
      *) ;;   # HEAD, ORIG_HEAD and other pseudo refs of this worktree
    esac
  done <<EOT
$in
EOT
  if [ -n "$bad" ]; then
    echo "software-factory: refused to change$bad. This agent works only on branch $BR: other tickets' branches, the base branch, tags and git stash are off limits (the stash is shared by every worktree). Commit on $BR instead." >&2
    echo "$(date '+%F %T')$bad" >>"$LOG"
    exit 1
  fi
fi
printf '%s' "$in\${in:+
}" | "$(dirname "$0")/forward" reference-transaction "$@"
`,
	);
	for (const hook of [...HOOKS, "forward", "reference-transaction"]) await chmod(join(dir, hook), 0o755);
	return dir;
}

export type GitIdentity = { name: string; email: string };

/** Who agents commit as: the repo's git user, else the factory. */
export async function gitIdentity(repo: string): Promise<GitIdentity> {
	const name = (await git(repo, "config", "user.name")).stdout.trim();
	const email = (await git(repo, "config", "user.email")).stdout.trim();
	return { name: name || "software-factory", email: email || "factory@localhost" };
}

/** The variables every agent command of a ticket gets: guard hook, no auto gc, its own ports. */
export function cellEnv(options: { cid: string; slot: number; hooksDir: string; portStart: number; portSpan: number; identity: GitIdentity }): Record<string, string> {
	const port = options.portStart + options.slot * options.portSpan;
	return {
		// Agents commit as the repo's user (a sandbox container has no git config of its own).
		GIT_AUTHOR_NAME: options.identity.name,
		GIT_AUTHOR_EMAIL: options.identity.email,
		GIT_COMMITTER_NAME: options.identity.name,
		GIT_COMMITTER_EMAIL: options.identity.email,
		FACTORY_TICKET: options.cid,
		FACTORY_SLOT: String(options.slot),
		PORT_BASE: String(port),
		PORT: String(port),
		COMPOSE_PROJECT_NAME: `factory-${options.cid.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
		GIT_CONFIG_COUNT: "4",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: options.hooksDir,
		GIT_CONFIG_KEY_1: "gc.auto",
		GIT_CONFIG_VALUE_1: "0",
		GIT_CONFIG_KEY_2: "maintenance.auto",
		GIT_CONFIG_VALUE_2: "false",
		GIT_CONFIG_KEY_3: "safe.directory",
		GIT_CONFIG_VALUE_3: "*",
	};
}

/** The spec tests: files the test writer added or changed, frozen by content hash. */
export async function freezeTests(worktree: string, base: string): Promise<Record<string, string>> {
	const files = (await gitOk(worktree, "diff", "--name-only", "--diff-filter=d", `refs/remotes/origin/${base}...HEAD`)).split("\n").filter(Boolean);
	const frozen: Record<string, string> = {};
	for (const file of files) frozen[file] = await gitOk(worktree, "hash-object", file);
	return frozen;
}

/** Frozen tests that were deleted, or changed without being named in test-changes.md. */
export async function testsKept(worktree: string, frozen: Record<string, string>, testChanges: string): Promise<{ gone: string[]; changed: string[] }> {
	const gone: string[] = [];
	const changed: string[] = [];
	for (const [file, hash] of Object.entries(frozen)) {
		if (!(await exists(join(worktree, file)))) {
			gone.push(file);
			continue;
		}
		if ((await gitOk(worktree, "hash-object", file)) !== hash && !testChanges.includes(file)) changed.push(file);
	}
	return { gone, changed };
}

// What the index reads. Two modes, like Cursor's client reading its workspace:
//  - worktree: the checkout at DATA_DIR/repo itself (the default),
//  - ref: a git ref (INDEX_REF, e.g. origin/main) read through a hidden snapshot worktree under
//    the index folder. That keeps the index on the branch tickets are cut from even though the
//    checkout never moves; the snapshot advances with `git checkout --detach`, which touches only
//    the files that changed.
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { git, repoLocked } from "../git.ts";
import type { IndexOptions } from "./options.ts";

export type Source = {
	readonly mode: "worktree" | "ref";
	/** The ref that was indexed ("" for the working tree). */
	readonly ref: string;
	/** The commit the tree was read at, when git knows it. */
	readonly commit: string | null;
	readonly branch: string | null;
	/** The directory to walk: the checkout or the snapshot. */
	readonly readRoot: string;
};

const gitText = async (cwd: string, ...args: string[]): Promise<string | null> => {
	const result = await git(cwd, ...args);
	return result.code === 0 ? result.stdout.trim() : null;
};

const exists = (path: string) => stat(path).then(() => true, () => false);

export async function resolveSource(repo: string, snapshotDir: string, options: IndexOptions, log: (line: string) => void): Promise<Source> {
	if (options.ref === "") {
		return {
			mode: "worktree",
			ref: "",
			commit: await gitText(repo, "rev-parse", "HEAD"),
			branch: await gitText(repo, "rev-parse", "--abbrev-ref", "HEAD"),
			readRoot: repo,
		};
	}
	if ((await gitText(repo, "rev-parse", "--is-inside-work-tree")) !== "true") throw new Error(`INDEX_REF=${options.ref}, but ${repo} is not a git repository`);
	if (options.fetch) {
		await repoLocked(async () => {
			const branch = options.ref.startsWith("origin/") ? options.ref.slice(7) : options.ref;
			const fetched = await git(repo, "fetch", "-q", "origin", ...(options.ref.startsWith("origin/") ? [branch] : []));
			if (fetched.code !== 0) throw new Error(`git fetch origin ${branch}: ${(fetched.stderr || fetched.stdout).trim().slice(0, 500)}`);
		});
	}
	const commit = await gitText(repo, "rev-parse", "--verify", `${options.ref}^{commit}`);
	if (commit === null) throw new Error(`INDEX_REF=${options.ref} does not resolve in ${repo}`);
	await repoLocked(async () => {
		if (await exists(`${snapshotDir}/.git`)) {
			if ((await gitText(snapshotDir, "rev-parse", "HEAD")) !== commit) {
				const checked = await git(snapshotDir, "checkout", "-q", "--detach", commit);
				if (checked.code !== 0) throw new Error(`index snapshot checkout ${options.ref}: ${(checked.stderr || checked.stdout).trim().slice(0, 500)}`);
			}
			return;
		}
		await mkdir(dirname(snapshotDir), { recursive: true });
		const added = await git(repo, "worktree", "add", "--detach", "-q", snapshotDir, commit);
		if (added.code !== 0) throw new Error(`index snapshot worktree: ${(added.stderr || added.stdout).trim().slice(0, 500)}`);
		log(`index: snapshot worktree for ${options.ref} at ${commit.slice(0, 7)}`);
	});
	return { mode: "ref", ref: options.ref, commit, branch: null, readRoot: snapshotDir };
}

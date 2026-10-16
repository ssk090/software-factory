// Push only what the ticket needs: before a push, the files the branch adds or changes are checked
// for ones no ticket needs (build output, caches, logs, editor and OS files, merge leftovers, a
// lockfile changed without a package manifest). Those stop the push and go to the coordinator. A
// file the plan does not name is only reported: a plan cannot name every helper.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";

export type Unneeded = { path: string; why: string };

const JUNK: [RegExp, string][] = [
	[/(?:^|\/)node_modules\//, "installed dependencies"],
	[/(?:^|\/)(?:dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|storybook-static)\//, "build output"],
	[/(?:^|\/)(?:\.turbo|\.cache|\.parcel-cache|\.vite|\.eslintcache|\.nx|\.pnpm-store)(?:\/|$)/, "a tool's cache"],
	[/(?:^|\/)coverage\/|(?:^|\/)\.nyc_output\/|(?:^|\/)junit\.xml$|(?:^|\/)test-results\/|(?:^|\/)playwright-report\//, "test or coverage output"],
	[/\.tsbuildinfo$/, "TypeScript build info"],
	[/(?:^|\/)(?:__pycache__\/|.*\.py[co]$)/, "Python byte code"],
	[/\.(?:log|orig|rej|swp|swo|bak|tmp)$|~$/, "a log, backup or merge leftover"],
	[/(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/, "an OS file"],
	[/(?:^|\/)(?:\.idea|\.vscode)\//, "editor settings"],
	[/(?:^|\/)(?:repair|failure|blocked|tests|fix-notes|test-changes|spec|plan|review-\d+)\.md$/, "a factory run-folder file (it belongs in RUN_DIR, not the repo)"],
];
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/;
const MANIFEST = /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml)$/;

/** Files kept on purpose: RUN_DIR/scope-keep.txt, one path per line (anything after the path is the reason). */
export async function keptOnPurpose(runDir: string): Promise<Set<string>> {
	const text = await readFile(join(runDir, "scope-keep.txt"), "utf8").catch(() => "");
	return new Set(text.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((p) => p !== "" && !p.startsWith("#")));
}

/** What the branch would push that no ticket needs. */
export async function unneededFiles(worktree: string, since: string, keep: Set<string>): Promise<Unneeded[]> {
	const changed = (await git(worktree, "diff", "--name-only", "--diff-filter=ACMR", `${since}...HEAD`)).stdout.split("\n").filter(Boolean);
	// A file existing on the base already (a tracked .vscode/settings.json, say) is the repo's choice.
	const out: Unneeded[] = [];
	const manifestChanged = changed.some((p) => MANIFEST.test(p));
	for (const path of changed) {
		if (keep.has(path)) continue;
		const junk = JUNK.find(([re]) => re.test(path));
		if (junk) {
			const onBase = (await git(worktree, "cat-file", "-e", `${since}:${path}`)).code === 0;
			if (!onBase) out.push({ path, why: junk[1] });
			continue;
		}
		if (LOCKFILE.test(path) && !manifestChanged) out.push({ path, why: "a lockfile changed, but no package.json did: an install changed it, not the ticket" });
	}
	return out;
}

/** Files the branch changes that the plan, the tests list and test-changes.md never name (a report, not a stop). */
export async function notInPlan(worktree: string, since: string, runDir: string): Promise<string[]> {
	const named = (await Promise.all(["plan.md", "tests.md", "test-changes.md", "spec.md"].map((f) => readFile(join(runDir, f), "utf8").catch(() => "")))).join("\n");
	if (named.trim() === "") return [];
	const changed = (await git(worktree, "diff", "--name-only", "--diff-filter=ACMR", `${since}...HEAD`)).stdout.split("\n").filter(Boolean);
	return changed.filter((p) => !named.includes(p) && !named.includes(p.split("/").pop()!));
}

export const formatUnneeded = (files: Unneeded[]) => files.map((f) => `- ${f.path}: ${f.why}`).join("\n");

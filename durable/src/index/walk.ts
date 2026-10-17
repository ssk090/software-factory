// Which files the index covers. The cascade mirrors what the factory already trusts:
//  - git's own ignore rules decide (`.gitignore`, `.git/info/exclude`, nested files); when git cannot
//    answer, files are treated as not ignored (the same fallback Cursor's client logs),
//  - dependency and build directories are skipped by name,
//  - binary files and files over the cap are skipped (Cursor's client skips uploads over 10 MiB),
//  - the secret paths the agents may never read are skipped too (roles.ts SECRET_PATHS): the index
//    is readable by every agent, so it must not become a way around that rule.
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { run } from "../git.ts";
import { sha256 } from "./merkle.ts";

export type WalkFile = { path: string; size: number; mtime: number };
export type WalkOptions = { exclude?: readonly string[]; maxFileBytes?: number; log?: (line: string) => void };

/** Directories that never carry the codebase's meaning (dependencies, build output, caches). */
export const DEFAULT_SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "out", "vendor", "target", "coverage",
	".next", ".nuxt", ".output", ".turbo", ".cache", ".venv", "venv", "__pycache__",
	".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".terraform",
]);

/** Extensions that are binary by nature: never read, never embedded. */
export const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff",
	".pdf", ".zip", ".gz", ".tgz", ".tar", ".br", ".bz2", ".xz", ".7z", ".rar",
	".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".class", ".jar", ".war", ".wasm",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg", ".flac",
	".sqlite", ".sqlite3", ".db", ".pyc", ".pyo",
]);

/** Files that hold secrets: the index is agent-readable, so these never enter it. */
const SECRET_PATH = new RegExp(
	"(?:^|/)(?:" +
		"config\\.env|\\.netrc|\\.git-credentials|dash\\.token|factory\\.sqlite(?:-[a-z]+)?|credentials\\.json|" +
		"\\.ssh/|\\.aws/credentials|\\.docker/config\\.json|\\.config/gh/hosts\\.yml|" +
		"\\.env(?!\\.(?:example|sample|template|dist))" +
		")",
);

export const isSecretPath = (path: string): boolean => SECRET_PATH.test(path);

/** The relative path in the index: forward slashes on every platform. */
const posix = (path: string): string => path.split(sep).join("/");

async function isGitRepo(root: string): Promise<boolean> {
	return (await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

/** The paths git ignores, or null when git cannot answer (then nothing is ignored). */
async function gitIgnored(root: string, paths: readonly string[], log?: (line: string) => void): Promise<Set<string> | null> {
	if (!(await isGitRepo(root))) return null;
	const ignored = new Set<string>();
	for (let i = 0; i < paths.length; i += 500) {
		const batch = paths.slice(i, i + 500);
		// With -z the input and the output are NUL-separated (a newline-separated input would be
		// read as one pathname).
		const result = await run("git", ["-C", root, "check-ignore", "--stdin", "-z"], { cwd: root, input: `${batch.join("\0")}\0` });
		// Exit 1 means "nothing ignored in this batch"; anything else: git could not answer.
		if (result.code !== 0 && result.code !== 1) {
			log?.("index: git check-ignore failed, treating files as not ignored");
			return null;
		}
		for (const path of result.stdout.split("\0")) if (path !== "") ignored.add(path.replace(/\\/g, "/"));
	}
	return ignored;
}

/** Every file of `root` the index covers, sorted by path (walk order is never relied on). */
export async function walk(root: string, options: WalkOptions = {}): Promise<WalkFile[]> {
	const max = options.maxFileBytes ?? 10_485_760;
	const exclude = new Set(options.exclude ?? []);
	const found: { path: string; size: number; mtime: number }[] = [];
	const visit = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue; // never follow: loops and out-of-tree reads
			if (entry.isDirectory()) {
				if (DEFAULT_SKIP_DIRS.has(entry.name) || exclude.has(entry.name)) continue;
				await visit(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (exclude.has(entry.name)) continue;
			if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
			const rel = posix(path.slice(root.length + 1));
			if (isSecretPath(rel)) continue;
			const info = await stat(path).catch(() => null);
			if (info === null || !info.isFile() || info.size > max) continue;
			found.push({ path: rel, size: info.size, mtime: Math.floor(info.mtimeMs) });
		}
	};
	await visit(root);
	found.sort((a, b) => (a.path < b.path ? -1 : 1));
	const ignored = await gitIgnored(root, found.map((f) => f.path), options.log);
	return ignored === null ? found : found.filter((f) => !ignored.has(f.path));
}

export type IndexedFile = { hash: string; text: string; size: number };

/** A file's content for indexing (hash over the raw bytes), or null when binary or unreadable. */
export async function readIndexedFile(path: string, maxFileBytes: number): Promise<IndexedFile | null> {
	const buffer = await readFile(path).catch(() => null);
	if (buffer === null || buffer.byteLength > maxFileBytes) return null;
	// The cheap binary test every index uses: a NUL byte in the first 8 KiB.
	for (let i = 0; i < Math.min(buffer.byteLength, 8192); i++) if (buffer[i] === 0) return null;
	return { hash: sha256(buffer), text: buffer.toString("utf8"), size: buffer.byteLength };
}

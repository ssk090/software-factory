// The code map: Cursor's service answers `getHighLevelFolderDescription` with an LLM-written
// summary of the important paths; the map here is deterministic instead (no model call), so it
// costs nothing, never hallucinates, and can be regenerated on every change. It gives the agents
// the one thing a fresh agent usually lacks: the shape of a repo it has never seen (issue #4's
// ARCHITECTURE.md idea, generated rather than hand-written).
import { extname } from "node:path";
import type { ManifestFile, Meta } from "./store.ts";

const ENTRY = /(^|\/)(readme(\.[a-z]+)?|package\.json|pyproject\.toml|setup\.py|go\.mod|go\.sum|cargo\.toml|makefile|dockerfile|docker-compose\.ya?ml|gemfile|composer\.json|build\.gradle|pom\.xml|cmakelists\.txt)$/i;
const depthOf = (path: string): number => path.split("/").length;

export function buildDescription(files: Record<string, ManifestFile>, meta: Meta): string {
	const paths = Object.keys(files).sort();
	const chunks = paths.reduce((sum, path) => sum + files[path]!.c, 0);
	const where = meta.source.mode === "ref" ? `${meta.source.ref}${meta.source.commit ? ` @ ${meta.source.commit.slice(0, 7)}` : ""}` : meta.source.branch ?? "the working tree";
	const top = new Map<string, { files: number; bytes: number; ext: Map<string, number> }>();
	for (const path of paths) {
		const at = path.indexOf("/");
		const key = at < 0 ? "." : path.slice(0, at);
		let entry = top.get(key);
		if (entry === undefined) top.set(key, (entry = { files: 0, bytes: 0, ext: new Map() }));
		entry.files++;
		entry.bytes += files[path]!.s;
		const ext = extname(path).toLowerCase() || "(none)";
		entry.ext.set(ext, (entry.ext.get(ext) ?? 0) + 1);
	}
	const topLines = [...top.entries()]
		.sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : 1))
		.map(([name, entry]) => {
			const exts = [...entry.ext.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([ext]) => ext.replace(/^\./, ""));
			const shown = name === "." ? "(root files)" : `${name}/`;
			return `- ${shown.padEnd(28)} ${String(entry.files).padStart(5)} files  ${exts.join(", ")}`;
		});
	const entries = paths.filter((path) => ENTRY.test(path) && depthOf(path) <= 3).slice(0, 12);
	const indexed = paths
		.slice()
		.sort((a, b) => files[b]!.c - files[a]!.c || (a < b ? -1 : 1))
		.filter((path) => files[path]!.c > 0)
		.slice(0, 30);
	const lines = [
		`# ${meta.repoId} — code map (generated ${new Date().toISOString()})`,
		"",
		`${paths.length} files, ${chunks} chunks, indexed from ${where}.`,
		"Use this map to orient yourself; use the code index to search by meaning: ff index search \"...\".",
		"",
		"## Top level",
		...topLines,
		"",
		"## Entry points",
		...entries.map((path) => `- ${path}`),
		"",
		"## Most indexed files (by chunk count)",
		...indexed.map((path) => `- ${path} (${files[path]!.c} chunks, ${files[path]!.s} bytes)`),
		"",
	];
	return lines.join("\n");
}

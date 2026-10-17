// What the index buys an agent, measured: answer each query through the index (one search, a
// handful of snippets), then the way an agent without it works (read the whole tree, look for the
// query's words). The numbers are honest about both sides: timings, bytes read, and an estimated
// token count (bytes / 4) — the currency the prompt budget is spent in.
import { join } from "node:path";
import type { IndexOptions } from "./options.ts";
import { searchIndex } from "./search.ts";
import { readIndexedFile, walk } from "./walk.ts";

export type BenchLine = {
	query: string;
	searchMs: number;
	hits: number;
	searchBytes: number;
	scanMs: number;
	scanFiles: number;
	scanBytes: number;
	scanMatches: number;
};
export type BenchResult = { lines: BenchLine[]; report: string };

const estTokens = (bytes: number): number => Math.round(bytes / 4);
const human = (bytes: number): string =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const n = (value: number): string => value.toLocaleString("en-US");

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
	const at = Date.now();
	const value = await work();
	return { ms: Date.now() - at, value };
}

export async function benchIndex(
	options: IndexOptions,
	root: string,
	queries: readonly string[],
	log: (line: string) => void = () => undefined,
): Promise<BenchResult> {
	const lines: BenchLine[] = [];
	for (const query of queries) {
		const search = await timed(() => searchIndex(options, root, query, { k: 10 }));
		const searchBytes = search.value.hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.snippet), 0);
		// The scan an agent without the index would run: every indexable file, read and searched.
		const scan = await timed(async () => {
			const files = await walk(root, { exclude: options.exclude, maxFileBytes: options.maxFileBytes, log });
			const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
			let bytes = 0;
			let matches = 0;
			for (const file of files) {
				const read = await readIndexedFile(join(root, ...file.path.split("/")), options.maxFileBytes);
				if (read === null) continue;
				bytes += read.size;
				const lower = read.text.toLowerCase();
				if (words.length > 0 && words.every((word) => lower.includes(word))) matches++;
			}
			return { files: files.length, bytes, matches };
		});
		lines.push({ query, searchMs: search.ms, hits: search.value.hits.length, searchBytes, scanMs: scan.ms, scanFiles: scan.value.files, scanBytes: scan.value.bytes, scanMatches: scan.value.matches });
	}
	const searchBytes = lines.reduce((sum, line) => sum + line.searchBytes, 0);
	const scanBytes = lines.reduce((sum, line) => sum + line.scanBytes, 0);
	const pad = Math.max(...lines.map((line) => line.query.length), 10);
	const report = [
		`${"query".padEnd(pad)}   index                     full scan`,
		...lines.map((line) =>
			`${line.query.padEnd(pad)}   ${String(line.searchMs).padStart(6)} ms, ${String(line.hits).padStart(2)} hits   ` +
			`${String(line.scanMs).padStart(6)} ms, ${n(line.scanFiles)} files read, ${n(line.scanMatches)} matching`),
		"",
		`the index read ${human(searchBytes)} (~${n(estTokens(searchBytes))} est. tokens); the full scan read ${human(scanBytes)} (~${n(estTokens(scanBytes))} est. tokens)`,
	].join("\n");
	return { lines, report };
}

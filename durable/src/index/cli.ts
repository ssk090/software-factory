// `ff index`: the codebase index from the command line — build it, look at its state, search it,
// print the generated code map, measure what it saves (bench), or remove it. Agents inside a
// ticket's sandbox use the same commands: `ff index search "<query>"` answers with paths and line
// numbers, which is how a step gets context about a codebase it has never walked.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config } from "../config.ts";
import { benchIndex } from "./bench.ts";
import { loadIndexOptions } from "./options.ts";
import { searchIndex } from "./search.ts";
import { checkIndex, indexDirOf, indexStoreFor, repoIdOf, updateIndex } from "./sync.ts";

const HELP = `usage: ff index <command>
  build [--full] [--json]    build or refresh the index of REPO (INDEX_REF: of that ref)
  update                     same as build: one walk, and only changed files are embedded
  status [--json]            what the index holds, and whether it still matches the code
  search <query> [--k N] [--path P] [--json]
                             search by meaning and keyword: path:line hits, ready to read
  map                        the generated code map (top level, entry points, biggest files)
  bench [query]              index search versus reading the whole tree: timings and bytes
  clean                      remove the index (of INDEX_SCOPE, when set) from the data folder
  help                       this text
Flags: --root DIR (default REPO), --json for machine output.
Settings (all optional; see config.example.env): INDEX_DIR, INDEX_REF, INDEX_SCOPE, INDEX_FETCH,
INDEX_EMBED, INDEX_EMBED_URL, INDEX_EMBED_MODEL, INDEX_EMBED_KEY, INDEX_EMBED_DIMS,
INDEX_EMBED_BATCH, INDEX_EMBED_TIMEOUT, INDEX_EXCLUDE, INDEX_MAX_FILE_BYTES, INDEX_CHUNK_LINES,
INDEX_CHUNK_OVERLAP, INDEX_MIN_INTERVAL.`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const when = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export async function indexCommand(config: Config, args: string[]): Promise<void> {
	const command = args[0] ?? "help";
	const rest = args.slice(1);
	const json = rest.includes("--json");
	const value = (name: string): string | null => {
		const at = rest.indexOf(name);
		return at >= 0 ? rest[at + 1] ?? null : null;
	};
	const root = resolve(value("--root") ?? config.repo);
	const options = loadIndexOptions(process.env, config.indexDir);
	/** The query words: every flag and its value taken out. */
	const query = (): string => {
		const skip = new Set<string>();
		for (const name of ["--k", "--path", "--root"]) {
			const at = rest.indexOf(name);
			if (at < 0) continue;
			skip.add(name);
			if (rest[at + 1] !== undefined) skip.add(rest[at + 1]!);
		}
		return rest.filter((arg) => !skip.has(arg) && !arg.startsWith("--")).join(" ");
	};

	switch (command) {
		case "build":
		case "update": {
			const result = await updateIndex(options, root, (line) => console.log(line), {
				full: rest.includes("--full"),
				...(options.scope !== "" ? { seedRoot: config.repo } : {}),
			}).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
			if (json) console.log(JSON.stringify(result, null, 2));
			else console.log(`${result.status}: ${result.dir} — ${result.files} files, ${result.chunks} chunks, ${result.changed} changed (${result.embedded} embedded, ${result.removed} dropped) from ${result.source || "nothing"} in ${result.ms} ms${result.message ? ` (${result.message})` : ""}`);
			if (result.status === "locked" || result.status === "skipped") process.exitCode = 1;
			return;
		}
		case "status": {
			const repoId = await repoIdOf(root);
			const { store, fellBack } = await indexStoreFor(options, repoId);
			const meta = await store.readMeta();
			const check = meta === null ? null : await checkIndex(options, root);
			if (json) return void console.log(JSON.stringify({ repoId, dir: store.dir, fellBack, meta, check }, null, 2));
			if (meta === null) {
				console.log(`no index at ${store.dir} (ff index build)`);
				return;
			}
			const where = meta.source.mode === "ref" ? `${meta.source.ref}${meta.source.commit ? ` @ ${meta.source.commit.slice(0, 7)}` : ""}` : meta.source.branch ?? "worktree";
			console.log(`index ${store.dir}${fellBack ? " (fell back from INDEX_SCOPE: the ticket's own index is not built)" : ""}`);
			console.log(`  source   ${where}${meta.source.mode === "worktree" && meta.source.commit ? ` @ ${meta.source.commit.slice(0, 7)}` : ""}`);
			console.log(`  ${meta.files} files, ${meta.chunks} chunks, ${meta.dims} dimensions, embedder ${meta.embedder}`);
			console.log(`  built ${when(meta.builtAt)}, updated ${when(meta.updatedAt)}, chunker ${meta.chunk}`);
			console.log(`  check    ${check!.status}: ${check!.message}`);
			return;
		}
		case "search": {
			const text = query();
			if (text.trim() === "") fail("usage: ff index search <query> [--k N] [--path P] [--json]");
			const k = Math.max(1, Number(value("--k") ?? 10) || 10);
			const result = await searchIndex(options, root, text, { k, path: value("--path") ?? "" });
			if (json) console.log(JSON.stringify(result, null, 2));
			else if (result.hits.length === 0) console.log(`no hits${result.meta.note ? ` — ${result.meta.note}` : ""}`);
			else {
				for (const [i, hit] of result.hits.entries()) {
					const ranks = [hit.bm25Rank !== null ? `keyword #${hit.bm25Rank + 1}` : null, hit.vectorRank !== null ? `vector #${hit.vectorRank + 1}` : null].filter((rank) => rank !== null).join(", ");
					console.log(`${String(i + 1).padStart(2)}. ${hit.path}:${hit.startLine}-${hit.endLine}  ${ranks}`);
					console.log(`    ${hit.snippet.replace(/\s+/g, " ").trim().slice(0, 220)}`);
				}
				console.log(`${result.hits.length} hit(s) in ${result.meta.totalMs} ms (keyword ${result.meta.keywordMs} ms, vector ${result.meta.vector ? `${result.meta.embedMs} ms + knn ${result.meta.knnMs} ms` : "off"})${result.meta.note ? ` — ${result.meta.note}` : ""}`);
			}
			return;
		}
		case "map": {
			const repoId = await repoIdOf(root);
			const { store } = await indexStoreFor(options, repoId);
			const text = await store.description();
			if (text === null) fail(`no index at ${store.dir} (ff index build)`);
			console.log(json ? JSON.stringify({ dir: store.dir, map: text }, null, 2) : text.trimEnd());
			return;
		}
		case "bench": {
			const queries = query().trim() === "" ? ["where is the main entry point"] : [query()];
			const { report } = await benchIndex(options, root, queries, (line) => console.log(line));
			console.log(report);
			return;
		}
		case "clean": {
			const dir = indexDirOf(options, await repoIdOf(root));
			await rm(dir, { recursive: true, force: true });
			console.log(`removed ${dir}`);
			return;
		}
		case "help":
			console.log(HELP);
			return;
		default:
			console.log(HELP);
			process.exitCode = 1;
	}
}

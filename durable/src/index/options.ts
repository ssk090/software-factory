// The codebase index's settings, from the environment (all optional). The factory's settings file
// documents them (config.example.env); nothing here is required for the index to work: the
// defaults are offline and dependency-free.
import { resolve } from "node:path";

export type EmbedKind = "hash" | "http";

export type IndexOptions = {
	/** Where all indexes live: state/index (the data folder, mounted into every sandbox). */
	readonly dir: string;
	/** INDEX_SCOPE: the suffix of a ticket's own index (state/index/<repoId>-<scope>), seeded from
	 *  the repo's once and then following the ticket's worktree, so an agent searches the code as
	 *  the run generates it. Empty: the repo's index alone. */
	readonly scope: string;
	/** INDEX_REF: a git ref to index (e.g. origin/main) through a hidden snapshot worktree.
	 *  Empty: the checkout itself (DATA_DIR/repo). */
	readonly ref: string;
	/** INDEX_FETCH=1: fetch the ref's branch into the repo before resolving it (only with INDEX_REF). */
	readonly fetch: boolean;
	readonly embed: {
		/** hash: the built-in, offline feature-hashing embedder. http: any OpenAI-compatible endpoint. */
		readonly kind: EmbedKind;
		readonly url: string;
		readonly model: string;
		readonly key: string;
		/** Feature buckets of the hash embedder (16..4096). */
		readonly dims: number;
		readonly batch: number;
		readonly timeoutMs: number;
	};
	/** Extra directory or file names to skip; git's own ignore rules always apply. */
	readonly exclude: readonly string[];
	/** Files larger than this byte count are skipped (Cursor's client skips uploads over 10 MiB). */
	readonly maxFileBytes: number;
	/** Lines per chunk, and lines shared with the next chunk. */
	readonly chunkLines: number;
	readonly chunkOverlap: number;
	/** Background refresh: the least time between two automatic updates. */
	readonly minIntervalMs: number;
};

const count = (value: string | undefined, fallback: number, min: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && n >= min ? n : fallback;
};

/** A ticket's index suffix: lowercase, safe as a directory name (used in INDEX_SCOPE too). */
export const indexScope = (cid: string): string =>
	cid.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function loadIndexOptions(env: NodeJS.ProcessEnv, dir: string): IndexOptions {
	const keyEnv = (env.INDEX_EMBED_KEY || "OPENAI_API_KEY").trim();
	return {
		dir: resolve(dir),
		scope: indexScope(env.INDEX_SCOPE ?? ""),
		ref: (env.INDEX_REF ?? "").trim(),
		fetch: /^(1|true)$/i.test((env.INDEX_FETCH ?? "").trim()),
		embed: {
			kind: (env.INDEX_EMBED ?? "hash").trim() === "http" ? "http" : "hash",
			url: (env.INDEX_EMBED_URL ?? "").trim().replace(/\/+$/, ""),
			model: (env.INDEX_EMBED_MODEL ?? "text-embedding-3-small").trim(),
			key: env[keyEnv] ?? "",
			dims: count(env.INDEX_EMBED_DIMS, 256, 16),
			batch: count(env.INDEX_EMBED_BATCH, 64, 1),
			timeoutMs: count(env.INDEX_EMBED_TIMEOUT, 60, 1) * 1000,
		},
		exclude: (env.INDEX_EXCLUDE ?? "")
			.split(/[\n,]+/)
			.map((part) => part.trim())
			.filter((part) => part !== ""),
		maxFileBytes: count(env.INDEX_MAX_FILE_BYTES, 10_485_760, 1),
		chunkLines: count(env.INDEX_CHUNK_LINES, 60, 4),
		chunkOverlap: count(env.INDEX_CHUNK_OVERLAP, 10, 0),
		minIntervalMs: count(env.INDEX_MIN_INTERVAL, 120, 1) * 1000,
	};
}

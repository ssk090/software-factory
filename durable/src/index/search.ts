// Search over the index: keyword (BM25) and vector (cosine) run side by side and their rankings
// are fused with Reciprocal Rank Fusion — the local shape of what Cursor's client asks the service
// for (`semSearchFast`: query in, reranked code results out, with per-stage latencies reported).
// A hit carries its path and 1-based line range, so an agent can go straight to the file.
import { createEmbedder, embedderMatches, type Embedder } from "./embed.ts";
import type { IndexOptions } from "./options.ts";
import { IndexStore, type LoadedIndex, type StoredChunk } from "./store.ts";
import { indexStoreFor, repoIdOf } from "./sync.ts";
import { tokenize } from "./text.ts";

export type Hit = {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	bm25Rank: number | null;
	vectorRank: number | null;
};
export type SearchMeta = {
	chunks: number;
	embedder: string;
	vector: boolean;
	keywordMs: number;
	embedMs: number;
	knnMs: number;
	totalMs: number;
	note: string | null;
};
export type SearchResult = { hits: Hit[]; meta: SearchMeta; rootHash: string | null; updatedAt: number | null };

const K1 = 1.2;
const B = 0.75;
const RRF_K = 60;
const CANDIDATES = 50;

type Doc = { terms: Map<string, number>; length: number };
type CacheEntry = { updatedAt: number; index: LoadedIndex; docs: Doc[]; df: Map<string, number>; avg: number };
const cache = new Map<string, CacheEntry>();

export function clearSearchCache(): void {
	cache.clear();
}

function analyse(index: LoadedIndex): CacheEntry {
	const docs: Doc[] = [];
	const df = new Map<string, number>();
	let total = 0;
	for (const chunk of index.chunks) {
		const terms = new Map<string, number>();
		for (const token of tokenize(chunk.t)) terms.set(token, (terms.get(token) ?? 0) + 1);
		for (const token of terms.keys()) df.set(token, (df.get(token) ?? 0) + 1);
		total += chunk.t.length;
		docs.push({ terms, length: chunk.t.length });
	}
	return { updatedAt: index.meta.updatedAt, index, docs, df, avg: docs.length === 0 ? 0 : total / docs.length };
}

async function loaded(store: IndexStore): Promise<CacheEntry | null> {
	const meta = await store.readMeta();
	if (meta === null) return null;
	const hit = cache.get(store.dir);
	if (hit !== undefined && hit.updatedAt === meta.updatedAt) return hit;
	const index = await store.load();
	if (index === null) return null;
	const entry = analyse(index);
	cache.set(store.dir, entry);
	return entry;
}

/** A path filter: a plain prefix, or globs when it carries * or ?. */
export function pathMatcher(filter: string): (path: string) => boolean {
	if (filter === "") return () => true;
	if (!/[*?]/.test(filter)) {
		const prefix = filter.replace(/^\.\//, "").replace(/^\/+/, "");
		return (path) => path === prefix || path.startsWith(`${prefix}/`);
	}
	const escaped = filter.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const body = escaped
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*")
		.replace(/\?/g, "[^/]");
	const re = new RegExp(`(^|/)${body}$`);
	return (path) => re.test(path);
}

function snippet(text: string, tokens: readonly string[]): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const token of tokens) {
		const found = lower.indexOf(token);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	const start = at < 0 ? 0 : Math.max(0, at - 100);
	const end = Math.min(text.length, (at < 0 ? 140 : at + 160));
	let cut = text.slice(start, end);
	if (start > 0) cut = `…${cut}`;
	if (end < text.length) cut = `${cut}…`;
	return cut;
}

function top(scores: Float64Array, chunks: readonly StoredChunk[], take: number): number[] {
	const order: number[] = [];
	for (let i = 0; i < scores.length; i++) if (scores[i]! > 0) order.push(i);
	order.sort((a, b) => scores[b]! - scores[a]! || (chunks[a]!.p < chunks[b]!.p ? -1 : chunks[a]!.p > chunks[b]!.p ? 1 : chunks[a]!.a - chunks[b]!.a));
	return order.slice(0, take);
}

export async function searchIndex(
	options: IndexOptions,
	root: string,
	query: string,
	hints: { k?: number; path?: string; log?: (line: string) => void } = {},
): Promise<SearchResult> {
	const started = Date.now();
	const empty: SearchResult = {
		hits: [],
		meta: { chunks: 0, embedder: "", vector: false, keywordMs: 0, embedMs: 0, knnMs: 0, totalMs: 0, note: null },
		rootHash: null,
		updatedAt: null,
	};
	const repoId = await repoIdOf(root);
	const { store, fellBack } = await indexStoreFor(options, repoId);
	const entry = await loaded(store);
	if (entry === null) return { ...empty, meta: { ...empty.meta, totalMs: Date.now() - started, note: "no index yet: run ff index build" } };
	const fallbackNote = fellBack ? "this ticket's own index is not built yet: results come from the repo index" : null;
	const { index, docs, df, avg } = entry;
	const chunks = index.chunks;
	const matches = pathMatcher(hints.path ?? "");
	const allowed = chunks.map((chunk) => matches(chunk.p));
	const tokens = [...new Set(tokenize(query))];

	// Keyword half.
	const keywordAt = Date.now();
	const bm25 = new Float64Array(chunks.length);
	const N = chunks.length;
	for (const token of tokens) {
		const frequency = df.get(token);
		if (frequency === undefined || frequency === 0) continue;
		const idf = Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5));
		for (let i = 0; i < N; i++) {
			if (!allowed[i]) continue;
			const tf = docs[i]!.terms.get(token);
			if (tf === undefined) continue;
			bm25[i] = bm25[i]! + idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * docs[i]!.length) / (avg || 1))));
		}
	}
	const bm25Top = top(bm25, chunks, CANDIDATES);
	const keywordMs = Date.now() - keywordAt;

	// Vector half, only when the query can be embedded in the index's own space.
	let embedder: Embedder | null = null;
	try {
		embedder = createEmbedder(options);
	} catch {
		// e.g. INDEX_EMBED=http without INDEX_EMBED_URL: the vector half sits out, keyword search runs.
	}
	let vectorTop: number[] = [];
	let embedMs = 0;
	let knnMs = 0;
	let vector = false;
	let note: string | null = null;
	if (embedder === null) {
		note = "the query embedder is not available (check INDEX_EMBED and INDEX_EMBED_URL) — keyword search only";
	} else if (embedderMatches(index.meta.embedder, embedder)) {
		const embedAt = Date.now();
		try {
			const [vector0] = await embedder.embed([query]);
			embedMs = Date.now() - embedAt;
			if (vector0 !== undefined && vector0.length === index.meta.dims) {
				const knnAt = Date.now();
				const similarity = new Float64Array(chunks.length);
				const dimension = index.meta.dims;
				for (let i = 0; i < chunks.length; i++) {
					if (!allowed[i]) continue;
					let dot = 0;
					const base = i * dimension;
					for (let d = 0; d < dimension; d++) dot += vector0[d]! * index.vectors[base + d]!;
					similarity[i] = dot;
				}
				vectorTop = top(similarity, chunks, CANDIDATES);
				knnMs = Date.now() - knnAt;
				vector = true;
			} else {
				note = `the index was built with ${index.meta.embedder}; the query embedder is ${embedder.id} — keyword search only`;
			}
		} catch (error) {
			note = `query embedding failed (${error instanceof Error ? error.message : String(error)}); keyword search only`;
		}
	} else {
		note = `the index was built with ${index.meta.embedder}; the query embedder is ${embedder.id} — keyword search only`;
	}

	// Fusion: Reciprocal Rank Fusion over the two rankings. The 1/(60+rank) form is a choice made
	// here: Cursor's service reranks too, but the exact fusion is not observable from the client.
	const fused = new Map<number, { score: number; bm25: number | null; vector: number | null }>();
	bm25Top.forEach((i, rank) => fused.set(i, { score: 1 / (RRF_K + rank + 1), bm25: rank, vector: null }));
	vectorTop.forEach((i, rank) => {
		const current = fused.get(i);
		if (current === undefined) fused.set(i, { score: 1 / (RRF_K + rank + 1), bm25: null, vector: rank });
		else {
			current.score += 1 / (RRF_K + rank + 1);
			current.vector = rank;
		}
	});
	const ranked = [...fused.entries()].sort(
		(a, b) =>
			b[1].score - a[1].score ||
			(chunks[a[0]]!.p < chunks[b[0]]!.p ? -1 : chunks[a[0]]!.p > chunks[b[0]]!.p ? 1 : chunks[a[0]]!.a - chunks[b[0]]!.a),
	);
	const hits: Hit[] = ranked.slice(0, hints.k ?? 10).map(([i, ranks]) => {
		const chunk = chunks[i]!;
		return {
			path: chunk.p,
			startLine: chunk.a,
			endLine: chunk.b,
			score: ranks.score,
			snippet: snippet(chunk.t, tokens),
			bm25Rank: ranks.bm25,
			vectorRank: ranks.vector,
		};
	});
	return {
		hits,
		meta: {
			chunks: chunks.length,
			embedder: index.meta.embedder,
			vector,
			keywordMs,
			embedMs,
			knnMs,
			totalMs: Date.now() - started,
			note: [fallbackNote, note].filter((line): line is string => line !== null).join("; ") || null,
		},
		rootHash: index.meta.rootHash,
		updatedAt: index.meta.updatedAt,
	};
}

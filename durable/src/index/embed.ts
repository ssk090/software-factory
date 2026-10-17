// Embedders. Cursor's client has no embedder at all: it uploads files and Cursor's service returns
// embeddings. For the factory the "service" is pluggable instead, so the index works with no
// service at all and keeps its promise inside Docker:
//  - hash: the default. Deterministic feature hashing over the shared tokenizer: offline, no
//    dependencies, no model download, and identical vectors on every machine. Keyword (BM25) does
//    the heavy lifting in search; these vectors add fuzzy, order-free matching.
//  - http: any OpenAI-compatible /embeddings endpoint — a local Ollama or llama.cpp server
//    (e.g. http://localhost:11434/v1) or a hosted API when INDEX_EMBED_URL is set.
import type { IndexOptions } from "./options.ts";
import { fnv1a, tokenize } from "./text.ts";

export type Embedder = {
	readonly kind: "hash" | "http";
	/** The model name of an http embedder ("" for the built-in hash embedder). */
	readonly model: string;
	/** Vector length; 0 until the first embedding of an http endpoint is known. */
	readonly dims: number;
	/** The identity written to the index (kind, model, dimensions): a changed embedder rebuilds. */
	readonly id: string;
	embed(texts: readonly string[]): Promise<Float32Array[]>;
};

class HashEmbedder implements Embedder {
	readonly kind = "hash" as const;
	readonly model = "";
	readonly dims: number;
	constructor(dims: number) {
		this.dims = dims;
	}
	get id(): string {
		return `hash:${this.dims}`;
	}
	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		return texts.map((text) => this.one(text));
	}
	/** Signed feature hashing: every token votes into one bucket, then the vector is normalized. */
	one(text: string): Float32Array {
		const vector = new Float32Array(this.dims);
		for (const token of tokenize(text)) {
			const h = fnv1a(token);
			const bucket = h % this.dims;
			vector[bucket] = vector[bucket]! + (((h >>> 16) & 1) === 0 ? 1 : -1);
		}
		let norm = 0;
		for (const value of vector) norm += value * value;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
		return vector;
	}
}

class HttpEmbedder implements Embedder {
	readonly kind = "http" as const;
	readonly model: string;
	private readonly url: string;
	private readonly key: string;
	private readonly batch: number;
	private readonly timeoutMs: number;
	private length = 0;
	constructor(options: { url: string; model: string; key: string; batch: number; timeoutMs: number }) {
		this.url = options.url;
		this.model = options.model;
		this.key = options.key;
		this.batch = options.batch;
		this.timeoutMs = options.timeoutMs;
	}
	get dims(): number {
		return this.length;
	}
	get id(): string {
		return `http:${this.model}:${this.length}`;
	}
	async embed(texts: readonly string[]): Promise<Float32Array[]> {
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += this.batch) {
			const batch = texts.slice(i, i + this.batch);
			const response = await fetch(`${this.url}/embeddings`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(this.key !== "" ? { authorization: `Bearer ${this.key}` } : {}) },
				body: JSON.stringify({ model: this.model, input: batch }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!response.ok) throw new Error(`embeddings ${response.status} from ${this.url}: ${(await response.text()).slice(0, 200)}`);
			const body = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
			const rows = (body.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			if (rows.length !== batch.length) throw new Error(`embeddings: asked ${batch.length}, got ${rows.length} from ${this.url}`);
			for (const row of rows) {
				const vector = Float32Array.from(row.embedding ?? []);
				if (vector.length === 0) throw new Error(`embeddings: empty vector from ${this.url}`);
				if (this.length === 0) this.length = vector.length;
				else if (vector.length !== this.length) throw new Error(`embeddings: ${vector.length} dimensions after ${this.length} from ${this.url}`);
				out.push(vector);
			}
		}
		return out;
	}
}

export function createEmbedder(options: IndexOptions): Embedder {
	if (options.embed.kind === "http") {
		if (options.embed.url === "") {
			throw new Error("INDEX_EMBED=http needs INDEX_EMBED_URL, e.g. http://localhost:11434/v1 (Ollama) or any OpenAI-compatible /embeddings endpoint");
		}
		return new HttpEmbedder(options.embed);
	}
	return new HashEmbedder(options.embed.dims);
}

/** Same embedded space as the stored index? (A mismatch falls back to keyword search.) */
export function embedderMatches(stored: string, embedder: Embedder): boolean {
	if (embedder.kind === "hash") return stored === embedder.id;
	return embedder.dims === 0 ? stored.startsWith(`http:${embedder.model}:`) : stored === embedder.id;
}

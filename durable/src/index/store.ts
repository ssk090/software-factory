// The index on disk, under state/index/<repoId>/ (all inside the data folder, so it survives
// restarts and is the same folder every sandbox container sees):
//   meta.json        identity: root hash, source ref/commit, embedder, counts, timestamps
//   manifest.json    the Merkle manifest: every file's content hash, size, mtime, chunks, simhash
//   chunks.jsonl     one record per chunk: path, line range, text
//   vectors.f32      the chunk vectors, in chunks.jsonl order (little-endian float32)
//   description.txt  the generated code map
//   snapshot/        the hidden worktree when INDEX_REF is used
// Writes are tmp-file + rename; a torn read is detected (root hash vs manifest, vectors vs chunks)
// and answered with "no index" so the next update rebuilds it.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type StoredChunk = { p: string; a: number; b: number; t: string };
export type ManifestFile = { h: string; s: number; m: number; c: number; sh: string };
export type Manifest = { version: 1; rootHash: string; files: Record<string, ManifestFile> };
export type Meta = {
	version: 1;
	repoId: string;
	source: { mode: "worktree" | "ref"; ref: string; commit: string | null; branch: string | null };
	embedder: string;
	dims: number;
	files: number;
	chunks: number;
	rootHash: string;
	/** The chunker's shape (`lines/overlap`): a change rebuilds the chunks. */
	chunk: string;
	builtAt: number;
	updatedAt: number;
};
export type LoadedIndex = { meta: Meta; manifest: Manifest; chunks: StoredChunk[]; vectors: Float32Array };
export type IndexData = { meta: Meta; manifest: Manifest; chunks: StoredChunk[]; vectors: Float32Array; description: string };

const toF32 = (buffer: Buffer): Float32Array =>
	new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), 0, Math.floor(buffer.byteLength / 4));

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
	const tmp = `${path}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, path);
}

export class IndexStore {
	readonly dir: string;
	readonly snapshotDir: string;
	constructor(dir: string) {
		this.dir = dir;
		this.snapshotDir = join(dir, "snapshot");
	}
	private at = (name: string): string => join(this.dir, name);

	private async json<T>(name: string): Promise<T | null> {
		try {
			return JSON.parse(await readFile(this.at(name), "utf8")) as T;
		} catch {
			return null;
		}
	}

	/** Just the metadata: search decides from it whether its in-process cache is stale. */
	readMeta(): Promise<Meta | null> {
		return this.json<Meta>("meta.json");
	}

	async load(): Promise<LoadedIndex | null> {
		const meta = await this.json<Meta>("meta.json");
		const manifest = await this.json<Manifest>("manifest.json");
		if (meta === null || manifest === null || meta.rootHash !== manifest.rootHash) return null;
		const lines = (await readFile(this.at("chunks.jsonl"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
		const chunks: StoredChunk[] = [];
		for (const line of lines) {
			try {
				const chunk = JSON.parse(line) as StoredChunk;
				if (typeof chunk.p === "string" && typeof chunk.t === "string" && Number.isInteger(chunk.a) && Number.isInteger(chunk.b)) chunks.push(chunk);
			} catch {
				return null;
			}
		}
		const raw = await readFile(this.at("vectors.f32")).catch(() => null);
		const vectors = raw === null ? new Float32Array(0) : toF32(raw);
		if (vectors.length !== chunks.length * meta.dims) return null;
		return { meta, manifest, chunks, vectors };
	}

	async description(): Promise<string | null> {
		return readFile(this.at("description.txt"), "utf8").catch(() => null);
	}

	async save(data: IndexData): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const jsonl = data.chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
		await writeAtomic(this.at("chunks.jsonl"), data.chunks.length === 0 ? "" : `${jsonl}\n`);
		await writeAtomic(this.at("vectors.f32"), Buffer.from(data.vectors.buffer, data.vectors.byteOffset, data.vectors.byteLength));
		await writeAtomic(this.at("manifest.json"), JSON.stringify(data.manifest));
		await writeAtomic(this.at("meta.json"), `${JSON.stringify(data.meta, null, "\t")}\n`);
		await writeAtomic(this.at("description.txt"), data.description);
	}

	/** One writer at a time (a serving factory's refresh and a manual ff index can meet). */
	async lock(): Promise<(() => Promise<void>) | null> {
		await mkdir(this.dir, { recursive: true });
		const path = this.at(".lock");
		const stamp = `${process.pid} ${Date.now()}`;
		try {
			await writeFile(path, stamp, { flag: "wx" });
		} catch {
			const stale = await readFile(path, "utf8").then((text) => {
				const at = Number(text.split(" ")[1]);
				return Number.isFinite(at) && Date.now() - at > 10 * 60_000;
			}, () => true);
			if (!stale) return null;
			await writeFile(path, stamp);
		}
		return async () => {
			await rm(path, { force: true });
		};
	}

	async remove(): Promise<void> {
		await rm(this.dir, { recursive: true, force: true });
	}
}

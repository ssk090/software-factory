// The sync engine: Cursor's client-side loop, with the embedding service replaced by local files.
//   handshake      root hash of the Merkle tree == the manifest's? -> UP_TO_DATE, nothing else runs
//   subtree sync   changed files only: a commit diff when INDEX_REF is used, content hashes otherwise
//   file update    read, chunk and embed the changed files; keep every other chunk and vector
//   persist        manifest + chunks + vectors + code map, written atomically into state/index/<repoId>
// One update at a time per index (lock file); a background refresh reuses the same path
// (scheduleIndexUpdate), which is the factory's stand-in for Cursor's indexing watcher.
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "../git.ts";
import { chunkFile } from "./chunk.ts";
import { createEmbedder, embedderMatches } from "./embed.ts";
import { buildDescription } from "./map.ts";
import { buildTree, sha256, simhash64 } from "./merkle.ts";
import type { IndexOptions } from "./options.ts";
import { resolveSource } from "./source.ts";
import { IndexStore, type Manifest, type ManifestFile, type Meta, type StoredChunk } from "./store.ts";
import { readIndexedFile, walk } from "./walk.ts";

export type UpdateStatus = "built" | "updated" | "up_to_date" | "locked" | "skipped";
export type UpdateResult = {
	status: UpdateStatus;
	repoId: string;
	dir: string;
	source: string;
	files: number;
	chunks: number;
	changed: number;
	embedded: number;
	removed: number;
	ms: number;
	/** Why an update did not run (skipped, locked). */
	message?: string;
};
export type CheckStatus = "EMPTY" | "UP_TO_DATE" | "OUT_OF_SYNC" | "FAILURE";
export type CheckResult = { status: CheckStatus; files: number; chunks: number; rootHash: string | null; message: string };

type Pending = { path: string; text: string; hash: string; size: number; mtime: number };

const chunksKey = (options: IndexOptions): string => `${options.chunkLines}/${options.chunkOverlap}`;
const fullPath = (root: string, path: string): string => join(root, ...path.split("/"));

/** The store folder: the repo's index, or a ticket's own (`<repoId>-<scope>`). */
export const indexDirOf = (options: IndexOptions, repoId: string): string =>
	join(options.dir, options.scope === "" ? repoId : `${repoId}-${options.scope}`);

/**
 * The index's identity for a repo: its origin URL (the same on every clone and in every worktree,
 * so a ticket's worktree resolves to the same identity as the checkout it was cut from), else the
 * paths. The slug is the remote's name, so a folder reads "software-factory-3f2a1c…", not a temp name.
 */
export async function repoIdOf(root: string): Promise<string> {
	const url = (await run("git", ["-C", root, "remote", "get-url", "origin"])).stdout.trim();
	const key = url !== "" ? url : await realpath(root).catch(() => root);
	const slug = url !== "" ? url.replace(/\.git$/, "").split(/[/\\:]+/).filter((part) => part !== "").pop() ?? "" : "";
	const base = (slug !== "" ? slug : basename(root)).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 30) || "repo";
	return `${base}-${sha256(key).slice(0, 12)}`;
}

/** What a read (search, status) looks at: the scope's own index when it exists, else the repo's. */
export async function indexStoreFor(options: IndexOptions, repoId: string): Promise<{ store: IndexStore; fellBack: boolean }> {
	if (options.scope === "") return { store: new IndexStore(indexDirOf(options, repoId)), fellBack: false };
	const scoped = new IndexStore(indexDirOf(options, repoId));
	if ((await scoped.readMeta()) !== null) return { store: scoped, fellBack: false };
	return { store: new IndexStore(join(options.dir, repoId)), fellBack: true };
}

/**
 * A ticket's index starts as a copy of the repo's (its worktree is cut from that code). The first
 * update then reads, chunks and embeds only what the ticket changed: Cursor's "refreshed from git
 * diff", with the copy standing in for the checkout at the base commit. The seeded meta pins
 * commit to null (the manifest still carries the base's mtimes), so the handshake cannot trust it
 * before the first walk refreshes it; the copied chunks and vectors are reused either way.
 */
async function seedFromBase(options: IndexOptions, store: IndexStore, seedRoot: string, branch: string | null): Promise<"seeded" | "no-base" | "failed"> {
	const baseStore = new IndexStore(join(options.dir, await repoIdOf(seedRoot)));
	const meta = await baseStore.readMeta();
	if (meta === null) return "no-base";
	try {
		await mkdir(store.dir, { recursive: true });
		for (const name of ["manifest.json", "chunks.jsonl", "vectors.f32"]) await copyFile(join(baseStore.dir, name), join(store.dir, name));
		const seeded: Meta = { ...meta, source: { mode: "worktree", ref: "", commit: null, branch } };
		await writeFile(join(store.dir, "meta.json"), `${JSON.stringify(seeded, null, "\t")}\n`);
		return "seeded";
	} catch {
		return "failed";
	}
}

/** The files a commit step added, changed or deleted (renames arrive as add + delete). */
async function gitDiff(repo: string, from: string, to: string): Promise<{ changed: string[]; deleted: string[] }> {
	const result = await run("git", ["-C", repo, "diff", "--name-status", "--no-renames", "-z", from, to]);
	if (result.code !== 0) throw new Error(`git diff ${from} ${to}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
	const parts = result.stdout.split("\0").filter((part) => part !== "");
	const changed: string[] = [];
	const deleted: string[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const status = parts[i]!.charAt(0);
		const path = parts[i + 1]!;
		if (status === "D") deleted.push(path);
		else changed.push(path);
	}
	return { changed, deleted };
}

async function readPending(readRoot: string, path: string, maxFileBytes: number): Promise<Pending | null> {
	const file = await readIndexedFile(fullPath(readRoot, path), maxFileBytes);
	return file === null ? null : { path, text: file.text, hash: file.hash, size: file.size, mtime: 0 };
}

/**
 * Refresh the index for `root`. Cheap when nothing changed (one root-hash comparison in INDEX_REF
 * mode, one walk otherwise), exact when something did: only changed files are read, chunked and
 * embedded; every other chunk and vector is carried over.
 */
export async function updateIndex(
	options: IndexOptions,
	root: string,
	log: (line: string) => void = () => undefined,
	flags: { full?: boolean; seedRoot?: string } = {},
): Promise<UpdateResult> {
	const started = Date.now();
	const repoId = await repoIdOf(root);
	const store = new IndexStore(indexDirOf(options, repoId));
	const base = { repoId, dir: store.dir, source: "", files: 0, chunks: 0, changed: 0, embedded: 0, removed: 0 };
	const unlock = await store.lock();
	if (unlock === null) return { ...base, status: "locked", message: "another update is running", ms: Date.now() - started };
	try {
		let loaded = await store.load();
		const embedder = createEmbedder(options);
		const source = await resolveSource(root, store.snapshotDir, options, log);
		const sourceName = source.mode === "ref" ? `${source.ref}${source.commit ? ` @ ${source.commit.slice(0, 7)}` : ""}` : source.branch ?? "worktree";
		// A ticket's index is seeded from the repo's once, then follows the worktree alone.
		if (loaded === null && options.scope !== "" && flags.seedRoot !== undefined) {
			const seeded = await seedFromBase(options, store, flags.seedRoot, source.branch);
			if (seeded === "no-base") return { ...base, status: "skipped", source: sourceName, message: "the repo index does not exist yet", ms: Date.now() - started };
			if (seeded === "seeded") loaded = await store.load();
		}
		const full =
			flags.full === true ||
			loaded === null ||
			!embedderMatches(loaded.meta.embedder, embedder) ||
			loaded.meta.chunk !== chunksKey(options) ||
			loaded.meta.source.mode !== source.mode ||
			loaded.meta.source.ref !== source.ref;

		// The handshake: with INDEX_REF the commit alone answers "already up to date" (a working
		// tree can change under an unchanged commit, so only a ref trusts it).
		if (!full && loaded !== null && source.mode === "ref" && source.commit !== null && loaded.meta.source.commit === source.commit) {
			return { ...base, status: "up_to_date", source: sourceName, files: loaded.meta.files, chunks: loaded.meta.chunks, ms: Date.now() - started };
		}

		// Which files changed, and what the next manifest looks like.
		let files: Record<string, ManifestFile>;
		const pending: Pending[] = [];
		// A file whose content matches but whose stamps moved: the manifest itself must be saved.
		let touched = false;
		const delta = !full && loaded !== null && loaded.meta.source.mode === "ref" && source.mode === "ref" && loaded.meta.source.commit !== null && source.commit !== null;
		if (delta) {
			const diff = await gitDiff(root, loaded!.meta.source.commit!, source.commit!);
			files = { ...loaded!.manifest.files };
			for (const path of diff.deleted) delete files[path];
			for (const path of diff.changed) {
				const file = await readPending(source.readRoot, path, options.maxFileBytes);
				if (file === null) delete files[path];
				else pending.push(file);
			}
		} else {
			const walked = await walk(source.readRoot, { exclude: options.exclude, maxFileBytes: options.maxFileBytes, log });
			files = {};
			for (const entry of walked) {
				const old = full || loaded === null ? undefined : loaded.manifest.files[entry.path];
				// Unchanged since the last update (size and mtime): no read at all.
				if (old !== undefined && old.s === entry.size && old.m === entry.mtime) {
					files[entry.path] = old;
					continue;
				}
				const file = await readPending(source.readRoot, entry.path, options.maxFileBytes);
				if (file === null) continue;
				if (old !== undefined && old.h === file.hash) {
					files[entry.path] = { ...old, s: entry.size, m: entry.mtime };
					touched = true;
					continue;
				}
				file.mtime = entry.mtime;
				pending.push(file);
			}
		}

		// Chunk and embed the changed files (one embedder call, batched inside the embedder).
		const changedSet = new Set(pending.map((file) => file.path));
		const texts: string[] = [];
		const fileChunks = new Map<string, StoredChunk[]>();
		for (const file of pending) {
			const chunks = chunkFile(file.path, file.text, { lines: options.chunkLines, overlap: options.chunkOverlap }).map((chunk) => ({
				p: chunk.path,
				a: chunk.startLine,
				b: chunk.endLine,
				t: chunk.text,
			}));
			fileChunks.set(file.path, chunks);
			for (const chunk of chunks) texts.push(chunk.t);
		}
		const fresh = texts.length === 0 ? [] : await embedder.embed(texts);
		const dims = fresh.length > 0 ? fresh[0]!.length : loaded?.meta.dims ?? embedder.dims;
		for (const vector of fresh) if (vector.length !== dims) throw new Error(`the embedder returned ${vector.length} dimensions after ${dims}`);
		let embedded = 0;
		for (const file of pending) {
			const chunks = fileChunks.get(file.path) ?? [];
			files[file.path] = { h: file.hash, s: file.size, m: file.mtime, c: chunks.length, sh: simhash64(file.text) };
			embedded += chunks.length;
		}

		// Carry over every chunk of every untouched file; drop the rest.
		const kept: number[] = [];
		for (let i = 0; i < (loaded?.chunks.length ?? 0); i++) {
			const chunk = loaded!.chunks[i]!;
			if (changedSet.has(chunk.p) || files[chunk.p] === undefined) continue;
			kept.push(i);
		}
		const removed = (loaded?.meta.chunks ?? 0) - kept.length;
		if (changedSet.size === 0 && removed === 0 && !touched) {
			return { ...base, status: "up_to_date", source: sourceName, files: Object.keys(files).length, chunks: loaded!.meta.chunks, ms: Date.now() - started };
		}
		const chunks: StoredChunk[] = [];
		const vectors = new Float32Array((kept.length + texts.length) * dims);
		let write = 0;
		for (const i of kept) {
			chunks.push(loaded!.chunks[i]!);
			vectors.set(loaded!.vectors.subarray(i * loaded!.meta.dims, (i + 1) * loaded!.meta.dims), write * dims);
			write++;
		}
		let freshAt = 0;
		for (const file of pending) {
			for (const chunk of fileChunks.get(file.path) ?? []) {
				chunks.push(chunk);
				vectors.set(fresh[freshAt]!, write * dims);
				freshAt++;
				write++;
			}
		}

		// The new root hash, the metadata and the code map.
		const tree = buildTree(new Map(Object.entries(files).map(([path, file]) => [path, file.h])));
		const meta: Meta = {
			version: 1,
			repoId,
			source: { mode: source.mode, ref: source.ref, commit: source.commit, branch: source.branch },
			embedder: embedder.id,
			dims,
			files: Object.keys(files).length,
			chunks: chunks.length,
			rootHash: tree.rootHash,
			chunk: chunksKey(options),
			builtAt: loaded?.meta.builtAt ?? Date.now(),
			updatedAt: Date.now(),
		};
		const manifest: Manifest = { version: 1, rootHash: tree.rootHash, files };
		await store.save({ meta, manifest, chunks, vectors, description: buildDescription(files, meta) });
		const status: UpdateStatus = loaded === null ? "built" : "updated";
		log(`index: ${status} ${repoId} — ${meta.files} files, ${chunks.length} chunks (${embedded} embedded, ${removed} dropped) from ${sourceName}`);
		return { status, repoId, dir: store.dir, source: sourceName, files: meta.files, chunks: chunks.length, changed: changedSet.size, embedded, removed, ms: Date.now() - started };
	} finally {
		await unlock();
	}
}

/** The handshake status, for `ff index status --check` (Cursor's UP_TO_DATE / OUT_OF_SYNC). */
export async function checkIndex(options: IndexOptions, root: string, log: (line: string) => void = () => undefined): Promise<CheckResult> {
	const { store } = await indexStoreFor(options, await repoIdOf(root));
	const loaded = await store.load();
	if (loaded === null) return { status: "EMPTY", files: 0, chunks: 0, rootHash: null, message: "no index yet" };
	try {
		const source = await resolveSource(root, store.snapshotDir, options, log);
		if (source.mode === "ref") {
			const same = source.commit !== null && source.commit === loaded.meta.source.commit;
			return { status: same ? "UP_TO_DATE" : "OUT_OF_SYNC", files: loaded.meta.files, chunks: loaded.meta.chunks, rootHash: loaded.meta.rootHash, message: same ? `${source.ref} is at the indexed commit` : `${source.ref} moved` };
		}
		const hashes = new Map<string, string>();
		for (const entry of await walk(source.readRoot, { exclude: options.exclude, maxFileBytes: options.maxFileBytes })) {
			const file = await readIndexedFile(fullPath(source.readRoot, entry.path), options.maxFileBytes);
			if (file !== null) hashes.set(entry.path, file.hash);
		}
		const same = buildTree(hashes).rootHash === loaded.meta.rootHash;
		return {
			status: same ? "UP_TO_DATE" : "OUT_OF_SYNC",
			files: loaded.meta.files,
			chunks: loaded.meta.chunks,
			rootHash: loaded.meta.rootHash,
			message: same ? "the working tree matches its index" : "the working tree changed since its index was built",
		};
	} catch (error) {
		return { status: "FAILURE", files: loaded.meta.files, chunks: loaded.meta.chunks, rootHash: loaded.meta.rootHash, message: error instanceof Error ? error.message : String(error) };
	}
}

type ScheduleFlags = { full?: boolean; seedRoot?: string };
const chains = new Map<string, { chain: Promise<void>; lastEnd: number }>();

/**
 * A background refresh (the factory's stand-in for Cursor's indexing watcher): one at a time per
 * index, debounced to `INDEX_MIN_INTERVAL`, never throwing. Called when `ff serve` starts, after a
 * ticket's worktree is prepared (its fetch may have moved the base branch), and when an agent step
 * starts (so a ticket's own index catches up with the code the run generated so far). A ticket's
 * first update seeds from the repo index, so it waits for the repo's update when one is queued.
 */
export function scheduleIndexUpdate(options: IndexOptions, root: string, log: (line: string) => void, flags: ScheduleFlags = {}): void {
	const key = `${options.dir}|${options.scope}`;
	const entry = chains.get(key) ?? { chain: Promise.resolve(), lastEnd: 0 };
	chains.set(key, entry);
	const seed = flags.seedRoot !== undefined ? chains.get(`${options.dir}|`)?.chain ?? Promise.resolve() : Promise.resolve();
	entry.chain = entry.chain.then(async () => {
		await seed;
		if (Date.now() - entry.lastEnd < options.minIntervalMs) return;
		try {
			const result = await updateIndex(options, root, log, flags);
			if (result.status !== "up_to_date") log(`index: ${result.status} in ${result.ms} ms (${result.files} files, ${result.chunks} chunks)${result.message ? ` — ${result.message}` : ""}`);
		} catch (error) {
			log(`index: update failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			entry.lastEnd = Date.now();
		}
	});
}

// The code index: the Merkle handshake, the chunker's line numbers, what the walk skips (ignored,
// binary, oversized, secret paths), the delta update, search (paths, lines, filters), the ticket
// scope (seed from the repo's index, then follow the worktree), INDEX_REF through a snapshot, and
// the failure modes. Nothing here needs Docker or a network: the built-in embedder is deterministic.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chunkFile } from "../src/index/chunk.ts";
import { buildTree, sha256, simhash64 } from "../src/index/merkle.ts";
import { indexScope, loadIndexOptions } from "../src/index/options.ts";
import { searchIndex } from "../src/index/search.ts";
import { IndexStore } from "../src/index/store.ts";
import { checkIndex, repoIdOf, updateIndex } from "../src/index/sync.ts";
import { scratchRepo } from "./support.ts";

const optionsFor = (data: string, extra: Record<string, string> = {}) => {
	const dir = join(data, "index");
	return loadIndexOptions({ INDEX_DIR: dir, ...extra }, dir);
};

/** A repo with text, an ignored file, a binary, an oversized file and secret paths. */
async function makeRepo() {
	const w = await scratchRepo(tmpdir());
	w.git(w.repo, "config", "core.autocrlf", "false");
	await mkdir(join(w.repo, "src"), { recursive: true });
	await mkdir(join(w.repo, "assets"), { recursive: true });
	await mkdir(join(w.repo, "ignored"), { recursive: true });
	await writeFile(join(w.repo, "src", "app.ts"), "export const zephyr = \"marshmallow\";\nexport function greet(name: string): string {\n\treturn `hello ${name}`;\n}\n");
	await writeFile(join(w.repo, ".gitignore"), "ignored/\n*.log\n");
	await writeFile(join(w.repo, "ignored", "hidden.ts"), "export const hidden = true;\n");
	await writeFile(join(w.repo, "debug.log"), "noise\n");
	await writeFile(join(w.repo, ".env"), "FACTORY_SECRET=nope\n");
	await writeFile(join(w.repo, ".env.example"), "FACTORY_SECRET=example\n");
	await writeFile(join(w.repo, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
	await writeFile(join(w.repo, "blob.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
	await writeFile(join(w.repo, "big.txt"), `${"x".repeat(2500)}\n`);
	w.git(w.repo, "add", ".");
	w.git(w.repo, "commit", "-q", "-m", "app");
	w.git(w.repo, "push", "-q", "origin", "main");
	return w;
}

describe("index", { timeout: 120_000 }, () => {
	it("buildTree is content-addressed: order, path and one changed byte all matter", () => {
		const files = new Map([["src/a.ts", sha256("a")], ["src/b.ts", sha256("b")], ["README.md", sha256("readme")]]);
		const one = buildTree(files);
		assert.equal(one.rootHash, buildTree(new Map([...files].reverse())).rootHash, "insertion order must not matter");
		assert.equal(one.dirs.get("."), one.rootHash, "the root lives under the '.' key");
		const changed = buildTree(new Map([...files, ["src/a.ts", sha256("a!")]]));
		assert.notEqual(changed.rootHash, one.rootHash);
		assert.notEqual(changed.dirs.get("src"), one.dirs.get("src"), "the change rolls up its directory");
		assert.notEqual(buildTree(new Map([["src/b.ts", sha256("a")]])).rootHash, buildTree(new Map([["other/b.ts", sha256("a")]])).rootHash, "same content, other path");
	});

	it("chunkFile covers every line with 1-based inclusive ranges that overlap", () => {
		const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
		const chunks = chunkFile("a.ts", text, { lines: 60, overlap: 10 });
		assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 60], [51, 110], [101, 130]]);
		assert.equal(chunks[0]!.text.split("\n").slice(-10).join("\n"), chunks[1]!.text.split("\n").slice(0, 10).join("\n"), "the overlap is shared verbatim");
		assert.equal(chunkFile("a.ts", "\n\n\n", { lines: 60, overlap: 10 }).length, 0, "whitespace-only files have nothing to embed");
	});

	it("build indexes what agents may read and skips the rest", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data, { INDEX_MAX_FILE_BYTES: "2000" });
			const result = await updateIndex(options, w.repo, () => {});
			assert.equal(result.status, "built");
			const loaded = (await new IndexStore(result.dir).load())!;
			const paths = Object.keys(loaded.manifest.files);
			assert.ok(paths.includes("src/app.ts"));
			assert.ok(paths.includes(".env.example"), "the example env is readable on purpose");
			assert.ok(!paths.includes(".env"), "secret paths never enter the index");
			assert.ok(!paths.includes("debug.log"), "git-ignored files are skipped");
			assert.ok(!paths.some((path) => path.startsWith("ignored/")), "git-ignored directories are skipped");
			assert.ok(!paths.includes("assets/logo.png"), "binary extensions are skipped");
			assert.ok(!paths.includes("big.txt"), "files over the cap are skipped");
			assert.ok(!paths.includes("blob.dat"), "a NUL byte means binary, whatever the extension");
			assert.equal(loaded.meta.files, paths.length);
			assert.equal(loaded.meta.source.mode, "worktree");
			assert.ok((await new IndexStore(result.dir).description())!.includes("src/"), "the code map is written");
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("search answers with paths, line ranges and both ranks", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data);
			await updateIndex(options, w.repo, () => {});
			const found = await searchIndex(options, w.repo, "zephyr marshmallow", { k: 5 });
			const hit = found.hits.find((h) => h.path === "src/app.ts");
			assert.ok(hit !== undefined, JSON.stringify(found.hits));
			assert.ok(hit!.startLine >= 1 && hit!.endLine >= hit!.startLine);
			assert.match(hit!.snippet, /zephyr|marshmallow/);
			assert.equal(hit!.bm25Rank, 0, "both query words sit in that chunk");
			assert.ok(found.meta.vector, "the query embeds in the index's own space");
			const filtered = await searchIndex(options, w.repo, "zephyr", { k: 5, path: "src/**" });
			assert.ok(filtered.hits.length > 0 && filtered.hits.every((h) => h.path.startsWith("src/")));
			assert.equal((await searchIndex(options, w.repo, "zephyr", { path: "README.md" })).hits.length, 0);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("an update embeds only what changed, drops what is gone, then says up_to_date", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data);
			assert.equal((await updateIndex(options, w.repo, () => {})).status, "built");
			assert.equal((await updateIndex(options, w.repo, () => {})).status, "up_to_date", "the handshake answers without reading files");
			await writeFile(join(w.repo, "src", "app.ts"), "export const zephyr = \"butterscotch\";\n");
			const third = await updateIndex(options, w.repo, () => {});
			assert.equal(third.status, "updated");
			assert.equal(third.changed, 1);
			assert.ok(third.embedded >= 1);
			const loaded = (await new IndexStore(third.dir).load())!;
			assert.ok(!loaded.chunks.some((chunk) => chunk.t.includes("marshmallow")), "the old text is gone");
			assert.ok(loaded.chunks.some((chunk) => chunk.t.includes("butterscotch")));
			await rm(join(w.repo, "src", "app.ts"));
			const fourth = await updateIndex(options, w.repo, () => {});
			assert.equal(fourth.status, "updated");
			assert.equal(fourth.changed, 0);
			assert.ok(fourth.removed >= 1, "the deleted file's chunks are dropped");
			assert.ok(!(await new IndexStore(fourth.dir).load())!.manifest.files["src/app.ts"]);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("checkIndex reports Cursor's handshake states", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data);
			assert.equal((await checkIndex(options, w.repo)).status, "EMPTY");
			await updateIndex(options, w.repo, () => {});
			assert.equal((await checkIndex(options, w.repo)).status, "UP_TO_DATE");
			await writeFile(join(w.repo, "src", "app.ts"), "export const changed = true;\n");
			assert.equal((await checkIndex(options, w.repo)).status, "OUT_OF_SYNC");
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("INDEX_REF indexes a ref through a snapshot and follows new commits with git diff", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data, { INDEX_REF: "origin/main" });
			const first = await updateIndex(options, w.repo, () => {});
			assert.equal(first.status, "built");
			assert.match(first.source, /^origin\/main @ /);
			assert.equal((await updateIndex(options, w.repo, () => {})).status, "up_to_date");
			assert.equal((await checkIndex(options, w.repo)).status, "UP_TO_DATE");
			// A new commit on the ref: only its files are read, chunked and embedded.
			await writeFile(join(w.repo, "src", "next.ts"), "export const quokka = true;\n");
			w.git(w.repo, "add", ".");
			w.git(w.repo, "commit", "-q", "-m", "next");
			w.git(w.repo, "push", "-q", "origin", "main");
			assert.equal((await checkIndex(options, w.repo)).status, "OUT_OF_SYNC");
			const second = await updateIndex(options, w.repo, () => {});
			assert.equal(second.status, "updated");
			assert.equal(second.changed, 1);
			assert.ok(second.embedded >= 1);
			assert.ok((await new IndexStore(second.dir).load())!.manifest.files["src/next.ts"]);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("a ticket's index seeds from the repo's, then follows its worktree; reads fall back", async () => {
		const w = await makeRepo();
		try {
			const repo = optionsFor(w.data);
			await updateIndex(repo, w.repo, () => {});
			const worktree = join(w.root, "worktree");
			w.git(w.repo, "worktree", "add", "-q", "-b", "factory/T-9", worktree, "main");
			await writeFile(join(worktree, "src", "app.ts"), "export const zephyr = \"marzipan\";\n");
			const scoped = optionsFor(w.data, { INDEX_SCOPE: indexScope("T-9") });
			const result = await updateIndex(scoped, worktree, () => {}, { seedRoot: w.repo });
			assert.equal(result.status, "updated");
			assert.ok(result.dir.endsWith("-t-9"), result.dir);
			const loaded = (await new IndexStore(result.dir).load())!;
			assert.ok(loaded.chunks.some((chunk) => chunk.t.includes("marzipan")), "the ticket's own code is indexed");
			assert.ok(!loaded.chunks.some((chunk) => chunk.t.includes("marshmallow")), "the copy was refreshed, not kept");
			const found = await searchIndex(scoped, worktree, "marzipan");
			assert.ok(found.hits.some((hit) => hit.path === "src/app.ts"));
			// A scope whose index is not built yet reads the repo index, and says so.
			const cold = optionsFor(w.data, { INDEX_SCOPE: indexScope("T-NONE") });
			const fellBack = await searchIndex(cold, worktree, "marshmallow");
			assert.match(fellBack.meta.note ?? "", /repo index/);
			assert.ok(fellBack.hits.some((hit) => hit.path === "src/app.ts"));
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("repoIdOf names the same repo from a clone and from a worktree of it", async () => {
		const w = await makeRepo();
		try {
			const worktree = join(w.root, "worktree");
			w.git(w.repo, "worktree", "add", "-q", "-b", "same-id", worktree, "main");
			assert.equal(await repoIdOf(worktree), await repoIdOf(w.repo), "a worktree is the same repo");
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("simhash64 is stable and keeps near text closer than far text", () => {
		const base = "the quick brown fox jumps over the lazy dog ".repeat(20);
		const near = `${base}and then it runs away`;
		const far = "quantum chromodynamics renormalization lattice gauge anomaly ".repeat(20);
		const hamming = (a: string, b: string): number => {
			let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
			let n = 0;
			while (x > 0n) {
				n += Number(x & 1n);
				x >>= 1n;
			}
			return n;
		};
		assert.equal(simhash64(base), simhash64(base));
		assert.notEqual(simhash64(base), simhash64(far));
		assert.ok(hamming(simhash64(base), simhash64(near)) < hamming(simhash64(base), simhash64(far)));
	});

	it("an http embedder without a URL fails the build loudly; search degrades to keyword", async () => {
		const w = await makeRepo();
		try {
			const options = optionsFor(w.data);
			await updateIndex(options, w.repo, () => {});
			const broken = { ...options, embed: { ...options.embed, kind: "http" as const, url: "" } };
			await assert.rejects(() => updateIndex(broken, w.repo, () => {}, { full: true }), /INDEX_EMBED_URL/);
			const found = await searchIndex(broken, w.repo, "zephyr");
			assert.equal(found.meta.vector, false);
			assert.match(found.meta.note ?? "", /embedder/);
			assert.ok(found.hits.length > 0, "keyword search still answers");
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

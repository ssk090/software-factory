// The Merkle model Cursor's client sends in its handshake: every file is hashed by its contents,
// every directory rolls its children up, and the root hash answers "is this codebase already
// indexed?" in one comparison. Identical contents hash the same on every machine, so the answer
// survives restarts, container rebuilds and the diff is always exact.
import { createHash } from "node:crypto";
import { fnv1a, tokenize } from "./text.ts";

/** SHA-256, hex: the one hash the index uses for files and directories. */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export type Tree = { rootHash: string; dirs: Map<string, string> };

const parentOf = (dir: string): string => {
	const at = dir.lastIndexOf("/");
	return at < 0 ? "." : dir.slice(0, at);
};
const childOf = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

/**
 * Directory hashes roll children up: sha256 over the sorted `name\0hash` lines of the files and
 * `name/\0<dir hash>` lines of the subdirectories. The root lives under the key "." (Cursor's
 * client asks for the subtree hash of "."). Two trees with the same files and contents have the
 * same root hash; one changed file changes it and every directory on its path to the root.
 */
export function buildTree(files: ReadonlyMap<string, string>): Tree {
	const nodes = new Map<string, { files: Map<string, string>; dirs: Set<string> }>();
	const node = (dir: string): { files: Map<string, string>; dirs: Set<string> } => {
		let n = nodes.get(dir);
		if (n === undefined) nodes.set(dir, (n = { files: new Map(), dirs: new Set() }));
		return n;
	};
	node(".");
	for (const [path, hash] of files) {
		const parts = path.split("/");
		const name = parts.pop()!;
		const dir = parts.length === 0 ? "." : parts.join("/");
		node(dir).files.set(name, hash);
		// Link every ancestor to its child by the immediate segment, so a file's change rolls up
		// to the root hash. (The root has no parent; it is where every chain ends.)
		for (let up = dir; up !== "."; up = parentOf(up)) {
			const parent = parentOf(up);
			node(parent).dirs.add(parent === "." ? up : up.slice(parent.length + 1));
		}
	}
	const dirs = new Map<string, string>();
	const hashOf = (dir: string): string => {
		const cached = dirs.get(dir);
		if (cached !== undefined) return cached;
		const n = node(dir);
		const lines: string[] = [];
		for (const [name, hash] of [...n.files].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${name}\0${hash}`);
		const children = [...n.dirs].sort().filter((name) => nodes.has(childOf(dir, name)));
		for (const name of children) lines.push(`${name}/\0${hashOf(childOf(dir, name))}`);
		const hash = sha256(lines.join("\n"));
		dirs.set(dir, hash);
		return hash;
	};
	const rootHash = hashOf(".");
	return { rootHash, dirs };
}

/** Which directories differ between two trees (the client-side half of a subtree sync). */
export function diffTrees(before: Tree, after: Tree): { changed: string[]; added: string[]; removed: string[] } {
	const changed: string[] = [];
	const added: string[] = [];
	const removed: string[] = [];
	for (const [dir, hash] of after.dirs) {
		const old = before.dirs.get(dir);
		if (old === undefined) added.push(dir);
		else if (old !== hash) changed.push(dir);
	}
	for (const dir of before.dirs.keys()) if (!after.dirs.has(dir)) removed.push(dir);
	return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/**
 * 64-bit SimHash of a token stream — Cursor's `similarity_metric_type: SIMHASH`, used there to
 * decide whether a codebase is close enough to copy another index; stored here per file so the
 * same question can be asked locally. Returns 16 hex characters.
 */
export function simhash64(text: string): string {
	const votes = new Int32Array(64);
	for (const token of tokenize(text)) {
		const h1 = fnv1a(token);
		const h2 = fnv1a(`${token}#s`);
		for (let i = 0; i < 32; i++) {
			votes[i] = votes[i]! + (((h1 >>> i) & 1) === 0 ? -1 : 1);
			votes[i + 32] = votes[i + 32]! + (((h2 >>> i) & 1) === 0 ? -1 : 1);
		}
	}
	let lo = 0;
	let hi = 0;
	for (let i = 0; i < 32; i++) {
		if (votes[i]! > 0) lo |= 1 << i;
		if (votes[i + 32]! > 0) hi |= 1 << i;
	}
	return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

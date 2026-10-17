// Small text helpers shared by the index's chunker, embedder, search and similarity code.
// The tokenizer splits code and prose the same way on every machine and run: the index never
// changes meaning because a tokenizer changed. (Cursor's client sends whole files and a hosted
// service embeds them; here the whole pipeline runs locally, so the tokenizer is ours to pin.)

const WORD = /[A-Za-z0-9_]+/g;
const CAMEL = /[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g;

/** Tokens of code/prose text: words split on separators, snake case and camel case, lowercased. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const word of text.match(WORD) ?? []) {
		for (const part of word.split(/_+/)) {
			for (const piece of part.match(CAMEL) ?? []) {
				const token = piece.toLowerCase();
				if (token.length >= 2) out.push(token);
				else if (/[0-9]/.test(token)) out.push(token);
			}
		}
	}
	return out;
}

/** FNV-1a, 32-bit. Stable across platforms and runs; used for feature hashing, never stored. */
export function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

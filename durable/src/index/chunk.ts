// Chunking. Cursor's client uploads whole files (up to its 10 MiB cap) and the embedding service
// splits them server-side; here the split happens locally, with the same shape: fixed line windows
// that overlap, so a symbol that sits on a boundary still appears whole in one chunk.
// Line numbers are 1-based and inclusive, so a hit maps straight onto an editor line.

export type Chunk = { path: string; startLine: number; endLine: number; text: string };
export type ChunkOptions = { lines: number; overlap: number; maxChars?: number };

const linesIn = (piece: string): number => {
	const n = piece.split("\n").length;
	return piece.endsWith("\n") ? n - 1 : n;
};
const newlines = (piece: string): number => {
	let n = 0;
	for (let i = 0; i < piece.length; i++) if (piece.charCodeAt(i) === 10) n++;
	return n;
};

/** Cut a window's text at `maxChars`, preferring line ends so most pieces stay real line ranges. */
function splitByChars(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const pieces: string[] = [];
	let at = 0;
	while (at < text.length) {
		let end = Math.min(at + maxChars, text.length);
		if (end < text.length) {
			const nl = text.lastIndexOf("\n", end - 1);
			if (nl >= at) end = nl + 1;
		}
		pieces.push(text.slice(at, end));
		at = end;
	}
	return pieces;
}

/** The file's chunks, in order. Whitespace-only tails produce no chunk. */
export function chunkFile(path: string, content: string, options: ChunkOptions): Chunk[] {
	const maxChars = options.maxChars ?? 8000;
	const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const step = Math.max(1, options.lines - Math.min(options.overlap, options.lines - 1));
	const out: Chunk[] = [];
	for (let i = 0; i < lines.length; i += step) {
		const window = lines.slice(i, i + options.lines);
		if (window.length === 0) break;
		if (window.every((line) => line.trim() === "")) {
			if (i + window.length >= lines.length) break;
			continue;
		}
		let consumed = 0;
		for (const piece of splitByChars(window.join("\n"), maxChars)) {
			out.push({ path, startLine: i + consumed + 1, endLine: i + consumed + linesIn(piece), text: piece });
			consumed += newlines(piece);
		}
		if (i + window.length >= lines.length) break;
	}
	return out;
}

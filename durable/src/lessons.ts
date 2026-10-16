// The factory learns from its failures: when the coordinator repairs one, it leaves a one-line
// lesson about the repo (how to build, check or test it), and the agents that change code read the
// lessons in their prompt from then on. state/lessons.md is plain Markdown: read it, edit it, or
// delete a line that is wrong, and the next step follows the file as it is.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./secrets.ts";

/** Lessons kept (the newest win). */
export const MAX_LESSONS = 40;
/** The roles that read the lessons: the ones that change code or fix failures. */
export const LESSON_ROLES = new Set(["test", "code", "fix", "docs", "coordinate"]);

const file = (stateDir: string) => join(stateDir, "lessons.md");
const HEADER = "# Lessons\n\nLearned by the coordinator from failures in this repo. Agents that change code read them. Edit or delete a line freely.\n\n";
const key = (lesson: string) => lesson.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let writing: Promise<unknown> = Promise.resolve();

export async function lessons(stateDir: string): Promise<string[]> {
	const text = await readFile(file(stateDir), "utf8").catch(() => "");
	return text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
}

/** Add a lesson (one line, no secrets, no duplicate). Returns the line kept, or null when it was not new. */
export function learn(stateDir: string, lesson: string, cid: string): Promise<string | null> {
	const line = redact(lesson.replace(/\s+/g, " ").trim()).text.slice(0, 300);
	const run = writing.then(async () => {
		const all = await lessons(stateDir);
		if (line === "" || all.some((l) => key(l.replace(/ \([^)]*\)$/, "")) === key(line))) return null;
		const kept = [...all, `${line} (${cid}, ${new Date().toISOString().slice(0, 10)})`].slice(-MAX_LESSONS);
		await writeFile(`${file(stateDir)}.tmp`, `${HEADER}${kept.map((l) => `- ${l}`).join("\n")}\n`);
		await rename(`${file(stateDir)}.tmp`, file(stateDir));
		return line;
	});
	writing = run.catch(() => undefined);
	return run;
}

/** The prompt section for a role that reads the lessons, or "". */
export async function readLessons(stateDir: string, role: string): Promise<string> {
	if (!LESSON_ROLES.has(role)) return "";
	const all = await lessons(stateDir);
	return all.length === 0 ? "" : `\nLessons from earlier runs in this repo (learned from real failures; follow them):\n${all.map((l) => `- ${l}`).join("\n")}\n`;
}

/**
 * A way to run VERIFY_CMD that fits this machine, learned by the coordinator when the check was
 * killed (out of memory): the same check with less parallelism, say. It applies while VERIFY_CMD
 * is the one it was learned for, and only when it still runs every script VERIFY_CMD names and
 * cannot pass by itself. state/verify.json; delete it to go back to VERIFY_CMD.
 */
export type LearnedVerify = { command: string; for: string; from: string; at: string };
const verifyFile = (stateDir: string) => join(stateDir, "verify.json");

/** Why `command` cannot stand in for `original`, or null when it can. */
export function verifyProblem(original: string, command: string): string | null {
	const c = command.trim();
	if (c === "" || c.includes("\n")) return "it is empty or more than one line";
	if (/\|\||;\s*(?:true|exit\s+0)\b|&&\s*(?:true|exit\s+0)\b|^\s*true\b|\bexit\s+0\b|>\s*\/dev\/null|--no-verify|--passWithNoTests|--bail=0/.test(c)) return "it could pass without the check passing";
	const scripts = original.split(/\s+/).filter((t) => t !== "" && !t.startsWith("-") && !/^(?:pnpm|npm|npx|yarn|bun|bunx|run|exec|turbo|nx)$/.test(t));
	const missing = scripts.filter((t) => !c.includes(t));
	return missing.length > 0 ? `it does not run ${missing.join(", ")}` : null;
}

export async function learnedVerify(stateDir: string, original: string): Promise<string | null> {
	const saved = await readFile(verifyFile(stateDir), "utf8").then((t) => JSON.parse(t) as LearnedVerify, () => null);
	return saved !== null && saved.for === original && verifyProblem(original, saved.command) === null ? saved.command : null;
}

export async function learnVerify(stateDir: string, original: string, command: string, cid: string): Promise<string | null> {
	const problem = verifyProblem(original, command);
	if (problem !== null) return problem;
	const saved: LearnedVerify = { command: command.trim(), for: original, from: cid, at: new Date().toISOString() };
	await writeFile(`${verifyFile(stateDir)}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
	await rename(`${verifyFile(stateDir)}.tmp`, verifyFile(stateDir));
	return null;
}

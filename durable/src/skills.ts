// Skills for an agent step: the agent file's `skills:` header plus
// the ticket's `Skills:` line. Each is looked up in the ticket's repo first (REPO_SKILL_DIRS), then
// on SKILLS_PATH, copied into RUN/skills so a sandboxed agent can read it, and named in the prompt.
import { appendFile, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** A skill name comes from ticket text too, and becomes a path: only `name` or `set/name`. */
export const skillNameOk = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(name) && !name.includes("..");

const isFile = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** Header fields of an agent file: `---\nname: x\nskills: a, b\n---`. */
export function parseAgentFile(text: string): { header: Record<string, string>; body: string } {
	const lines = text.split("\n");
	if (lines[0] !== "---") return { header: {}, body: text };
	const end = lines.indexOf("---", 1);
	if (end < 0) return { header: {}, body: text };
	const header: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (m) header[m[1]!] = m[2]!.trim();
	}
	return { header, body: lines.slice(end + 1).join("\n") };
}

const splitNames = (value: string) => value.split(/[\s,]+/).filter(Boolean);

export function stepSkills(agentHeader: Record<string, string>, ticketMd: string): string[] {
	const fromTicket = /^skills:[ \t]*(.*)$/im.exec(ticketMd)?.[1] ?? "";
	return [...new Set([...splitNames(agentHeader.skills ?? ""), ...splitNames(fromTicket)])].sort();
}

/** Every SKILL.md under `root`, at most `depth` folders down, following symlinks, sorted (like `find | sort`). */
async function findSkillFiles(root: string, depth: number): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, level: number) => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			const info = await stat(path).catch(() => undefined);
			if (info?.isDirectory() && level < depth) await walk(path, level + 1);
			else if (info?.isFile() && name === "SKILL.md") out.push(path);
		}
	};
	await walk(root, 1);
	return out.sort();
}

/** The skill's folder (or single .md file), or null. */
export async function skillDir(name: string, worktree: string, repoSkillDirs: readonly string[], skillsPath: readonly string[]): Promise<string | null> {
	const slash = name.indexOf("/");
	const set = slash < 0 ? null : name.slice(0, slash);
	const base = slash < 0 ? name : name.slice(slash + 1);
	if (set === null) {
		for (const d of repoSkillDirs) {
			if (await isFile(join(worktree, d, name, "SKILL.md"))) return join(worktree, d, name);
			if (await isFile(join(worktree, d, `${name}.md`))) return join(worktree, d, `${name}.md`);
		}
	}
	for (const root of skillsPath) {
		const files = await findSkillFiles(root, 6);
		const match = files.find((f) => {
			const parts = relative(root, f).split("/");
			const folder = parts.at(-2);
			if (set === null) return folder === name;
			// */set/base/SKILL.md or */set/*/base/SKILL.md
			return folder === base && (parts.at(-3) === set || parts.at(-4) === set);
		});
		if (match) return dirname(match);
	}
	return null;
}

export const SKILLS_NOTE =
	"If a skill expects a PR number or $ARGUMENTS, use PR from the Context line. If gh is not available, git diff BASE...HEAD shows the same change. When a skill says to use or publish to the issue tracker, ask the user, grill, or run a setup skill: do not. The ticket is RUN_DIR/ticket.md, the spec is RUN_DIR/spec.md, and you write only the files your agent instructions name. When a skill says to call, run or apply another skill, read RUN_DIR/skills/<name>/SKILL.md if it is there, otherwise skip it. A skill named superpowers:<name> is RUN_DIR/skills/<name>/SKILL.md. When a skill says to ask, stop for, or discuss with your human partner: nobody answers during this run. Decide from the ticket, the spec and the comments, and when a decision needs a person, report it the way your agent instructions say. When a skill says where to save a file (such as docs/superpowers/plans/), write the file your agent instructions name instead. When a skill says to start other agents or subagents, do the work yourself.";

/** Copy the step's skills into RUN/skills and return the prompt lines that point at them. */
export async function deliverSkills(options: {
	agent: string;
	names: readonly string[];
	worktree: string;
	run: string;
	repoSkillDirs: readonly string[];
	skillsPath: readonly string[];
	log: (line: string) => void;
}): Promise<string> {
	const files: string[] = [];
	for (const name of options.names) {
		if (!skillNameOk(name)) {
			options.log(`skill name '${name}' is not a plain name, skipped`);
			continue;
		}
		const dir = await skillDir(name, options.worktree, options.repoSkillDirs, options.skillsPath);
		if (dir === null) {
			options.log(`skill ${name} not found on SKILLS_PATH, skipped`);
			continue;
		}
		const target = join(options.run, "skills", name);
		await rm(target, { recursive: true, force: true });
		await mkdir(dirname(target), { recursive: true });
		if (await isFile(dir)) {
			await mkdir(target, { recursive: true });
			await cp(dir, join(target, "SKILL.md"));
		} else {
			await cp(dir, target, { recursive: true, dereference: true });
		}
		const shown = dir.startsWith(`${options.worktree}/`) ? dir.slice(options.worktree.length + 1) : dir;
		await appendFile(join(options.run, "skills.log"), `${options.agent}: ${name} <- ${shown}\n`);
		files.push(join(target, "SKILL.md"));
	}
	if (files.length === 0) return "";
	return `\nSkills: before you start, read and follow these skill files. Paths inside a skill are relative to its folder: ${files.join(" ")}\n${SKILLS_NOTE}\n`;
}

export async function readAgentFile(here: string, agent: string) {
	return parseAgentFile(await readFile(join(here, "agents", `${agent}.md`), "utf8"));
}

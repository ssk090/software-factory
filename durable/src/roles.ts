// The agents (examples 15-system-prompt, 27-plan-mode, 28-reviewer, and the Hooks section): every
// step conversation runs the coding tools with the factory's preamble and a guard hook. The role's
// instructions are the prompt itself, built from agents/<role>.md, its skills, and the Isolation and Context lines.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { StepDoc } from "./docs.ts";
import { inside } from "./env.ts";
import { deliverSkills, readAgentFile, stepSkills } from "./skills.ts";
import { steBlock, stePrompt, steRoles } from "./ste.ts";

/** Agents that only read the repo: they write only into the run folder, and must not commit. */
export const READERS = new Set(["spec", "plan", "review", "judge"]);

const FILE_TOOLS = new Set(["read", "write", "edit"]);
/** Only the factory pushes, and only to the ticket's branch. */
const GIT_PUSH = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/;

/**
 * The guard (a beforeTool hook): file tools stay inside the ticket's worktree and run folder (after
 * resolving symlinks), readers write only into the run folder, and no agent pushes. A role in
 * STE_ROLES cannot write prose that breaks a hard Simplified Technical English rule (ste.ts). Git refs
 * are guarded separately by the ticket's reference-transaction hook (git.ts).
 */
export const FactoryAgent = defineExtension({
	name: "factory-agent",
	sections: [
		section(
			"preamble",
			() =>
				"You are an agent of the software factory. You run headless: nobody answers questions during the run. Follow the instructions in the first message. A message that starts with \"Steer from the person watching this run\" comes from the human watching: follow it.",
			{ tag: false },
		),
		section("cwd", (input) => input.env?.cwd),
	],
	hooks: [
		hook(ToolTask, {
			beforeTool: async (call, api, context) => {
				const step = await api.snapshot(StepDoc, api.conversationId, context);
				if (step === undefined || step.worktree === "") return { block: "This conversation is not a factory step." };
				const args = call.arguments as Record<string, unknown>;
				if (call.name === "bash") {
					const command = typeof args.command === "string" ? args.command : "";
					return GIT_PUSH.test(command) ? { block: "Only the factory pushes. Commit on your branch; the factory pushes it." } : undefined;
				}
				if (!FILE_TOOLS.has(call.name)) return undefined;
				const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
				if (path === "") return undefined; // the tool rejects it itself
				const writes = call.name !== "read";
				const roots = writes && READERS.has(step.role) ? [step.run] : [step.worktree, step.run];
				if (await inside(path, step.worktree, roots)) {
					const faults = writes && steRoles().has(step.role) ? steBlock(call.name, args, path) : undefined;
					return faults === undefined ? undefined : { block: faults };
				}
				return {
					block: writes && READERS.has(step.role)
						? `The ${step.role} agent writes only into RUN_DIR (${step.run}), never into the repo.`
						: `Outside this ticket: use only the worktree (${step.worktree}) and RUN_DIR (${step.run}).`,
				};
			},
		}),
	],
});

export const STEP_EXTENSIONS = [CodingTools, FactoryAgent];

/** The step's first message: agents/<role>.md, its skills, then the Isolation and Context lines. */
export async function buildPrompt(options: {
	here: string;
	role: string;
	round: number;
	cid: string;
	branch: string;
	base: string;
	run: string;
	worktree: string;
	pr: string | null;
	verifyCmd: string;
	portBase: number;
	portSpan: number;
	repoSkillDirs: readonly string[];
	skillsPath: readonly string[];
	log: (line: string) => void;
}): Promise<string> {
	const { header, body } = await readAgentFile(options.here, options.role);
	const ticketMd = await readFile(join(options.run, "ticket.md"), "utf8").catch(() => "");
	const skills = await deliverSkills({
		agent: options.role,
		names: stepSkills(header, ticketMd),
		worktree: options.worktree,
		run: options.run,
		repoSkillDirs: options.repoSkillDirs,
		skillsPath: options.skillsPath,
		log: options.log,
	});
	const ste = steRoles().has(options.role) ? `\n${stePrompt()}\n\nThe factory checks every prose file you write against these rules. A write that breaks a hard rule is blocked, and the block names each fault. Text in code blocks (also Mermaid) is not checked.\n` : "";
	return `${body.trim()}
${skills}${ste}
Isolation: you are one of several agents working on different tickets at the same time, each in its own git worktree. Work only in your cwd (this ticket's worktree on branch ${options.branch}) and RUN_DIR. Do not read or change other worktrees. Do not use git stash (one stash is shared by every worktree), and do not create, switch, move or delete branches or tags: a git hook refuses it. A server or container you start must use ports PORT_BASE to PORT_BASE+${options.portSpan - 1} (PORT_BASE=${options.portBase}, PORT is set to it) and the compose project in COMPOSE_PROJECT_NAME, and you must stop it before you finish.

Context: RUN_DIR=${options.run} TICKET=${options.cid} BASE=origin/${options.base} ROUND=${options.round} PR=${options.pr ?? "none yet"} VERIFY_CMD=${options.verifyCmd || "<none, use the repo documented checks>"}. Do your job now.`;
}

/** Roles that exist: an agent file in agents/ (deleting docs.md turns the docs writer off). */
export async function hasRole(here: string, role: string): Promise<boolean> {
	return readFile(join(here, "agents", `${role}.md`)).then(() => true, () => false);
}

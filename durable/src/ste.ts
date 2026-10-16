// ASD-STE100 Simplified Technical English for the documents the agents write (agent-ste, MIT): the
// rules go into the prompt of the roles in STE_ROLES (default: the spec writer and the planner), a
// write or edit of a prose file that breaks a hard rule is blocked with each fault named, and the
// factory lints the files they leave. The prompt and the checks come from the same engine.
import { check, type Engine, editSubject, fileSubject, newEngine, promptText } from "agent-ste/src/host/lint.mjs";

let engine: Engine | null = null;
const handle = () => (engine ??= newEngine());

/** The roles that write in Simplified Technical English. */
export const steRoles = (env: NodeJS.ProcessEnv = process.env): Set<string> =>
	new Set((env.STE_ROLES ?? "spec,plan").split(",").map((r) => r.trim()).filter(Boolean));

/** The rule list for the prompt. */
export const stePrompt = (): string => promptText(handle());

/** Why a write or an edit must not happen (hard faults, named), or undefined. Code and non-prose files pass. */
export function steBlock(tool: string, args: Record<string, unknown>, path: string): string | undefined {
	const subject =
		tool === "write" && typeof args.content === "string"
			? fileSubject(path, args.content)
			: tool === "edit" && Array.isArray(args.edits)
				? editSubject(path, args.edits.flatMap((e: { newText?: unknown }) => (typeof e?.newText === "string" ? [e.newText] : [])))
				: undefined;
	return subject === undefined ? undefined : check(handle(), subject).reason;
}

/** The hard faults of a whole file: the count, and the report to give its author. */
export function steFaults(path: string, content: string): { hard: number; reason: string | undefined } {
	const subject = fileSubject(path, content);
	if (subject === undefined) return { hard: 0, reason: undefined };
	const result = check(handle(), subject);
	return { hard: result.hard.length, reason: result.reason };
}

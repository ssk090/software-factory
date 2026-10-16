// Types for the part of agent-ste (plain JavaScript) the factory calls.
declare module "agent-ste/src/host/lint.mjs" {
	export type Violation = { line: number; column: number; message: string; ruleId: string; severity: "hard" | "soft" };
	export type Engine = { compiled: unknown; rules: Record<string, "hard" | "soft" | "off"> };
	export type Subject = { text: string; label: string };
	export function newEngine(config?: { rules?: Record<string, "hard" | "soft" | "off"> }): Engine;
	export function promptText(handle: Engine): string;
	export function fileSubject(path: string, content: string): Subject | undefined;
	export function editSubject(path: string, texts: string[]): Subject | undefined;
	export function check(handle: Engine, subject: Subject): { violations: Violation[]; hard: Violation[]; soft: Violation[]; reason: string | undefined };
}

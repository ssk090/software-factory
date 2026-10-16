// A scratch world for pipeline tests: a repo with an origin, a fake tracker and
// git host, and pi-ai's faux model playing every agent from its prompt.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, type FauxResponseStep, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.ts";
import type { GitHost } from "../src/github.ts";
import type { Lanes } from "../src/lanes.ts";
import type { Sprint, SprintTask, TicketInfo, Tracker } from "../src/tracker.ts";

export const here = join(import.meta.dirname, "..", "..");

export async function scratchRepo(base = tmpdir()) {
	const root = await mkdtemp(join(base, "sf-pipeline-"));
	const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
	await mkdir(join(root, "data"), { recursive: true });
	execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
	execFileSync("git", ["clone", "-q", join(root, "origin.git"), join(root, "repo")], { stdio: "pipe" });
	await writeFile(join(root, "repo", "README.md"), "scratch\n");
	sh(join(root, "repo"), "add", ".");
	sh(join(root, "repo"), "commit", "-q", "-m", "init");
	sh(join(root, "repo"), "branch", "-M", "main");
	sh(join(root, "repo"), "push", "-q", "origin", "main");
	return { root, repo: join(root, "repo"), data: join(root, "data"), git: sh };
}

export function testConfig(repo: string, data: string, extra: Record<string, string> = {}) {
	return loadConfig(
		{
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			DATA_DIR: data,
			REPO: repo,
			BASE: "main",
			SANDBOX: "none",
			AGENT_TIMEOUT: "120",
			SKILLS_PATH: join(here, "skills"),
			TRACKER_COMMENTS: "1",
			PR_LABEL: "test-label",
			...extra,
		},
		here,
	);
}

export class FakeTracker implements Tracker {
	readonly log: string[] = [];
	status = new Map<string, string>();
	async info(id: string): Promise<TicketInfo> {
		return { id, cid: id, title: `test ticket ${id}`, url: `https://example.test/t/${id}`, status: this.status.get(id) ?? "to do", description: "Skills: no-such-skill, ../../escape" };
	}
	async fetch(id: string) {
		return { ticket: `# ${id}: test\nSkills: no-such-skill, ../../escape\n`, comments: "" };
	}
	async setStatus(id: string, status: string) {
		this.status.set(id, status);
		this.log.push(`status ${id} ${status}`);
	}
	async comment(id: string, text: string) {
		this.log.push(`comment ${id} ${text.split("\n")[0]}`);
	}
	async resolve(ref: string) {
		return ref;
	}
	async pickup() {
		return [];
	}
	async sprint(): Promise<{ sprint: Sprint; tasks: SprintTask[] }> {
		return { sprint: { id: "s1", name: "Sprint 1", start: null, due: null }, tasks: [] };
	}
	async create(_list: string, name: string) {
		const id = `NEW-${this.log.length}`;
		this.log.push(`create ${id} ${name}`);
		return { id, url: `https://example.test/t/${id}` };
	}
}

export class FakeGitHost implements GitHost {
	readonly log: string[] = [];
	private prs = new Map<string, string>();
	async prFor(_w: string, branch: string) {
		return this.prs.get(branch) ?? null;
	}
	async createDraft(_w: string, base: string, branch: string, title: string) {
		const url = `https://example.test/pr/${this.prs.size + 1}`;
		this.prs.set(branch, url);
		this.log.push(`create ${base} ${branch} ${title}`);
		return url;
	}
	async edit(_w: string, pr: string, title: string) {
		this.log.push(`edit ${pr} ${title}`);
	}
	async addLabel(_w: string, pr: string, label: string) {
		this.log.push(`label ${pr} ${label}`);
	}
	async comment(_w: string, pr: string, body: string) {
		this.log.push(`comment ${pr} ${body.split("\n").at(-2) ?? ""}`.trim());
	}
	async ready(_w: string, pr: string) {
		this.log.push(`ready ${pr}`);
	}
	async state() {
		return null;
	}
}

export const lanes: Lanes = {
	lanes: { spec: ["faux/faux-1"], code: ["faux/faux-1"], review: ["faux/other-1"] },
	aliases: { plan: "spec", test: "code", docs: "code", "pr-summary": "code", fix: "code", judge: "review" },
};

const text = (message: Message | undefined) =>
	message === undefined ? "" : typeof message.content === "string" ? message.content : message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

export type Behaviour = {
	/** Extra bash for the coder's first try (e.g. deleting a frozen test). */
	coder?: string;
	/** Seconds the coder's bash sleeps (to stop the factory mid-step). */
	coderSleep?: number;
	/** Called with every request the coder's conversation makes. */
	onCoder?: (messages: readonly Message[]) => void;
	/** Called when the coder hears that its tool call was interrupted. */
	onInterrupted?: (result: string) => void;
	/** Called with every request a reviewer makes. */
	onReview?: (messages: readonly Message[]) => void;
};

/**
 * Plays every agent from its prompt: the first user message names the agent and carries RUN_DIR and
 * ROUND. Each agent makes one tool call, then answers.
 */
export function fauxAgents(behaviour: Behaviour = {}) {
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "other-1" }, { id: "broken-1" }] });
	const route: FauxResponseStep = (context, _options, _state, model) => {
		if (model.id === "broken-1") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" });
		const messages = context.messages;
		const prompt = text(messages.find((m) => m.role === "user"));
		const run = /RUN_DIR=(\S+)/.exec(prompt)?.[1] ?? "";
		const round = Number(/ROUND=(\d+)/.exec(prompt)?.[1] ?? "1");
		const acted = messages.some((m) => m.role === "toolResult");
		const done = (t: string) => fauxAssistantMessage(t);
		const bash = (command: string) => fauxAssistantMessage(fauxToolCall("bash", { command }, { id: `b${messages.length}` }), { stopReason: "toolUse" });
		const write = (path: string, content: string) => fauxAssistantMessage(fauxToolCall("write", { path, content }, { id: `w${messages.length}` }), { stopReason: "toolUse" });
		if (prompt.includes("# Agent: coder")) behaviour.onCoder?.(messages);
		if (prompt.includes("# Agent: code reviewer")) behaviour.onReview?.(messages);
		const lastResult = messages.findLast((m) => m.role === "toolResult");
		// Like a real model: a call that was interrupted (the factory stopped) is made again, once.
		const interrupted = lastResult?.role === "toolResult" && lastResult.isError && /interrupt/i.test(text(lastResult));
		if (interrupted && prompt.includes("# Agent: coder") && !messages.some((m, i) => i < messages.length - 1 && m.role === "toolResult" && m.isError)) {
			behaviour.onInterrupted?.(text(lastResult));
			return bash(`echo code >> file.txt && git add file.txt && git commit -qm "code after restart"`);
		}
		if (acted) return done(`Done (${messages.filter((m) => m.role === "toolResult").length} tool results).`);
		if (prompt.includes("# Agent: spec writer")) return write(`${run}/spec.md`, "AC-1: it works\nSTATUS: READY\n");
		if (prompt.includes("# Agent: planner")) return write(`${run}/plan.md`, "plan: AC-1 -> ac1.test\n");
		if (prompt.includes("# Agent: test writer")) {
			return bash(`echo "test AC-1" > ac1.test && git add ac1.test && git commit -qm "test: AC-1 (red)" && echo "AC-1 -> ac1.test" > ${run}/tests.md`);
		}
		if (prompt.includes("# Agent: coder")) {
			const escape = "{ git update-ref refs/heads/main HEAD; git branch other-ticket; git tag v-agent; } >" + `${run}/escape.log 2>&1;`;
			const extra = round === 1 && behaviour.coder ? `${behaviour.coder}; ` : "";
			const pause = behaviour.coderSleep ? `touch ${run}/coder-started; sleep ${behaviour.coderSleep}; ` : "";
			return bash(`${escape} ${extra}${pause}echo "port $PORT_BASE token \${CLICKUP_TOKEN:-none} $([ -f /.dockerenv ] && echo container || echo host)" > ${run}/cell.txt; echo code >> file.txt && git add file.txt && git commit -qm "code"`);
		}
		if (prompt.includes("# Agent: docs writer")) return write(`${run}/docs.md`, "No docs change needed\n");
		if (prompt.includes("# Agent: PR summary")) return bash(`echo "title ${round}" > ${run}/pr-title.txt && echo body > ${run}/pr-body.md`);
		if (prompt.includes("# Agent: code reviewer")) return write(`${run}/review-${round}.md`, `P1 x\nVERDICT: ${round === 1 ? "FIX" : "PASS"}\n`);
		if (prompt.includes("# Agent: fixer")) return bash(`echo fix >> file.txt && git commit -qam "fix"`);
		if (prompt.includes("# Agent: judge")) {
			return write(`${run}/judge.json`, JSON.stringify({ score: 4, summary: "done", criteria: [{ status: "met" }], hallucinations: [] }));
		}
		return done(`unknown agent: ${prompt.slice(0, 80)}`);
	};
	faux.setResponses(Array.from({ length: 400 }, () => route));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}

export const lastAssistant = (messages: readonly Message[]) => text(messages.findLast((m) => m.role === "assistant") as AssistantMessage | undefined);

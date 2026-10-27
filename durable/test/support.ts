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
import { type Sprint, type SprintTask, type TicketInfo, TicketGone, type Tracker } from "../src/tracker.ts";

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

/** A bare origin with one commit on main: a backend repo for BACKEND_REPOS. */
export async function scratchOrigin(root: string, name: string): Promise<string> {
	const origin = join(root, "backends", `${name}.git`);
	const seed = join(root, "backends", `${name}-seed`);
	execFileSync("git", ["init", "-q", "--bare", origin]);
	execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
	await writeFile(join(seed, "README.md"), `${name}\n`);
	execFileSync("git", ["-C", seed, "add", "."]);
	execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"]);
	execFileSync("git", ["-C", seed, "push", "-q", "origin", "HEAD:main"], { stdio: "pipe" });
	return origin;
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
			INDEX_AUTO: "0",
			...extra,
		},
		here,
	);
}

export class FakeTracker implements Tracker {
	readonly log: string[] = [];
	status = new Map<string, string>();
	/** Tickets deleted in the tracker. */
	readonly deleted = new Set<string>();
	async info(id: string): Promise<TicketInfo> {
		if (this.deleted.has(id)) throw new TicketGone(id, "deleted");
		return { id, cid: id, title: `test ticket ${id}`, url: `https://example.test/t/${id}`, status: this.status.get(id) ?? "to do", description: "Skills: no-such-skill, ../../escape" };
	}
	async fetch(id: string) {
		return { ticket: `# ${id}: test\nSkills: no-such-skill, ../../escape\n`, comments: "" };
	}
	async setStatus(id: string, status: string) {
		if (this.deleted.has(id)) throw new Error(`HTTP 404: ${id} deleted`);
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
	readonly attached = new Map<string, string>();
	async attach(id: string, name: string, content: string) {
		if (this.deleted.has(id)) throw new TicketGone(id, "deleted");
		this.attached.set(`${id}/${name}`, content);
		this.log.push(`attach ${id} ${name}`);
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
	/** The body each PR was opened with, by URL. */
	readonly bodies = new Map<string, string>();
	async prFor(_w: string, branch: string, repo?: string) {
		return this.prs.get(`${repo ?? ""}|${branch}`) ?? null;
	}
	async createDraft(_w: string, base: string, branch: string, title: string, body: string, repo?: string) {
		const url = `https://example.test/pr/${this.prs.size + 1}`;
		this.prs.set(`${repo ?? ""}|${branch}`, url);
		this.bodies.set(url, body);
		this.log.push(`create ${base} ${branch} ${title}${repo ? ` repo=${repo}` : ""}`);
		return url;
	}
	async edit(_w: string, pr: string, title: string) {
		this.log.push(`edit ${pr} ${title}`);
	}
	async addLabel(_w: string, pr: string, label: string) {
		this.log.push(`label ${pr} ${label}`);
	}
	/** Set to make assigning fail (an unknown login, no access). */
	assignFails = false;
	async addAssignees(_w: string, pr: string, logins: readonly string[]) {
		if (this.assignFails) throw new Error(`could not assign ${logins.join(",")}`);
		this.log.push(`assign ${pr} ${logins.join(",")}`);
	}
	async comment(_w: string, pr: string, body: string) {
		this.log.push(`comment ${pr} ${body.split("\n").at(-2) ?? ""}`.trim());
	}
	async review(_w: string, pr: string, _commit: string, _body: string, comments: readonly { path: string; line: number }[]) {
		this.log.push(`review ${pr} ${comments.map((c) => `${c.path}:${c.line}`).join(" ")}`);
	}
	async ready(_w: string, pr: string) {
		this.log.push(`ready ${pr}`);
	}
	async state() {
		return null;
	}
	/** PR feedback per URL, and the calls to feedback(). */
	readonly prFeedback = new Map<string, { state: "MERGED" | "CLOSED" | "OPEN"; comments: string[]; head?: string }>();
	readonly feedbackLog: string[] = [];
	async feedback(_w: string, pr: string) {
		this.feedbackLog.push(pr);
		const found = this.prFeedback.get(pr);
		return found === undefined ? null : { ...found, head: found.head ?? null };
	}
}

export const lanes: Lanes = {
	lanes: { spec: ["faux/faux-1"], code: ["faux/faux-1"], review: ["faux/other-1"], judge: ["faux/other-1"] },
	aliases: { plan: "spec", test: "code", docs: "code", "pr-summary": "code", fix: "code", coordinate: "code", runtime: "review" },
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
	/** The spec writer first writes prose that breaks Simplified Technical English. */
	badSpec?: boolean;
	/** The coder also commits this file (path, content): to leak a secret, say. */
	coderFile?: [string, string];
	/** The coordinator: commit the file the pre-push hook wants, take a leaked file out of every unpushed commit, or give up. */
	coordinator?: "commit-fixed" | "remove-leak" | "give-up" | "verify-concurrency" | "finish-coder" | "remove-listed";
	/** The coder does the work but does not commit, and writes this into blocked.md. */
	coderGivesUp?: string;
	/** The coder also commits a change in this backend repo (its worktree comes from the Context line). */
	coderBackend?: string;

	/** Extra bash for the reviewer before it answers (e.g. an uncommitted change in the worktree). */
	reviewBash?: string;
	/** Extra bash for the docs writer before it answers (e.g. deleting a frozen test). */
	docsBash?: string;
	/** Extra bash for the PR summary writer before it answers (e.g. an uncommitted change in the worktree). */
	summaryBash?: string;
	/** The plan.md TEST_CMD line (the command that proves the tests are red). */
	testCmd?: string;
	/** The test writer leaves its test uncommitted: this bash replaces its commit. */
	testUncommitted?: string;
	/** The body of review-1.md (a test of the verdict rules). */
	reviewBody?: string;

	/** Raw content of judge.json (a test of the judge's parser). */
	judgeRaw?: string;
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
		// A change asked at the gate, sent to the agent that wrote the file (a later user message).
		const last = messages.at(-1);
		const asked = last?.role === "user" && last !== messages.find((m) => m.role === "user") ? text(last) : "";
		if (/asks for a change/.test(asked)) {
			const file = /Update RUN_DIR\/(spec|plan)\.md/.exec(asked)?.[1] ?? "spec";
			return write(`${run}/${file}.md`, file === "spec" ? "AC-1: it works\nAC-2: the list can be empty\nSTATUS: READY\n" : "plan: AC-1 -> ac1.test\nplan: AC-2 -> ac2.test\n");
		}
		if (/The spec changed/.test(asked)) return write(`${run}/plan.md`, "plan: AC-1 -> ac1.test\nplan: AC-2 -> ac2.test\n");
		// Blocked for Simplified Technical English: write it again, plainly.
		if (lastResult?.role === "toolResult" && lastResult.isError && /Simplified Technical English/.test(text(lastResult))) {
			return write(`${run}/spec.md`, "AC-1: it works\nSTATUS: READY\n");
		}
		// Like a real model: a call that was interrupted (the factory stopped) is made again, once.
		const interrupted = lastResult?.role === "toolResult" && lastResult.isError && /interrupt/i.test(text(lastResult));
		if (interrupted && prompt.includes("# Agent: coder") && !messages.some((m, i) => i < messages.length - 1 && m.role === "toolResult" && m.isError)) {
			behaviour.onInterrupted?.(text(lastResult));
			return bash(`echo code >> file.txt && git add file.txt && git commit -qm "code after restart"`);
		}
		if (acted) return done(`Done (${messages.filter((m) => m.role === "toolResult").length} tool results).`);
		if (prompt.includes("# Agent: spec writer")) {
			return write(`${run}/spec.md`, behaviour.badSpec ? "We are leveraging a robust approach in order to facilitate it.\nSTATUS: READY\n" : "AC-1: it works\nSTATUS: READY\n");
		}
		if (prompt.includes("# Agent: planner")) return write(`${run}/plan.md`, `plan: AC-1 -> ac1.test\n${behaviour.testCmd ? `TEST_CMD: ${behaviour.testCmd}\n` : ""}${behaviour.coderBackend ? `Repos: repo (form, list), ${behaviour.coderBackend} (field)\n` : ""}`);
		if (prompt.includes("# Agent: test writer")) {
			const tests = behaviour.testUncommitted ?? 'echo "test AC-1" > ac1.test && git add ac1.test && git commit -qm "test: AC-1 (red)"';
			return bash(`${tests} && echo "AC-1 -> ac1.test" > ${run}/tests.md`);
		}
		if (prompt.includes("# Agent: coder") && behaviour.coderGivesUp) {
			return bash(`echo code >> file.txt; echo ${JSON.stringify(behaviour.coderGivesUp)} > ${run}/blocked.md`);
		}
		if (prompt.includes("# Agent: coder")) {
			const escape = "{ git update-ref refs/heads/main HEAD; git branch other-ticket; git tag v-agent; } >" + `${run}/escape.log 2>&1;`;
			const leak = behaviour.coderFile ? `mkdir -p "$(dirname ${behaviour.coderFile[0]})" && printf '%s\\n' ${JSON.stringify(behaviour.coderFile[1])} > ${behaviour.coderFile[0]} && git add ${behaviour.coderFile[0]}; ` : "";
			const extra = (round === 1 && behaviour.coder ? `${behaviour.coder}; ` : "") + leak;
			const backend = behaviour.coderBackend ? new RegExp(`\\b${behaviour.coderBackend}=(\\S+)`).exec(prompt)?.[1] : undefined;
			const backendChange = backend ? `(cd ${backend} && echo api > api.txt && git add api.txt && git commit -qm "api: the field") >> ${run}/backend.log 2>&1; ` : "";
			const pause = behaviour.coderSleep ? `touch ${run}/coder-started; sleep ${behaviour.coderSleep}; ` : "";
			return bash(`${escape} ${extra}${backendChange}${pause}echo "port $PORT_BASE token \${CLICKUP_TOKEN:-none} $([ -f /.dockerenv ] && echo container || echo host)" > ${run}/cell.txt; echo code >> file.txt && git add file.txt && git commit -qm "code"`);
		}
		if (prompt.includes("# Agent: coordinator")) {
			const n = round;
			const report = (first: string, lesson: string) => `printf '%s\\n\\n%s\\n' ${JSON.stringify(first)} ${JSON.stringify(`LESSON: ${lesson}`)} > ${run}/repair-${n}.md`;
			if (behaviour.coordinator === "remove-listed") {
				const since = "$(grep -o 'SINCE[^:]*: [^ ]*' " + `${run}/failure-${n}.md | head -1 | sed 's/.*: //')`;
				const file = "$(grep -o '^- [^:]*: ' " + `${run}/failure-${n}.md | grep -v '^- [A-Z]' | head -1 | sed 's/^- //; s/: $//')`;
				return bash(`f=${file}; git reset -q --soft ${since} && git rm -q -r --cached "$f" && rm -rf "$f" && git commit -qm "code, without the build output" && ${report("Took the build output out of the commits.", "Never commit build output: it is not part of a change.")}`);
			}
			if (behaviour.coordinator === "finish-coder") {
				return bash(`git add file.txt && git commit -qm "code (the coordinator finished it)" && ${report("The coder lost its shell before it could commit; the work was done, so it is committed now.", "none")}`);
			}
			if (behaviour.coordinator === "verify-concurrency") {
				return bash(`printf '%s\\n\\nVERIFY: sh check.sh --concurrency=1\\nLESSON: %s\\n' "The check ran out of memory with every task at once; one at a time it finishes." "Run check.sh with --concurrency=1 in the sandbox." > ${run}/repair-${n}.md`);
			}
			if (behaviour.coordinator === "give-up") {
				return bash(`echo "develop already fails this check in another package: fix it there first" > ${run}/blocked.md; ${report("The base already fails the check; not this ticket's bug.", "none")}`);
			}
			if (behaviour.coordinator === "remove-leak") {
				const since = "$(grep -o 'SINCE[^:]*: [^ ]*' " + `${run}/failure-${n}.md | head -1 | sed 's/.*: //')`;
				return bash(`git reset -q --soft ${since} && git rm -q --cached leak.ts && rm -f leak.ts && git commit -qm "code without the leaked token" && ${report("Removed a hard-coded token from every unpushed commit.", "Read tokens from the environment, never from source.")}`);
			}
			return bash(`echo ok > fixed.txt && git add fixed.txt && git commit -qm "fix: the pre-push check" && ${report("The pre-push check wanted fixed.txt; added it.", "Run the pre-push checks before you finish.")}`);
		}
		if (prompt.includes("# Agent: docs writer")) return behaviour.docsBash
			? bash(`${behaviour.docsBash}; printf 'No docs change needed\\n' > ${run}/docs.md`)
			: write(`${run}/docs.md`, "No docs change needed\n");
		if (prompt.includes("# Agent: runtime checker")) return write(`${run}/runtime.md`, "Checked the form in the browser.\nVERDICT: PASS\n");
		if (prompt.includes("# Agent: PR summary")) return bash(`${behaviour.summaryBash ? `${behaviour.summaryBash}; ` : ""}echo "title ${round}" > ${run}/pr-title.txt && echo body > ${run}/pr-body.md`);
		if (prompt.includes("# Agent: code reviewer")) {
			// Round 1 also leaves an inline comment with a one-click suggestion (and one malformed entry the factory drops).
			const inline = round === 1 ? JSON.stringify([{ path: "file.txt", line: 1, body: "🔴 issue (blocking): **x**\n\n```suggestion\nfix\n```" }, { path: "file.txt" }]) : "[]";
			if (round === 1 && behaviour.reviewBody !== undefined) return bash(`${behaviour.reviewBash ? `${behaviour.reviewBash}; ` : ""}printf '%s' '${inline}' > ${run}/review-${round}.comments.json && printf '%b' ${JSON.stringify(behaviour.reviewBody)} > ${run}/review-${round}.md`);
			const verdict = round === 1 ? 'P1 x\nVERDICT: FIX\n' : 'VERDICT: PASS\n';
			return bash(`${behaviour.reviewBash ? `${behaviour.reviewBash}; ` : ""}printf '%s' '${inline}' > ${run}/review-${round}.comments.json && printf '${verdict}' > ${run}/review-${round}.md`);		}
		if (prompt.includes("# Agent: fixer")) return bash(`echo fix >> file.txt && git commit -qam "fix"`);
		if (prompt.includes("# Agent: judge")) {
			if (behaviour.judgeRaw !== undefined) return write(`${run}/judge.json`, behaviour.judgeRaw);
			return write(`${run}/judge.json`, JSON.stringify({ score: 4, summary: "done", criteria: [{ id: "AC-1", text: "it works", status: "met", evidence: "ac1.test" }], spec_gaps: [], hallucinations: [], out_of_scope: [], prompt_suggestions: [{ agent: "code", problem: "thin tests", suggestion: "run the full suite before you commit" }] }));
		}
		return done(`unknown agent: ${prompt.slice(0, 80)}`);
	};
	faux.setResponses(Array.from({ length: 400 }, () => route));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}

export const lastAssistant = (messages: readonly Message[]) => text(messages.findLast((m) => m.role === "assistant") as AssistantMessage | undefined);

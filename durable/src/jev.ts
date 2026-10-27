// Jev (the decision model of typesafe.ai) judges a ticket, and the factory decides. Ported from jroute.
// Jev never picks a model. It picks where each role starts in its chain (lanes.json). Jev is optional:
// no key, an error or a timeout gives null, and each chain starts at its first entry.
import { readFile } from "node:fs/promises";
import { redact } from "./secrets.ts";

export type JevAnswers = Record<string, { score?: number; confidence?: number; noul?: number; choice?: string } | undefined>;

export const JEV_QUESTIONS = {
	family: {
		type: "choice",
		instructions: "What kind of work is this?",
		criteria: {
			plan: "design, specification, or architecture of new work",
			implement: "execute an approved or well-specified change",
			debug: "diagnose a failure or unexpected behaviour",
			review: "audit or critique existing work",
			chore: "mechanical, repetitive, or trivial change",
		},
	},
	complexity: { type: "score", instructions: "How much reasoning does this task need?", criteria: ["trivial", "routine", "moderate", "hard", "frontier"] },
	consequence: {
		type: "noul",
		instructions: "Would a wrong answer here be expensive to undo, or does this touch high-risk ground such as production, security, money, or data loss?",
	},
	needs_design: { type: "noul", instructions: "Does this require design or specification decisions before code can be written, or is the approach already determined?" },
};

/**
 * One batched Jev call about the ticket text. JEV_FIXTURE replays a recorded response (tests, no key).
 * Only the ticket text leaves the machine, and each secret-shaped string in it is redacted.
 */
// shortcut: the Jev call does not go through the throttle or count toward spend, add it when Jev gets a price.
export async function askJev(text: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<JevAnswers | null> {
	try {
		if (env.JEV_FIXTURE) return answersOf(JSON.parse(await readFile(env.JEV_FIXTURE, "utf8")));
		const key = env.TYPESAFE_API_KEY;
		if (!key) return null;
		const res = await fetch(env.JEV_URL || "https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: env.JEV_MODEL || "jev-1.13.0", state: redact(text).text, questions: JEV_QUESTIONS }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? answersOf(await res.json()) : null;
	} catch {
		return null;
	}
}

const answersOf = (response: unknown): JevAnswers | null => {
	const answers = (response as { answers?: unknown } | null)?.answers;
	return answers !== null && typeof answers === "object" ? (answers as JevAnswers) : null;
};

const noul = (answers: JevAnswers, name: string) => answers[name]?.noul ?? 0;

/** The complexity from Jev, one up when Jev is unsure: a model too weak costs a failed attempt. */
function complexity(answers: JevAnswers): number | null {
	const score = answers.complexity?.score;
	return typeof score === "number" ? score + ((answers.complexity?.confidence ?? 0) < 0.6 ? 1 : 0) : null;
}

/** The jroute rule: routine work starts at entry 0, moderate work at entry 1, hard or risky work at entry 2. */
export function startIndex(answers: JevAnswers | null): number {
	const c = answers === null ? null : complexity(answers);
	if (c === null) return 0;
	if (c >= 3 || noul(answers!, "consequence") > 0.7) return 2;
	return c >= 2 ? 1 : 0;
}

/** One line for the timeline: what Jev said. */
export function describe(answers: JevAnswers): string {
	const c = complexity(answers);
	return [answers.family?.choice, c === null ? null : `complexity ${c}`, `consequence ${noul(answers, "consequence").toFixed(2)}`].filter(Boolean).join(", ");
}

// Which model each agent role runs on: an ordered chain per role, preferred first (durable/lanes.json).
// A step whose model fails moves to the next model in its chain. The reviewer and the judge never use
// the coder's model family, so code is never graded by its author (router.py's rule).
import { readFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Lanes = { lanes: Record<string, string[]>; aliases: Record<string, string> };

export async function loadLanes(path: string): Promise<Lanes> {
	const raw = JSON.parse(await readFile(path, "utf8")) as Partial<Lanes>;
	const lanes = raw.lanes ?? {};
	const aliases = raw.aliases ?? {};
	for (const [role, chain] of Object.entries(lanes)) {
		if (!Array.isArray(chain) || chain.some((m) => typeof m !== "string" || parseModel(m) === null)) {
			throw new Error(`${path}: lanes.${role} must be a list of "<provider>/<model>"`);
		}
	}
	for (const [role, target] of Object.entries(aliases)) {
		if (!(target in lanes)) throw new Error(`${path}: aliases.${role} names no lane "${target}"`);
	}
	return { lanes, aliases };
}

export function parseModel(entry: string): ModelRef | null {
	const slash = entry.indexOf("/");
	return slash > 0 && slash < entry.length - 1 ? { provider: entry.slice(0, slash), modelId: entry.slice(slash + 1) } : null;
}

export const modelName = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/** 'claude-opus-5-5' -> 'claude', 'gpt-6.1-sol' -> 'gpt', 'glm-5.3' -> 'glm'. */
export const family = (model: ModelRef) => (model.modelId.split("/").at(-1) ?? "").split(/[-.]/)[0]!.toLowerCase();

export function chain(lanes: Lanes, role: string): ModelRef[] {
	const lane = lanes.lanes[role] ?? lanes.lanes[lanes.aliases[role] ?? ""] ?? [];
	return lane.map((entry) => parseModel(entry)!);
}

/**
 * The model for a step's attempt N (1-based): the Nth usable entry of its chain. Usable: known to
 * pi-ai, with a login (an API key), and not the coder's family for review and judge.
 */
export async function pickModel(options: {
	lanes: Lanes;
	models: Models;
	role: string;
	attempt: number;
	avoidFamily: string | null;
	skip: (model: ModelRef) => string | null;
}): Promise<{ model: ModelRef | null; skipped: string[] }> {
	const skipped: string[] = [];
	let usable = 0;
	for (const model of chain(options.lanes, options.role)) {
		const why =
			options.models.getModel(model.provider, model.modelId) === undefined
				? "unknown to pi-ai"
				: (await options.models.getAuth(model.provider)) === undefined
					? `no login for ${model.provider}`
					: options.avoidFamily !== null && family(model) === options.avoidFamily
						? "same family as the coder"
						: options.skip(model);
		if (why !== null) {
			skipped.push(`${modelName(model)}: ${why}`);
			continue;
		}
		usable++;
		if (usable === options.attempt) return { model, skipped };
	}
	return { model: null, skipped };
}

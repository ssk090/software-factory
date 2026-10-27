// Which model each agent role runs on: an ordered chain per role, preferred first (durable/lanes.json).
// A step whose model fails moves to the next model in its chain. The reviewer and the judge never use
// the coder's model family, so code is never graded by its author.
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Lanes = { lanes: Record<string, string[]>; aliases: Record<string, string> };

export async function loadLanes(path: string): Promise<Lanes> {
	return checkLanes(JSON.parse(await readFile(path, "utf8")) as Partial<Lanes>, path);
}

/** The lanes in `raw`, or an error that names the bad entry. */
export function checkLanes(raw: Partial<Lanes>, path: string): Lanes {
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

/** Write the lanes atomically (a temp file, then rename), and keep the file's `_help`. */
export async function saveLanes(path: string, lanes: Lanes): Promise<void> {
	const help = await readFile(path, "utf8").then((t) => (JSON.parse(t) as { _help?: string })._help, () => undefined);
	await writeFile(`${path}.tmp`, `${JSON.stringify({ _help: help, ...lanes }, null, "\t")}\n`);
	await rename(`${path}.tmp`, path);
}

/**
 * The lanes with `model` first in the role's chain (the rest stay as fallbacks, in order). An alias
 * role gets its own lane, a copy of its target's chain. `model` null: an alias role goes back to
 * `resetTo`'s lane.
 */
export function setModel(lanes: Lanes, role: string, model: string | null, resetTo?: string): Lanes {
	const next: Lanes = { lanes: { ...lanes.lanes }, aliases: { ...lanes.aliases } };
	if (model === null) {
		if (resetTo === undefined || !(resetTo in next.lanes) || resetTo === role) throw new Error(`no lane "${resetTo}" to reset ${role} to`);
		delete next.lanes[role];
		next.aliases[role] = resetTo;
		return next;
	}
	if (parseModel(model) === null) throw new Error(`"${model}" is not "<provider>/<model>"`);
	const current = chain(lanes, role).map(modelName);
	next.lanes[role] = [model, ...current.filter((m) => m !== model)];
	delete next.aliases[role];
	return next;
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
	/** Where the chain starts (Jev's routing): the Nth usable entry, or the last usable one. */
	start?: number;
}): Promise<{ model: ModelRef | null; skipped: string[] }> {
	const entries: { model: ModelRef; why: string | null }[] = [];
	for (const model of chain(options.lanes, options.role)) {
		const why =
			options.models.getModel(model.provider, model.modelId) === undefined
				? "unknown to pi-ai"
				: (await options.models.getAuth(model.provider)) === undefined
					? `no login for ${model.provider}`
					: options.avoidFamily !== null && family(model) === options.avoidFamily
						? "same family as the coder"
						: options.skip(model);
		entries.push({ model, why });
	}
	const usable = entries.filter((e) => e.why === null);
	const picked = usable[Math.max(0, Math.min(options.start ?? 0, usable.length - 1)) + options.attempt - 1];
	// Only the models passed over on the way to the pick are news (all of them when none is left).
	const before = picked === undefined ? entries : entries.slice(0, entries.indexOf(picked));
	return { model: picked?.model ?? null, skipped: before.flatMap((e) => (e.why === null ? [] : [`${modelName(e.model)}: ${e.why}`])) };
}

/** Every role in the lanes: each lane and each alias. */
export const roles = (lanes: Lanes) => [...new Set([...Object.keys(lanes.lanes), ...Object.keys(lanes.aliases)])];

/** A ticket's own choice of model for a role, from the dashboard: put first in the role's chain. */
export const withOverrides = (lanes: Lanes, overrides: Record<string, string> = {}) =>
	Object.entries(overrides).reduce((next, [role, model]) => setModel(next, role, model), lanes);

/**
 * The model each role of a ticket starts on: the ticket's own choice, else the entry Jev's
 * start points at, else the first usable entry. The run applies the family rule on top.
 */
export async function plannedModels(options: { lanes: Lanes; models: Models; overrides?: Record<string, string>; start?: number }) {
	const lanes = withOverrides(options.lanes, options.overrides);
	const out: { role: string; model: string | null; source: "you" | "jev" | "default" }[] = [];
	for (const role of roles(options.lanes)) {
		const own = options.overrides?.[role] !== undefined;
		const start = own ? 0 : (options.start ?? 0);
		const { model } = await pickModel({ lanes, models: options.models, role, attempt: 1, avoidFamily: null, skip: () => null, start });
		out.push({ role, model: model && modelName(model), source: own ? "you" : start > 0 ? "jev" : "default" });
	}
	return out;
}

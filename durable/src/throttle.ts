// Rate limits and a daily budget for the model API keys. Every model request of every agent step
// goes through here: pi-durable asks Models.streamSimple for a turn and Models.completeSimple for a
// compaction, and the factory hands the harness these two wrapped. A request waits until its
// provider (one API key each) has room in its requests-per-minute and tokens-per-minute window, while
// today's spend is at the budget, and while its ticket is paused. Spend is kept per day in
// state/usage.json, so a restart does not reset it.
import { readFile, rename, writeFile } from "node:fs/promises";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model, type Models, type Usage } from "@earendil-works/pi-ai";

export type Limits = { readonly rpm: number; readonly tpm: number; readonly dailyBudgetUsd: number };
export type Spend = { requests: number; tokens: number; cost: number };
/** One local day of model use, in total and per provider. */
export type Ledger = { day: string; total: Spend; providers: Record<string, Spend> };
/** A request held back, and why. */
export type Waiting = { provider: string; reason: string; since: number };
export type ThrottleStatus = { limits: Limits; today: Ledger; waiting: Waiting[]; budgetReached: boolean };

type Slot = { provider: string; at: number; tokens: number };
type ThrottleOptions = {
	/** Where today's spend is kept (null: memory only). */
	file: string | null;
	now?: () => number;
	/** The rate window (default a minute; tests use less). */
	windowMs?: number;
	/** How often a held request looks again (default 1 s). */
	pollMs?: number;
	/** Why a request of this provider session must wait (its ticket is paused), or null. */
	hold?: (sessionId: string | undefined) => Promise<string | null>;
};

const zero = (): Spend => ({ requests: 0, tokens: 0, cost: 0 });
/** The local calendar day: the budget starts again at midnight on this machine. */
export const dayOf = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, Math.max(10, ms));
		signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
	});

/** The final message of a request that failed here: aborted while it waited, or broke while forwarded. */
function failed(model: Model<Api>, reason: "aborted" | "error", error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export class Throttle {
	readonly limits: Limits;
	private readonly options: ThrottleOptions;
	private ledger: Ledger;
	/** Requests of the current window, per provider; their tokens once they answered. */
	private readonly recent = new Map<string, Slot[]>();
	private readonly waiting = new Set<Waiting>();
	private saving: Promise<void> = Promise.resolve();

	private constructor(limits: Limits, options: ThrottleOptions) {
		this.limits = limits;
		this.options = options;
		this.ledger = { day: dayOf(this.now()), total: zero(), providers: {} };
	}

	static async open(limits: Limits, options: ThrottleOptions): Promise<Throttle> {
		const throttle = new Throttle(limits, options);
		if (options.file !== null) {
			const saved = await readFile(options.file, "utf8").then((t) => JSON.parse(t) as Ledger, () => null);
			if (saved?.day === throttle.ledger.day && saved.total !== undefined) throttle.ledger = saved;
		}
		return throttle;
	}

	private now() {
		return (this.options.now ?? Date.now)();
	}
	private get windowMs() {
		return this.options.windowMs ?? 60_000;
	}

	/** Today's ledger: a new day starts empty. */
	private today(): Ledger {
		const day = dayOf(this.now());
		if (this.ledger.day !== day) this.ledger = { day, total: zero(), providers: {} };
		return this.ledger;
	}

	budgetReached(): boolean {
		return this.limits.dailyBudgetUsd > 0 && this.today().total.cost >= this.limits.dailyBudgetUsd;
	}

	budgetText(): string {
		return `daily budget reached: ${usd(this.today().total.cost)} of ${usd(this.limits.dailyBudgetUsd)} spent today`;
	}

	status(): ThrottleStatus {
		return { limits: this.limits, today: structuredClone(this.today()), waiting: [...this.waiting].map((w) => ({ ...w })), budgetReached: this.budgetReached() };
	}

	/** The provider's requests of the current window, older ones dropped. */
	private window(provider: string): Slot[] {
		const since = this.now() - this.windowMs;
		const slots = (this.recent.get(provider) ?? []).filter((s) => s.at > since);
		this.recent.set(provider, slots);
		return slots;
	}

	/** Why a request must wait now, and for how long at most; null when it may go. */
	private async why(provider: string, sessionId: string | undefined): Promise<{ text: string; retryIn: number } | null> {
		const poll = this.options.pollMs ?? 1000;
		const held = (await this.options.hold?.(sessionId)) ?? null;
		if (held !== null) return { text: held, retryIn: poll };
		if (this.budgetReached()) return { text: this.budgetText(), retryIn: poll };
		const slots = this.window(provider);
		if (this.limits.rpm > 0 && slots.length >= this.limits.rpm) {
			return { text: `rate limit: ${this.limits.rpm} requests a minute to ${provider}`, retryIn: slots[0]!.at + this.windowMs - this.now() };
		}
		if (this.limits.tpm > 0 && slots.reduce((n, s) => n + s.tokens, 0) >= this.limits.tpm) {
			return { text: `rate limit: ${this.limits.tpm} tokens a minute to ${provider}`, retryIn: slots[0]!.at + this.windowMs - this.now() };
		}
		return null;
	}

	/** Wait until a request to `provider` may go, then count it. Rejects when `signal` aborts. */
	async admit(provider: string, sessionId?: string, signal?: AbortSignal): Promise<Slot> {
		let entry: Waiting | null = null;
		try {
			for (;;) {
				signal?.throwIfAborted();
				const reason = await this.why(provider, sessionId);
				if (reason === null) break;
				if (entry === null) {
					entry = { provider, reason: reason.text, since: this.now() };
					this.waiting.add(entry);
				} else entry.reason = reason.text;
				await sleep(Math.min(reason.retryIn, this.options.pollMs ?? 1000), signal);
			}
		} finally {
			if (entry !== null) this.waiting.delete(entry);
		}
		const slot: Slot = { provider, at: this.now(), tokens: 0 };
		this.window(provider).push(slot);
		const today = this.today();
		today.total.requests++;
		(today.providers[provider] ??= zero()).requests++;
		return slot;
	}

	/** Count what a request used: its tokens toward the minute, its tokens and cost toward today. */
	record(slot: Slot, usage: Usage | undefined): void {
		if (usage === undefined) return;
		slot.tokens = usage.totalTokens;
		const today = this.today();
		for (const spend of [today.total, (today.providers[slot.provider] ??= zero())]) {
			spend.tokens += usage.totalTokens;
			spend.cost += usage.cost.total;
		}
		this.save();
	}

	/** Write today's ledger, one write at a time, atomically (a crash keeps the last whole one). */
	private save(): void {
		const file = this.options.file;
		if (file === null) return;
		this.saving = this.saving
			.then(async () => {
				await writeFile(`${file}.tmp`, JSON.stringify(this.ledger));
				await rename(`${file}.tmp`, file);
			})
			.catch(() => undefined);
	}

	async flush(): Promise<void> {
		await this.saving;
	}

	/** `models` with its two request paths throttled; everything else passes through. */
	wrap(models: Models): Models {
		const throttle = this;
		const streamSimple: Models["streamSimple"] = (model, context, options) => {
			const out = createAssistantMessageEventStream();
			void (async () => {
				let slot: Slot;
				try {
					slot = await throttle.admit(model.provider, options?.sessionId, options?.signal);
				} catch (error) {
					out.push({ type: "error", reason: "aborted", error: failed(model, "aborted", error) });
					out.end();
					return;
				}
				try {
					const inner = models.streamSimple(model, context, options);
					for await (const event of inner) out.push(event);
					const message = await inner.result();
					throttle.record(slot, message.usage);
					out.end(message);
				} catch (error) {
					// Providers report failures as events; this is only a safety net so the turn always ends.
					out.push({ type: "error", reason: "error", error: failed(model, "error", error) });
					out.end();
				}
			})();
			return out;
		};
		const completeSimple: Models["completeSimple"] = async (model, context, options) => {
			const slot = await throttle.admit(model.provider, options?.sessionId, options?.signal);
			const message = await models.completeSimple(model, context, options);
			throttle.record(slot, message.usage);
			return message;
		};
		return new Proxy(models, {
			get(target, prop) {
				if (prop === "streamSimple") return streamSimple;
				if (prop === "completeSimple") return completeSimple;
				const value = Reflect.get(target, prop, target) as unknown;
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		});
	}
}

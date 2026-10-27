// Live performance for the dashboard's Performance page: this process's CPU and memory, the
// machine's CPU and load, event loop lag, running agents, model token rates and first-token time.
// The server samples once a second, so the page can refresh slower than that without gaps.
import { cpus, freemem, loadavg, totalmem } from "node:os";

export type ModelUse = {
	/** When the request ended. */
	at: number;
	provider: string;
	model: string;
	/** The provider session of the step that asked, when the caller named one. */
	sessionId?: string;
	/** Time from the request to its first text, thinking or tool-call token. */
	ttftMs: number | null;
	input: number;
	output: number;
	tokens: number;
	cost: number;
};

export type PerfSample = {
	t: number;
	/** This process, percent of one core. */
	cpu: number;
	/** The machine, percent of all cores. */
	sys: number;
	/** Process RSS, MB. */
	rss: number;
	/** Process heap in use, MB. */
	heap: number;
	/** How late the sampler ran, ms: the event loop was busy for that long. */
	lag: number;
	agents: number;
	queued: number;
};

/** One point of the graph: a sample plus the model rates over the minute before it. */
export type PerfPoint = PerfSample & {
	/** Output tokens a second, over the last minute. */
	tout: number;
	/** Input tokens a second, over the last minute. */
	tin: number;
	/** Model requests a minute, over the last minute. */
	reqs: number;
	/** The last first-token time seen in the last minute, ms. */
	ttft: number | null;
};

export type PerfNow = PerfSample & {
	cores: number;
	load: number[];
	memUsed: number;
	memTotal: number;
};

export type TtftSummary = { last: number | null; p50: number | null; p95: number | null; count: number };
export type PerfSnapshot = {
	now: PerfNow;
	points: PerfPoint[];
	summary: { ttft: TtftSummary };
};

/** Samples kept: five minutes at one a second. */
export const MAX_SAMPLES = 300;
/** Model uses kept: enough for the rates of every sample, bounded. */
const MAX_USES = 4000;
/** The window of the token and first-token rates. */
export const RATE_MS = 60_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** `value` at `p` (0 to 1) of the sorted values, by the nearest rank. */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** This process's CPU over `elapsedMs`, percent of one core (a multi-threaded process can pass 100). */
export function processCpuPercent(prev: { user: number; system: number }, next: { user: number; system: number }, elapsedMs: number): number {
	if (elapsedMs <= 0) return 0;
	return round1((((next.user - prev.user) + (next.system - prev.system)) / 1000 / elapsedMs) * 100);
}

/** The machine's CPU from two readings of the cores' cumulative times, percent of all cores. */
export function systemCpuPercent(prev: { idle: number; total: number }, next: { idle: number; total: number }): number {
	const total = next.total - prev.total;
	const idle = next.idle - prev.idle;
	return total <= 0 ? 0 : round1((1 - idle / total) * 100);
}

export function ttftSummary(uses: readonly ModelUse[], now: number): TtftSummary {
	const recent = uses.filter((u) => u.at > now - RATE_MS);
	const values = recent.flatMap((u) => (u.ttftMs === null ? [] : [u.ttftMs]));
	let last: number | null = null;
	let lastAt = -Infinity;
	for (const use of recent) {
		if (use.ttftMs === null || use.at < lastAt) continue;
		lastAt = use.at;
		last = use.ttftMs;
	}
	const p50 = percentile(values, 0.5);
	const p95 = percentile(values, 0.95);
	return { last: last === null ? null : round1(last), p50: p50 === null ? null : round1(p50), p95: p95 === null ? null : round1(p95), count: values.length };
}

const emptySample = (t: number): PerfSample => ({ t, cpu: 0, sys: 0, rss: 0, heap: 0, lag: 0, agents: 0, queued: 0 });

export class Metrics {
	private readonly now: () => number;
	private readonly sampleMs: number;
	private readonly readCpu: () => { user: number; system: number };
	private readonly readSystem: () => { idle: number; total: number };
	private readonly readMemory: () => NodeJS.MemoryUsage;
	private timer: ReturnType<typeof setInterval> | null = null;
	private samples: PerfSample[] = [];
	private uses: ModelUse[] = [];
	private agents = 0;
	private queued = 0;
	private prevCpu = { user: 0, system: 0 };
	private prevSystem = { idle: 0, total: 0 };
	private prevAt = 0;
	private expected = 0;
	private lag = 0;

	constructor(options: { now?: () => number; sampleMs?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.sampleMs = options.sampleMs ?? 1000;
		this.readCpu = () => process.cpuUsage();
		this.readSystem = readSystemCpu;
		this.readMemory = () => process.memoryUsage();
	}

	start(): void {
		if (this.timer !== null) return;
		this.prevCpu = this.readCpu();
		this.prevSystem = this.readSystem();
		this.prevAt = this.now();
		this.expected = this.prevAt + this.sampleMs;
		this.timer = setInterval(() => this.tick(), this.sampleMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** Record one model request; the dashboard draws its tokens and first-token time. */
	use(use: ModelUse): void {
		this.uses.push(use);
		if (this.uses.length > MAX_USES) this.uses.splice(0, this.uses.length - MAX_USES);
	}

	/** The agents running and the tickets waiting for a slot, as the last overview found them. */
	observe(agents: number, queued: number): void {
		this.agents = agents;
		this.queued = queued;
	}

	/** One step's requests and first-token time in the current window, by its provider session. */
	session(sessionId: string): { requests: number; ttft: number | null } {
		const uses = this.uses.filter((u) => u.sessionId === sessionId);
		const values = uses.flatMap((u) => (u.ttftMs === null ? [] : [u.ttftMs]));
		return { requests: uses.length, ttft: values.length === 0 ? null : round1(average(values)) };
	}

	snapshot(): PerfSnapshot {
		const now = this.now();
		const last = this.samples.at(-1) ?? emptySample(now);
		const memory = this.readMemory();
		const points = this.points();
		const latest = points.at(-1);
		if (latest !== undefined) {
			latest.agents = this.agents;
			latest.queued = this.queued;
		}
		const total = totalmem();
		return {
			now: {
				...last,
				rss: round1(memory.rss / 1e6),
				heap: round1(memory.heapUsed / 1e6),
				agents: this.agents,
				queued: this.queued,
				cores: Math.max(1, cpus().length),
				load: loadavg().map(round1),
				memUsed: total - freemem(),
				memTotal: total,
			},
			points,
			summary: { ttft: ttftSummary(this.uses, now) },
		};
	}

	private tick(): void {
		const at = this.now();
		this.lag = Math.max(0, at - this.expected);
		this.expected = at + this.sampleMs;
		this.sample(at);
	}

	private sample(at: number): void {
		const cpu = this.readCpu();
		const system = this.readSystem();
		const elapsed = at - this.prevAt;
		const memory = this.readMemory();
		this.samples.push({
			t: at,
			cpu: processCpuPercent(this.prevCpu, cpu, elapsed),
			sys: systemCpuPercent(this.prevSystem, system),
			rss: round1(memory.rss / 1e6),
			heap: round1(memory.heapUsed / 1e6),
			lag: round1(this.lag),
			agents: this.agents,
			queued: this.queued,
		});
		if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
		this.prevCpu = cpu;
		this.prevSystem = system;
		this.prevAt = at;
	}

	/** The samples with the model rates over the minute before each one. */
	private points(): PerfPoint[] {
		return ratePoints(this.samples, this.uses);
	}
}

/** The samples with the token, request and first-token rates over the minute before each one. */
export function ratePoints(samples: readonly PerfSample[], uses: readonly ModelUse[]): PerfPoint[] {
	return samples.map((sample) => {
		const from = sample.t - RATE_MS;
		let tin = 0;
		let tout = 0;
		let reqs = 0;
		let ttft: number | null = null;
		let lastAt = -Infinity;
		for (const use of uses) {
			if (use.at > sample.t) continue;
			if (use.at > from) {
				tin += use.input;
				tout += use.output;
				reqs++;
			}
			if (use.ttftMs !== null && use.at > lastAt) {
				lastAt = use.at;
				ttft = round1(use.ttftMs);
			}
		}
		// An old first-token time says nothing about now: leave a gap after a minute without a request.
		if (lastAt < from) ttft = null;
		const seconds = RATE_MS / 1000;
		return { ...sample, tin: round1(tin / seconds), tout: round1(tout / seconds), reqs: round1((reqs / seconds) * 60), ttft };
	});
}

/** All cores' cumulative times: for the machine's CPU between two readings. */
export function readSystemCpu(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

// The Performance page's numbers: CPU percentages, first-token summaries and the per-second rates.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ModelUse, type PerfSample, percentile, processCpuPercent, ratePoints, systemCpuPercent, ttftSummary } from "../src/metrics.ts";

const use = (extra: Partial<ModelUse> = {}): ModelUse => ({
	at: 10_000, provider: "p", model: "m", ttftMs: 100, input: 900, output: 100, tokens: 1000, cost: 0.01, ...extra,
});
const sample = (t: number): PerfSample => ({ t, cpu: 0, sys: 0, rss: 0, heap: 0, lag: 0, agents: 0, queued: 0 });

describe("metrics", () => {
	it("turns process and machine CPU time into percentages", () => {
		assert.equal(processCpuPercent({ user: 0, system: 0 }, { user: 500_000, system: 0 }, 1000), 50);
		assert.equal(processCpuPercent({ user: 0, system: 0 }, { user: 1_500_000, system: 0 }, 1000), 150, "threads can pass one core");
		assert.equal(processCpuPercent({ user: 0, system: 0 }, { user: 1_000, system: 0 }, 0), 0);
		assert.equal(systemCpuPercent({ idle: 100, total: 200 }, { idle: 200, total: 400 }), 50);
		assert.equal(systemCpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 0 }), 0);
	});

	it("summarises the first-token time of the last minute", () => {
		const now = 70_000;
		const s = ttftSummary([use({ at: now - 50_000, ttftMs: 100 }), use({ at: now - 20_000, ttftMs: 300 }), use({ at: now - 10_000, ttftMs: 200 }), use({ at: now - 90_000, ttftMs: 9999 })], now);
		assert.equal(s.count, 3, "an older request is not in the last minute");
		assert.equal(s.last, 200);
		assert.equal(s.p50, 200);
		assert.equal(s.p95, 300);
		assert.equal(ttftSummary([use({ at: now - 1000, ttftMs: null })], now).last, null, "a failed request has no first token");
		assert.equal(percentile([], 0.5), null);
		assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
	});

	it("rates tokens and first-token time over the minute before each sample", () => {
		const points = ratePoints([sample(0), sample(10_000), sample(70_000), sample(80_000)], [use({ at: 5_000, input: 600, output: 60, ttftMs: 100 }), use({ at: 50_000, input: 600, output: 60, ttftMs: 300 })]);
		assert.deepEqual(points.map((p) => [p.tin, p.tout, p.reqs]), [[0, 0, 0], [10, 1, 1], [10, 1, 1], [10, 1, 1]], "tokens a second and requests a minute over the last minute");
		assert.equal(points[0]!.ttft, null);
		assert.equal(points[1]!.ttft, 100);
		assert.equal(points[2]!.ttft, 300, "the newest request wins");
		assert.equal(points[3]!.ttft, 300);
	});

	it("forgets a first-token time after a minute without a request", () => {
		const points = ratePoints([sample(0), sample(59_000), sample(61_000), sample(121_000)], [use({ at: 1000, ttftMs: 250 })]);
		assert.equal(points[1]!.ttft, 250);
		assert.equal(points[2]!.ttft, 250);
		assert.equal(points[3]!.ttft, null, "no request in the last minute");
	});
});

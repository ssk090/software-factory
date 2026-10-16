// The throttle: rate windows, the daily budget and its ledger, holds for paused tickets, and the
// wrapped Models that every model request goes through.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { dayOf, Throttle } from "../src/throttle.ts";

const usage = (tokens: number, cost: number): Usage => ({
	input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const limits = (extra: Partial<{ rpm: number; tpm: number; dailyBudgetUsd: number }> = {}) => ({ rpm: 0, tpm: 0, dailyBudgetUsd: 0, ...extra });

describe("throttle", { timeout: 30_000 }, () => {
	it("holds a request until the provider has room in its requests-per-minute window", async () => {
		const t = await Throttle.open(limits({ rpm: 2 }), { file: null, windowMs: 300, pollMs: 20 });
		const start = Date.now();
		await t.admit("anthropic");
		await t.admit("anthropic");
		await t.admit("openai"); // another key: its own window
		assert.ok(Date.now() - start < 100, "within the limit nothing waits");
		const third = t.admit("anthropic");
		await new Promise((r) => setTimeout(r, 50));
		assert.match(t.status().waiting[0]?.reason ?? "", /2 requests a minute to anthropic/);
		await third;
		assert.ok(Date.now() - start >= 250, "the third waited for the window");
		assert.equal(t.status().waiting.length, 0);
		assert.equal(t.status().today.total.requests, 4);
	});

	it("holds a request while the minute's tokens are spent", async () => {
		const t = await Throttle.open(limits({ tpm: 1000 }), { file: null, windowMs: 200, pollMs: 20 });
		t.record(await t.admit("anthropic"), usage(1200, 0.01));
		const start = Date.now();
		await t.admit("anthropic");
		assert.ok(Date.now() - start >= 150, "waited for the window to pass");
	});

	it("keeps today's spend in a file, stops at the budget, and starts again the next day", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-throttle-"));
		try {
			let now = new Date(2026, 9, 17, 12).getTime();
			const file = join(dir, "usage.json");
			const t = await Throttle.open(limits({ dailyBudgetUsd: 1 }), { file, now: () => now, pollMs: 20 });
			t.record(await t.admit("anthropic"), usage(5000, 0.6));
			assert.equal(t.budgetReached(), false);
			t.record(await t.admit("anthropic"), usage(5000, 0.5));
			assert.equal(t.budgetReached(), true);
			assert.match(t.budgetText(), /\$1\.10 of \$1\.00/);
			await t.flush();
			const saved = JSON.parse(await readFile(file, "utf8"));
			assert.equal(saved.day, dayOf(now));
			assert.equal(saved.providers.anthropic.requests, 2);
			// A restart reads it back.
			const again = await Throttle.open(limits({ dailyBudgetUsd: 1 }), { file, now: () => now, pollMs: 20 });
			assert.equal(again.budgetReached(), true);
			// Over the budget a request waits; aborting it rejects.
			const controller = new AbortController();
			const held = again.admit("anthropic", undefined, controller.signal);
			await new Promise((r) => setTimeout(r, 60));
			assert.match(again.status().waiting[0]?.reason ?? "", /daily budget reached/);
			controller.abort(new Error("stopped"));
			await assert.rejects(held, /stopped/);
			// Midnight: a new day, a new budget.
			now += 24 * 3600_000;
			assert.equal(again.budgetReached(), false);
			assert.equal(again.status().today.total.cost, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("holds a paused ticket's request until it continues", async () => {
		let paused = true;
		const t = await Throttle.open(limits(), { file: null, pollMs: 20, hold: async (session) => (session === "s-1" && paused ? "T-1 is paused" : null) });
		await t.admit("anthropic", "s-2"); // another ticket's step goes
		let went = false;
		const held = t.admit("anthropic", "s-1").then(() => (went = true));
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(went, false);
		assert.equal(t.status().waiting[0]?.reason, "T-1 is paused");
		paused = false;
		await held;
		assert.equal(went, true);
	});

	it("wraps Models: requests pass through and are counted, and a held request ends as aborted when its run stops", async () => {
		const faux = fauxProvider({ models: [{ id: "faux-1" }] });
		faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("hello")));
		const models = createModels();
		models.setProvider(faux.provider);
		let paused = false;
		const t = await Throttle.open(limits(), { file: null, pollMs: 20, hold: async () => (paused ? "paused" : null) });
		const wrapped = t.wrap(models);
		const model = wrapped.getModel("faux", "faux-1")!;
		assert.ok(model, "everything else passes through");
		const answer = await wrapped.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }).result();
		assert.equal(answer.stopReason, "stop");
		assert.equal(t.status().today.total.requests, 1);
		paused = true;
		const controller = new AbortController();
		const stream = wrapped.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 60));
		controller.abort();
		const aborted = await stream.result();
		assert.equal(aborted.stopReason, "aborted");
		assert.equal(t.status().today.total.requests, 1, "the held request never went out");
	});
});

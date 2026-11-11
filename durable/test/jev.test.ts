// Jev: the line the timeline shows, and what leaves the machine with the ticket text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askJev, describe as describeAnswers, startIndex } from "../src/jev.ts";

const token = `sk-proj-${"a1B2c3D4".repeat(4)}`;

describe("jev", () => {
	it("says in one line what Jev answered, and nothing when it did not", () => {
		assert.equal(
			describeAnswers({ family: { choice: "debug" }, complexity: { score: 2, confidence: 0.9 }, consequence: { noul: 0.81 } }),
			"debug, complexity 2, consequence 0.81",
		);
		assert.equal(describeAnswers({}), "");
	});

	it("sends the ticket with its secrets redacted, and reads the answers", async () => {
		const real = globalThis.fetch;
		const sent: { body: { state?: string }; auth: string }[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			sent.push({ body: JSON.parse(String(init.body)) as { state?: string }, auth: headers.Authorization! });
			return new Response(JSON.stringify({ answers: { complexity: { score: 2, confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		try {
			const answers = await askJev(`Debug ${token} on PROJ-1`, { TYPESAFE_API_KEY: "key-123", JEV_URL: "https://jev.test/one" });
			assert.equal(answers?.complexity?.score, 2);
			assert.equal(startIndex(answers), 1);
		} finally {
			globalThis.fetch = real;
		}
		assert.equal(sent[0]!.auth, "Bearer key-123");
		assert.equal(sent[0]!.body.state, "Debug [redacted] on PROJ-1", "no secret leaves the machine");
	});

	it("is silent when the call is refused or the network is down", async () => {
		const real = globalThis.fetch;
		try {
			globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
			assert.equal(await askJev("a ticket", { TYPESAFE_API_KEY: "key-123" }), null);
			globalThis.fetch = (async () => {
				throw new Error("offline");
			}) as typeof fetch;
			assert.equal(await askJev("a ticket", { TYPESAFE_API_KEY: "key-123" }), null);
		} finally {
			globalThis.fetch = real;
		}
	});
});

// Sentry and ClickUp intake: paging, merging a sync into the inbox, ranking, the ticket body, and the
// current sprint; then the durable sync loop and "Fix this" through the factory.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Issue } from "../src/docs.ts";
import { Factory } from "../src/host.ts";
import { mergeSync, nextPage, type SentryApi, type SentryIssue, score, ticketFor } from "../src/sentry.ts";
import { pickSprint } from "../src/tracker.ts";
import { FakeGitHost, FakeTracker, fauxAgents, lanes, scratchRepo, testConfig } from "./support.ts";

const raw = (id: string, extra: Partial<SentryIssue> = {}): SentryIssue => ({
	id,
	shortId: `WEB-${id}`,
	title: `TypeError ${id}`,
	culprit: "app/page.tsx",
	level: "error",
	status: "unresolved",
	priority: "high",
	count: "120",
	userCount: 30,
	firstSeen: "2026-10-01T00:00:00Z",
	lastSeen: new Date().toISOString(),
	permalink: `https://sentry.io/issues/${id}/`,
	project: { slug: "web" },
	...extra,
});

describe("sentry", () => {
	it("follows the Link header only while the next page has results", () => {
		const link = '<https://sentry.io/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
		assert.equal(nextPage(link), "https://sentry.io/api/0/x/?cursor=0:100:0");
		assert.equal(nextPage(link.replace('results="true"', 'results="false"')), null);
		assert.equal(nextPage(null), null);
	});

	it("merges a sync: keeps your triage, marks unlisted issues gone, brings back a dismissed issue that regressed", () => {
		const inbox: { issues: Record<string, Issue> } = { issues: {} };
		mergeSync(inbox, [raw("1"), raw("2"), raw("3")], true);
		assert.deepEqual(Object.values(inbox.issues).map((i) => [i.id, i.triage, i.gone]), [["1", "new", false], ["2", "new", false], ["3", "new", false]]);
		inbox.issues["1"]!.triage = "dismissed";
		inbox.issues["2"]!.triage = "ticketed";
		mergeSync(inbox, [raw("1", { count: "500" }), raw("2")], true);
		assert.equal(inbox.issues["1"]!.events, 500, "Sentry owns the counts");
		assert.equal(inbox.issues["1"]!.triage, "dismissed", "your decision stays");
		assert.equal(inbox.issues["3"]!.gone, true, "no longer listed: resolved in Sentry");
		mergeSync(inbox, [raw("1", { substatus: "regressed" })], false);
		assert.equal(inbox.issues["1"]!.triage, "new", "a regression asks again");
		assert.equal(inbox.issues["2"]!.gone, false, "an incomplete sync marks nothing gone");
		assert.equal(inbox.issues["2"]!.triage, "ticketed");
	});

	it("ranks by priority, level, events, users, recency and unhandled", () => {
		const inbox: { issues: Record<string, Issue> } = { issues: {} };
		const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
		mergeSync(inbox, [raw("hot"), raw("cold", { lastSeen: old }), raw("low", { priority: "low" }), raw("crash", { isUnhandled: true }), raw("warn", { level: "warning" })], true);
		const order = Object.values(inbox.issues).sort((a, b) => score(b) - score(a)).map((i) => i.id);
		assert.deepEqual(order, ["crash", "hot", "warn", "low", "cold"]);
		assert.equal(score({ ...inbox.issues.hot!, gone: true }), 0);
	});

	it("drops a permalink that is not http(s)", () => {
		const inbox: { issues: Record<string, Issue> } = { issues: {} };
		mergeSync(inbox, [raw("x", { permalink: "javascript:alert(1)" })], true);
		assert.equal(inbox.issues.x!.permalink, "");
	});

	it("writes the ticket from the latest event: exception and in-app frames", () => {
		const inbox: { issues: Record<string, Issue> } = { issues: {} };
		mergeSync(inbox, [raw("7")], true);
		const event = {
			entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [
				{ filename: "node_modules/react.js", function: "render", lineNo: 1, inApp: false },
				{ filename: "app/page.tsx", function: "Page", lineNo: 42, inApp: true },
			] } }] } }],
		};
		const { name, markdown } = ticketFor(inbox.issues["7"]!, "production", event);
		assert.equal(name, "fix: WEB-7 TypeError 7");
		assert.match(markdown, /TypeError: x is undefined/);
		assert.match(markdown, /- app\/page\.tsx:42 in Page/);
		assert.doesNotMatch(markdown, /react\.js/);
		assert.match(markdown, /First write a test that reproduces it/);
	});
});

describe("clickup sprint", () => {
	const day = 86_400_000;
	const now = Date.parse("2026-10-16T12:00:00Z");
	it("picks the sprint whose dates cover today, else the latest started, else the last", () => {
		const s = (id: string, start: number | null, due: number | null) => ({ id, name: id, start, due });
		assert.equal(pickSprint([s("a", now - 20 * day, now - 6 * day), s("b", now - 5 * day, now + 9 * day), s("c", now + 10 * day, now + 24 * day)], now).id, "b");
		assert.equal(pickSprint([s("a", now - 20 * day, now - 6 * day), s("c", now + 10 * day, now + 24 * day)], now).id, "a");
		assert.equal(pickSprint([s("x", null, null), s("y", null, null)], now).id, "y");
		assert.throws(() => pickSprint([], now), /no lists/);
	});
});

describe("factory intake", { timeout: 60_000 }, () => {
	it("syncs Sentry in a durable loop, dismisses, and turns an issue into a ticket and its spec", async () => {
		const w = await scratchRepo();
		const config = testConfig(w.repo, w.data, { SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "acme", SENTRY_CLICKUP_LIST_ID: "L1" });
		let calls = 0;
		const sentry: SentryApi = {
			async issues() {
				calls++;
				return { issues: [raw("1"), raw("2")], complete: true };
			},
			async latestEvent() {
				return { entries: [{ type: "exception", data: { values: [{ type: "Boom", value: "it broke" }] } }] };
			},
		};
		const tracker = new FakeTracker();
		const { models } = fauxAgents();
		const factory = await Factory.open({ config, models, lanes, tracker, gitHost: new FakeGitHost(), sentry, log: () => {}, gatePollMs: 50, admitPollMs: 50 });
		try {
			for (let i = 0; i < 100 && Object.keys((await factory.inbox()).issues).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
			assert.equal(calls, 1, "the loop synced once at start");
			await factory.triage("2", "dismissed");
			await assert.rejects(factory.triage("nope", "dismissed"), /no Sentry issue/);
			const { ticketId } = await factory.fixIssue("1");
			assert.ok(tracker.log.some((l) => l.startsWith(`create ${ticketId} fix: WEB-1 TypeError 1`)), tracker.log.join("\n"));
			const again = await factory.fixIssue("1");
			assert.equal(again.ticketId, ticketId, "one ticket per issue");
			assert.equal(tracker.log.filter((l) => l.startsWith("create ")).length, 1);
			const inbox = await factory.inbox();
			assert.equal(inbox.issues["1"]!.triage, "ticketed");
			assert.equal(inbox.issues["2"]!.triage, "dismissed");
			await assert.rejects(factory.triage("1", "dismissed"), /already has a ticket/);
			const ticket = (await factory.ticket(ticketId))!;
			assert.equal(ticket.source?.shortId, "WEB-1");
			for (let i = 0; i < 400 && (await factory.ticket(ticketId))?.state !== "waiting_approval"; i++) await new Promise((r) => setTimeout(r, 50));
			assert.equal((await factory.ticket(ticketId))?.state, "waiting_approval", "Fix this plans the spec and waits for you");
			const now = await factory.syncSentry();
			assert.deepEqual(now, { issues: 2, complete: true });
		} finally {
			await factory.close();
		}
		// The loop is durable: a reopened factory does not start a second one.
		const reopened = await Factory.open({ config, models, lanes, tracker, gitHost: new FakeGitHost(), sentry, log: () => {}, gatePollMs: 50 });
		try {
			const graph = await reopened.graph();
			assert.equal(Object.values(graph.tasks).filter((t) => t.kind === "factory.sentry-sync").length, 1);
		} finally {
			await reopened.close();
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

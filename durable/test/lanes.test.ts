// Model lanes: Settings changes, Jev's start offset, and a ticket's own models.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { askJev, startIndex } from "../src/jev.ts";
import { checkLanes, loadLanes, modelName, pickModel, plannedModels, saveLanes, setModel, withOverrides } from "../src/lanes.ts";
import { fauxAgents, lanes } from "./support.ts";

describe("lanes", () => {
	it("puts a model first and keeps the rest as fallbacks, and an alias gets its own lane", () => {
		const next = setModel(lanes, "plan", "faux/other-1");
		assert.deepEqual(next.lanes.plan, ["faux/other-1", "faux/faux-1"]);
		assert.equal(next.aliases.plan, undefined);
		assert.equal(lanes.aliases.plan, "spec", "the input is not changed");
		assert.deepEqual(setModel(next, "plan", "faux/faux-1").lanes.plan, ["faux/faux-1", "faux/other-1"]);
		const back = setModel(next, "plan", null, "spec");
		assert.equal(back.lanes.plan, undefined);
		assert.equal(back.aliases.plan, "spec");
		assert.throws(() => setModel(lanes, "plan", "bad-model"));
		assert.throws(() => setModel(lanes, "plan", null, "nope"));
	});

	it("saves atomically, keeps _help, and loads back what it saved", async () => {
		const dir = await mkdtemp(join(tmpdir(), "lanes-"));
		try {
			const file = join(dir, "lanes.json");
			await writeFile(file, JSON.stringify({ _help: "read me", ...lanes }));
			await saveLanes(file, setModel(lanes, "plan", "faux/other-1"));
			assert.equal(JSON.parse(await readFile(file, "utf8"))._help, "read me");
			assert.deepEqual((await loadLanes(file)).lanes.plan, ["faux/other-1", "faux/faux-1"]);
			assert.throws(() => checkLanes({ lanes: { code: ["bad"] } }, "x"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("starts the chain where Jev points, and never past the last usable model", async () => {
		const { models } = fauxAgents();
		const l = { lanes: { code: ["faux/faux-1", "faux/other-1"] }, aliases: {} };
		const at = async (start: number, attempt = 1) => (await pickModel({ lanes: l, models, role: "code", attempt, avoidFamily: null, skip: () => null, start })).model;
		assert.equal(modelName((await at(0))!), "faux/faux-1");
		assert.equal(modelName((await at(1))!), "faux/other-1");
		assert.equal(modelName((await at(2))!), "faux/other-1", "clamped to the last usable entry");
		assert.equal(await at(1, 2), null, "fail-over goes on from the start");
	});

	it("maps Jev's answers to a start, and no Jev changes nothing", async () => {
		assert.equal(startIndex(null), 0);
		assert.equal(startIndex({ complexity: { score: 1, confidence: 0.9 } }), 0);
		assert.equal(startIndex({ complexity: { score: 1, confidence: 0.3 } }), 1, "unsure rounds up");
		assert.equal(startIndex({ complexity: { score: 3, confidence: 0.9 } }), 2);
		assert.equal(startIndex({ complexity: { score: 0, confidence: 0.9 }, consequence: { noul: 0.9 } }), 2);
		assert.equal(await askJev("ticket", {}), null, "no key: no call");
		const dir = await mkdtemp(join(tmpdir(), "jev-"));
		try {
			await writeFile(join(dir, "jev.json"), JSON.stringify({ answers: { complexity: { score: 2, confidence: 0.9 } } }));
			assert.equal(startIndex(await askJev("ticket", { JEV_FIXTURE: join(dir, "jev.json") })), 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("plans each role's model: yours first, then Jev's start, then the default", async () => {
		const { models } = fauxAgents();
		const l = { lanes: { code: ["faux/faux-1", "faux/other-1"], review: ["faux/other-1"] }, aliases: { fix: "code" } };
		const planned = await plannedModels({ lanes: l, models, overrides: { review: "faux/faux-1" }, start: 1 });
		const by = Object.fromEntries(planned.map((p) => [p.role, p]));
		assert.deepEqual(by.code, { role: "code", model: "faux/other-1", source: "jev" });
		assert.deepEqual(by.fix, { role: "fix", model: "faux/other-1", source: "jev" });
		assert.deepEqual(by.review, { role: "review", model: "faux/faux-1", source: "you" });
		assert.deepEqual(withOverrides(l).lanes, l.lanes);
	});
});

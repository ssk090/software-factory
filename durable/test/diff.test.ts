// The step diff behind the dashboard's drawer: parsing git's diff, and a step's range (committed,
// and its uncommitted edits and new files while it runs).
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { StepRecord } from "../src/docs.ts";
import { parseDiff, stepDiff } from "../src/diff.ts";
import { scratchRepo } from "./support.ts";

const step = (extra: Partial<StepRecord>): StepRecord => ({
	name: "code-1-1", role: "code", round: 1, attempt: 1, model: "faux/faux-1", conversationId: 1, taskId: 1,
	status: "done", started: Date.now(), ended: Date.now(), error: null, ...extra,
});

describe("step diff", () => {
	it("parses git's diff into files, hunks and numbered lines", () => {
		const files = parseDiff([
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1..2 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +1,3 @@",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			" export {};",
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"diff --git a/n.ts b/n.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/n.ts",
			"@@ -0,0 +1 @@",
			"+hi",
			"\\ No newline at end of file",
		].join("\n"));
		assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [["src/a.ts", "modified", 1, 1], ["new.ts", "renamed", 0, 0], ["n.ts", "added", 1, 0]]);
		assert.equal(files[1]!.from, "old.ts");
		assert.deepEqual(files[0]!.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new]), [["ctx", 1, 1], ["del", 2, null], ["add", null, 2], ["ctx", 3, 3]]);
		assert.equal(files[2]!.hunks[0]!.lines.at(-1)!.kind, "note");
	});

	it("shows what a step committed, and while it runs its uncommitted edits and new files", async () => {
		const w = await scratchRepo();
		try {
			const before = w.git(w.repo, "rev-parse", "HEAD").trim();
			await writeFile(join(w.repo, "README.md"), "scratch\nchanged by the step\n");
			w.git(w.repo, "commit", "-qam", "the step's commit");
			const after = w.git(w.repo, "rev-parse", "HEAD").trim();
			const done = await stepDiff(w.repo, step({ headBefore: before, headAfter: after }));
			assert.equal(done.to, after);
			assert.deepEqual(done.commits.map((c) => c.subject), ["the step's commit"]);
			assert.deepEqual(done.files.map((f) => [f.path, f.additions, f.deletions]), [["README.md", 1, 0]]);
			// Running: the working tree, with an edit not committed yet and a new file not in git yet.
			await writeFile(join(w.repo, "README.md"), "scratch\nchanged by the step\nand more\n");
			await writeFile(join(w.repo, "new.ts"), "export const x = 1;\n");
			const live = await stepDiff(w.repo, step({ status: "running", ended: null, headBefore: before }));
			assert.equal(live.live, true);
			assert.equal(live.to, null);
			assert.deepEqual(live.files.map((f) => [f.path, f.status, f.additions]), [["README.md", "modified", 2], ["new.ts", "added", 1]]);
			// A step from before steps recorded their commits: found by its time.
			const old = await stepDiff(w.repo, step({ started: Date.now() + 60_000, ended: Date.now() + 60_000 }));
			assert.equal(old.from, after);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});
});

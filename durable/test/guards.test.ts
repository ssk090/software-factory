// Guardrails: the secret scan before a push, redaction of what the factory posts, and the agent
// guard's rules for git hooks and secret files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyProblem } from "../src/lessons.ts";
import { writeGuardHooks } from "../src/git.ts";
import { HOOK_BYPASS, SECRET_PATHS } from "../src/roles.ts";
import { knownSecrets, redact, scanBranch, scanText } from "../src/secrets.ts";
import { scratchRepo } from "./support.ts";

const github = `ghp_${"Rk7Qm2Zt9Lx4Vb8Nc1Hd6Jf3Pw5Sy0Gu2Ea7"}`;
const known = [{ name: "CLICKUP_TOKEN", value: "pk_1234567_QWERTYUIOPASDFGHJKLZXCVB" }];
const rules = (text: string, path = "src/a.ts") => scanText(text, path, { path, known }).map((f) => f.rule);

describe("guardrails", () => {
	it("finds well-known secrets, and passes documentation examples and placeholders", () => {
		assert.deepEqual(rules(`const t = "${github}";`), ["github-token"]);
		assert.deepEqual(rules("key = AKIAQWERTYUIOPASDFGH"), ["aws-access-key"]);
		assert.deepEqual(rules("key = AKIAIOSFODNN7EXAMPLE"), [], "the AWS documentation key");
		assert.deepEqual(rules("-----BEGIN OPENSSH PRIVATE KEY-----"), ["private-key"]);
		assert.deepEqual(rules('db = "postgres://app:S3cr3tPassw0rd@db:5432/x"'), ["url-with-password"]);
		assert.deepEqual(rules('db = "postgres://user:password@localhost/x"'), [], "a placeholder password");
		assert.deepEqual(rules('const apiKey = "Zq8xV2mN4pL7tR1yW9sK3bH6";'), ["secret-assignment"]);
		assert.deepEqual(rules('const apiKey = "Zq8xV2mN4pL7tR1yW9sK3bH6";', "src/a.test.ts"), [], "a fake key in a test");
		assert.deepEqual(rules('const apiKey = "your-api-key-here-please";'), []);
	});

	it("never lets the factory's own secrets through, not even in a test", () => {
		const found = scanText(`token: ${known[0]!.value}`, "src/a.test.ts", { path: "src/a.test.ts", known });
		assert.ok(found.some((f) => f.rule === "factory-secret" && f.hint === "the value of CLICKUP_TOKEN from the factory's environment"));
		assert.ok(found.every((f) => !f.hint.includes(known[0]!.value)), "a finding never shows the value");
		assert.ok(knownSecrets({ CLICKUP_TOKEN: "pk_1234567_QWERTYUIOP", HOME: "/home/x", SHORT_TOKEN: "abc" }).some((s) => s.name === "CLICKUP_TOKEN"));
		assert.equal(knownSecrets({ HOME: "/home/someone/long/path", SHORT_TOKEN: "abc" }).length, 0);
	});

	it("redacts what the factory posts", () => {
		const out = redact(`PR body: uses ${github} and ${known[0]!.value}.`, known);
		assert.equal(out.text, "PR body: uses [redacted] and [redacted].");
		assert.equal(out.count, 2);
	});

	it("scans what a push would send: added lines, secret files and commit messages", async () => {
		const w = await scratchRepo();
		try {
			w.git(w.repo, "checkout", "-q", "-b", "work");
			await mkdir(join(w.repo, "src"), { recursive: true });
			await writeFile(join(w.repo, "src", "a.ts"), `export const a = 1;\nexport const t = "${github}";\n`);
			await writeFile(join(w.repo, ".env"), "DEBUG=1\n");
			await writeFile(join(w.repo, ".env.example"), "TOKEN=\n");
			w.git(w.repo, "add", ".");
			w.git(w.repo, "commit", "-qm", `wire the client (token ${known[0]!.value})`);
			const found = await scanBranch(w.repo, "origin/main", known);
			const where = found.map((f) => `${f.where} ${f.rule}`);
			assert.ok(where.includes("src/a.ts:2 github-token"), where.join("\n"));
			assert.ok(where.includes(".env secret-file"));
			assert.ok(!where.some((x) => x.startsWith(".env.example")), "an example env file is fine");
			assert.ok(where.some((x) => /^commit [0-9a-f]+ message factory-secret$/.test(x)));
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("lets a learned VERIFY_CMD only run the same check, never pass by itself", () => {
		assert.equal(verifyProblem("pnpm check:typescript", "pnpm turbo check:typescript --concurrency=1"), null);
		assert.equal(verifyProblem("pnpm check:typescript", "pnpm -r --workspace-concurrency=1 run check:typescript"), null);
		assert.match(verifyProblem("pnpm check:typescript", "pnpm check:lint") ?? "", /does not run check:typescript/);
		assert.match(verifyProblem("pnpm check:typescript", "pnpm check:typescript || true") ?? "", /could pass without the check/);
		assert.match(verifyProblem("pnpm check:typescript", "pnpm check:typescript; exit 0") ?? "", /could pass/);
		assert.match(verifyProblem("pnpm check:typescript", "pnpm check:typescript > /dev/null") ?? "", /could pass/);
		assert.match(verifyProblem("pnpm check:typescript", "true") ?? "", /could pass|does not run/);
	});

	it("lets lint-staged keep its backup in the stash, and refuses every other stash", async () => {
		const w = await scratchRepo();
		try {
			w.git(w.repo, "checkout", "-q", "-b", "ticket");
			const hooks = await writeGuardHooks(w.repo, join(w.root, "run"), "T-1", "ticket");
			const git = (...args: string[]) => {
				try {
					return { ok: true, out: execFileSync("git", ["-C", w.repo, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks } }).toString() };
				} catch (error) {
					return { ok: false, out: String((error as { stderr?: Buffer }).stderr ?? error) };
				}
			};
			await writeFile(join(w.repo, "README.md"), "changed\n");
			assert.ok(git("stash", "push", "--message", "lint-staged automatic backup").ok, "lint-staged's backup is allowed");
			assert.ok(git("stash", "pop").ok, "and taking it back");
			const mine = git("stash", "push", "--message", "my own stash");
			assert.equal(mine.ok, false, "any other stash is refused");
			assert.match(mine.out, /refused to change refs\/stash/);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it("keeps agents off the repo's hooks and the secret files", () => {
		for (const c of ["git commit --no-verify -m x", "git commit -nm x", "HUSKY=0 git commit -m x", "git -c core.hooksPath=/dev/null commit -m x", "LEFTHOOK=0 git commit"]) {
			assert.ok(HOOK_BYPASS.test(c), c);
		}
		for (const c of ['git commit -m "fix: scanning"', "git commit --amend --no-edit", "git commit -am x"]) assert.ok(!HOOK_BYPASS.test(c), c);
		for (const c of ["cat ../../config.env", "cat ~/.ssh/id_ed25519", "cat state/dash.token", "sqlite3 state/factory.sqlite", "cat ~/.config/gh/hosts.yml"]) {
			assert.ok(SECRET_PATHS.test(c), c);
		}
		for (const c of ["cat src/config.ts", "cat .env.example", "pnpm install"]) assert.ok(!SECRET_PATHS.test(c), c);
	});
});

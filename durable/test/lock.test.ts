// The session lock: one factory owns state/factory.pid, and a dead owner's lock is taken over.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { _test } from "../src/host.ts";

const { takeLock } = _test;

describe("session lock", () => {
	it("refuses a live owner's lock, and takes over a dead owner's lock", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-lock-"));
		const lock = join(dir, "factory.pid");
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			assert.ok(child.pid !== undefined);
			await writeFile(lock, String(child.pid));
			await assert.rejects(takeLock(lock), /another factory \(pid \d+\) owns/);
			child.kill();
			await exited;
			await takeLock(lock);
			assert.equal(await readFile(lock, "utf8"), String(process.pid), "a stale pid is replaced");
		} finally {
			child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("gives the lock to one of several starts at the same moment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-lock-"));
		const lock = join(dir, "factory.pid");
		// A dead owner's pid: every start passes a liveness check, and the old check-then-write let them in.
		await writeFile(lock, "999999");
		const host = pathToFileURL(join(import.meta.dirname, "..", "src", "host.ts")).href;
		const script = `
			(async () => {
				const { takeLock } = (await import(process.env.HOST_TS))._test;
				await new Promise((r) => setTimeout(r, Math.max(0, Number(process.env.START_AT) - Date.now())));
				try {
					await takeLock(process.env.LOCK);
					console.log("ok");
					await new Promise((r) => setTimeout(r, 3000));
				} catch { console.log("err"); }
			})();
		`;
		const startAt = String(Date.now() + 700);
		const children = Array.from({ length: 8 }, () =>
			spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
				env: { ...process.env, HOST_TS: host, LOCK: lock, START_AT: startAt },
				stdio: ["ignore", "pipe", "ignore"],
			}));
		const answers = await Promise.all(children.map((child) => new Promise<string>((resolve) => {
			child.stdout.on("data", (chunk) => {
				const out = String(chunk).trim();
				if (out !== "") resolve(out);
			});
			child.on("close", () => resolve(""));
		})));
		try {
			assert.equal(answers.filter((a) => a === "ok").length, 1, answers.join(","));
			assert.equal(answers.filter((a) => a === "err").length, 7, answers.join(","));
		} finally {
			for (const child of children) child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("takes over an empty lock file from a crash before the pid was written", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-lock-"));
		const lock = join(dir, "factory.pid");
		try {
			await writeFile(lock, "");
			await takeLock(lock);
			assert.equal(await readFile(lock, "utf8"), String(process.pid));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

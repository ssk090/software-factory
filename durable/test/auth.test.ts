// The OAuth credential store: one file, mode 600, one serialized write path per provider.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deviceId, FileCredentials } from "../src/auth.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("credentials", () => {
	it("writes, reads and deletes a credential, with mode 600", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-auth-"));
		const file = join(dir, "auth.json");
		const store = new FileCredentials(file);
		try {
			assert.equal(await store.read("openai"), undefined);
			assert.deepEqual(await store.list(), []);
			const written = await store.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
			assert.equal(written?.type, "api_key");
			assert.equal((await stat(file)).mode & 0o777, 0o600);
			assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-test" });
			assert.deepEqual(await store.list(), [{ providerId: "openai", type: "api_key" }]);
			const unchanged = await store.modify("openai", async (current) => {
				assert.deepEqual(current, { type: "api_key", key: "sk-test" });
				return undefined;
			});
			assert.deepEqual(unchanged, { type: "api_key", key: "sk-test" });
			await store.delete("openai");
			assert.equal(await store.read("openai"), undefined);
			assert.equal(await readFile(file, "utf8"), "{}\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("serializes two writes for one provider", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-auth-"));
		const store = new FileCredentials(join(dir, "auth.json"));
		try {
			const seen: (string | undefined)[] = [];
			await Promise.all([
				store.modify("openai", async (current) => {
					seen.push(current?.type === "api_key" ? current.key : undefined);
					await sleep(20);
					return { type: "api_key", key: "first" };
				}),
				store.modify("openai", async (current) => {
					seen.push(current?.type === "api_key" ? current.key : undefined);
					return { type: "api_key", key: "second" };
				}),
			]);
			assert.deepEqual(seen, [undefined, "first"]);
			assert.deepEqual(await store.read("openai"), { type: "api_key", key: "second" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a broken file and does not replace it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-auth-"));
		const file = join(dir, "auth.json");
		const store = new FileCredentials(file);
		try {
			await writeFile(file, "{oops", { mode: 0o600 });
			await assert.rejects(store.read("openai"), /not valid JSON/);
			await assert.rejects(store.modify("openai", async () => ({ type: "api_key", key: "x" })), /not valid JSON/);
			assert.equal(await readFile(file, "utf8"), "{oops");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps one installation id across logins", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sf-auth-"));
		const config = { stateDir: join(dir, "state") };
		try {
			const first = await deviceId(config);
			const second = await deviceId(config);
			assert.match(first, /^[0-9a-f-]{36}$/);
			assert.equal(first, second);
			assert.equal((await stat(join(config.stateDir, "device-id"))).mode & 0o777, 0o600);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

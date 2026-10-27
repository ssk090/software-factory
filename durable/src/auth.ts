// OAuth credentials for the model providers: one file, mode 600, next to the session. pi-ai keeps
// credentials in memory by default, so the app owns this store. `modify` is the only write path:
// a refresh and a login cannot lose each other.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentials implements CredentialStore {
	private readonly file: string;
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(file: string) {
		this.file = file;
	}

	/** The stored credentials. A missing file is empty. A broken file is an error, never silently replaced. */
	private async readAll(): Promise<Record<string, Credential>> {
		let text: string;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		if (text.trim() === "") return {};
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`${this.file} is not valid JSON: fix it, or delete it and log in again`);
		}
		if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`${this.file} must hold a JSON object`);
		return data as Record<string, Credential>;
	}

	private async writeAll(all: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		await writeFile(`${this.file}.tmp`, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		await chmod(`${this.file}.tmp`, 0o600);
		await rename(`${this.file}.tmp`, this.file);
	}

	/** One task per provider at a time, as the interface needs for a refresh and a login. */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.chains.set(providerId, next.catch(() => undefined));
		return next;
	}

	async read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.readAll())[providerId];
	}

	async list(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.readAll()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			options?.signal?.throwIfAborted();
			const all = await this.readAll();
			const current = all[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				all[providerId] = next;
				await this.writeAll(all);
			}
			return next ?? all[providerId];
		});
	}

	async delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void> {
		await this.enqueue(providerId, async () => {
			options?.signal?.throwIfAborted();
			const all = await this.readAll();
			if (all[providerId] === undefined) return;
			delete all[providerId];
			await this.writeAll(all);
		});
	}
}

/** The app installation id: stable across logins, mode 600, created on first use. */
export async function deviceId(config: { readonly stateDir: string }): Promise<string> {
	const file = join(config.stateDir, "device-id");
	const old = (await readFile(file, "utf8").catch(() => "")).trim();
	if (/^[0-9a-f-]{36}$/i.test(old)) return old;
	await mkdir(dirname(file), { recursive: true });
	const id = randomUUID();
	await writeFile(`${file}.tmp`, `${id}\n`, { mode: 0o600 });
	await chmod(`${file}.tmp`, 0o600);
	await rename(`${file}.tmp`, file);
	return id;
}

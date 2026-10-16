// JSON over HTTPS for the tracker and Sentry. Every call times out; only transient failures
// (429, 5xx, network) are retried, honouring Retry-After. Errors never carry request headers.
export class HttpError extends Error {
	readonly status: number;
	readonly url: string;
	constructor(status: number, message: string, url: string) {
		super(`HTTP ${status || "error"} from ${url.split("?")[0]}: ${message}`);
		this.status = status;
		this.url = url;
	}
}

export type Response<T> = { data: T; headers: Headers };
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
export const timing = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

export async function requestJson<T>(
	method: string,
	url: string,
	options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number; tries?: number } = {},
): Promise<Response<T>> {
	const tries = options.tries ?? 3;
	for (let attempt = 0; ; attempt++) {
		let response: globalThis.Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					Accept: "application/json",
					"User-Agent": "software-factory",
					...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
					...options.headers,
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
			});
		} catch (error) {
			if (attempt + 1 < tries) {
				await timing.sleep(1000 * 2 ** attempt);
				continue;
			}
			throw new HttpError(0, error instanceof Error ? error.message : String(error), url);
		}
		if (!response.ok) {
			const text = (await response.text().catch(() => "")).slice(0, 500);
			if (TRANSIENT.has(response.status) && attempt + 1 < tries) {
				const after = Number(response.headers.get("retry-after"));
				await timing.sleep(Number.isFinite(after) && after >= 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
				continue;
			}
			throw new HttpError(response.status, text, url);
		}
		const raw = await response.text();
		return { data: (raw.trim() === "" ? null : JSON.parse(raw)) as T, headers: response.headers };
	}
}

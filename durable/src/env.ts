// Where an agent's tools run (examples 29-sandbox-per-conversation, 30-tool-override): each step
// conversation's StepDoc names its ticket's worktree and run folder, and the environment is built
// from it for every call. The factory's own secrets never reach an agent's shell: the model is
// called by the factory, so agents need no API keys.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { run } from "./git.ts";
import { indexScope } from "./index/options.ts";

/** Names of variables an agent's shell never gets. */
export const SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIALS)/i;

export function agentShellEnv(base: NodeJS.ProcessEnv, cell: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) if (value !== undefined && !SECRET.test(key)) env[key] = value;
	return { ...env, ...cell, IS_SANDBOX: "1" };
}

/**
 * The agent's shell on this machine. NodeExecutionEnv merges all of process.env into every command
 * unless `inheritEnv` is false, which would hand the factory's tokens to the agent: this passes
 * exactly the given environment instead.
 */
export class AgentExecutionEnv extends NodeExecutionEnv {
	private readonly options: { cwd: string; env: Record<string, string>; pidFile: string };
	constructor(options: { cwd: string; env: Record<string, string>; pidFile: string }) {
		super({ cwd: options.cwd });
		this.options = options;
	}

	override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
		// Each command leads its own process group (NodeExecutionEnv spawns it detached) and records it,
		// so a factory that restarts after a crash can end commands the dead process left running.
		const recorded = typeof command === "string" ? `echo $$ >> ${shq(this.options.pidFile)}; ${command}` : command;
		return super.exec(recorded, { ...options, env: { ...this.options.env, ...(options?.env ?? {}) }, inheritEnv: false }, context);
	}
}

const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * After a crash: end the commands a dead factory left running for a ticket. A recorded process group
 * is killed only while its leader still is that command (its arguments name the pid file), so a
 * reused pid is never hit.
 */
export async function reapOrphans(runDir: string, container: string | null): Promise<number> {
	let killed = 0;
	const pidFile = join(runDir, "exec.pids");
	const pids = (await readFile(pidFile, "utf8").catch(() => "")).split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 1);
	for (const pid of new Set(pids)) {
		const ps = await run("ps", ["-o", "args=", "-p", String(pid)]);
		if (ps.code !== 0 || !ps.stdout.includes(pidFile)) continue;
		try {
			process.kill(-pid, "SIGKILL");
			killed++;
		} catch {
			// gone meanwhile
		}
	}
	await writeFile(pidFile, "").catch(() => undefined);
	if (container !== null) {
		const r = await run("docker", ["exec", container, "bash", "-c", 'n=0; for f in /tmp/factory-exec-*; do [ -f "$f" ] || continue; kill -KILL -- "-$(cat "$f")" 2>/dev/null && n=$((n+1)); rm -f "$f"; done; echo $n']);
		if (r.code === 0) killed += Number(r.stdout.trim()) || 0;
	}
	return killed;
}

/** A docker container per ticket: shell commands run inside it, at the same paths as outside. */
export class DockerExecutionEnv extends NodeExecutionEnv {
	private readonly container: string;
	private readonly options: { cwd: string; env: Record<string, string> };
	constructor(container: string, options: { cwd: string; env: Record<string, string> }) {
		super({ cwd: options.cwd });
		this.container = container;
		this.options = options;
	}

	override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
		// A container the system stopped (out of memory kills it whole) is started again: its files are
		// the worktree and the run folder on this machine, so nothing is lost. The agent is told.
		const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", this.container]);
		let notice = "";
		if (state.code === 0 && state.stdout.trim() === "false") {
			const started = await run("docker", ["start", this.container]);
			notice = started.code === 0
				? "[factory] The sandbox container had stopped (the system killed it, most likely out of memory) and was started again. Your files are kept. Run memory-heavy commands with less parallelism."
				: `[factory] The sandbox container has stopped and could not be started again: ${started.stderr.trim()}`;
		}
		const env = { ...this.options.env, ...(options?.env ?? {}) };
		// The notice is part of the command's own output, so the agent reads it in the tool result.
		const told = notice && typeof command === "string" ? `printf '%s\\n' ${JSON.stringify(notice)} >&2; ${command}` : command;
		const argv = typeof told === "string" ? ["bash", "-c", told] : [...told];
		const id = `${process.pid}-${++DockerExecutionEnv.calls}`;
		const docker = [
			"docker", "exec", "-i", "-w", options?.cwd ?? this.options.cwd,
			// Names only: the values come from this client's environment, so they never show in argv.
			...Object.keys(env).flatMap((key) => ["-e", key]),
			this.container,
			// setsid: the command leads a new process group, whose id it records, so a stop or a
			// timeout kills everything it started inside the container, not only the docker client.
			"setsid", "--wait", "bash", "-c", 'echo $$ > "/tmp/factory-exec-$0"; exec "$@"', id, ...argv,
		];
		const result = await super.exec(docker, { ...options, env, inheritEnv: true }, context);
		if (!result.ok || context.abortSignal?.aborted) {
			// bash, not sh: dash's kill takes no process group (a negative pid).
			await run("docker", ["exec", this.container, "bash", "-c", 'p=$(cat "/tmp/factory-exec-$0" 2>/dev/null) && kill -KILL -- "-$p"', id]);
		}
		await run("docker", ["exec", this.container, "rm", "-f", `/tmp/factory-exec-${id}`]);
		return result;
	}

	private static calls = 0;
}

/** Start (or reuse) the ticket's container. Paths are mounted at the same place inside. */
export async function ensureContainer(options: {
	name: string;
	image: string;
	worktree: string;
	run: string;
	gitDir: string;
	cacheVolume: string;
	extraArgs: readonly string[];
	/** The code index: mounted read-only at the same path, with INDEX_DIR/INDEX_SCOPE set. */
	index?: { dir: string; scope: string } | null;
}): Promise<void> {
	const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", options.name]);
	if (state.code === 0 && state.stdout.trim() === "true") return;
	if (state.code === 0) await run("docker", ["rm", "-f", options.name]);
	const cache = options.cacheVolume
		? ["-v", `${options.cacheVolume}:/cache`, "-e", "XDG_CACHE_HOME=/cache/xdg", "-e", "npm_config_cache=/cache/npm",
			"-e", "npm_config_store_dir=/cache/pnpm-store", "-e", "YARN_CACHE_FOLDER=/cache/yarn", "-e", "PIP_CACHE_DIR=/cache/pip",
			"-e", "GOMODCACHE=/cache/go/mod", "-e", "BUN_INSTALL_CACHE_DIR=/cache/bun"]
		: [];
	// The index folder is made here (owned by the factory's user, never root inside the container);
	// the agents may read and search it, never write it: it is the service side's, like Cursor's.
	const index = options.index ?? null;
	const indexed = index !== null && index.dir !== "";
	if (indexed) await mkdir(index!.dir, { recursive: true });
	const indexArgs = indexed
		? ["-v", `${index!.dir}:${index!.dir}:ro`, "-e", `INDEX_DIR=${index!.dir}`, ...(index!.scope !== "" ? ["-e", `INDEX_SCOPE=${index!.scope}`] : [])]
		: [];
	const started = await run("docker", [
		"run", "-d", "--name", options.name, "--init", "--label", "software-factory=1",
		"-v", `${options.worktree}:${options.worktree}`, "-v", `${options.run}:${options.run}`, "-v", `${options.gitDir}:${options.gitDir}`,
		...indexArgs, ...cache, ...options.extraArgs, "--entrypoint", "sleep", options.image, "infinity",
	]);
	if (started.code !== 0) throw new Error(`docker run ${options.image}: ${started.stderr.trim()}`);
}

export async function removeContainer(name: string): Promise<void> {
	await run("docker", ["rm", "-f", name]);
}

/** Resolve `path` (relative to `cwd`) through symlinks, as far as it exists. */
export async function realTarget(path: string, cwd: string): Promise<string> {
	let target = isAbsolute(path) ? path : resolve(cwd, path);
	const rest: string[] = [];
	for (;;) {
		try {
			const real = await realpath(target);
			return rest.length === 0 ? real : resolve(real, ...rest.reverse());
		} catch {
			const parent = dirname(target);
			if (parent === target) return resolve(path);
			rest.push(target.slice(parent.length + 1));
			target = parent;
		}
	}
}

/** Whether `path` is inside one of `roots` (after resolving symlinks). */
export async function inside(path: string, cwd: string, roots: readonly string[]): Promise<boolean> {
	const target = await realTarget(path, cwd);
	for (const root of roots) {
		const real = await realTarget(root, root);
		if (target === real || target.startsWith(real + sep)) return true;
	}
	return false;
}

/** What a step's environment is built from: its worktree, and the ticket cell's variables. */
export type StepTarget = { worktree: string; run: string; cell: Record<string, string>; container: string | null };
export type EnvFactory = (step: StepTarget) => ExecutionEnv;

/** SANDBOX=none: this machine's environment without secrets, plus the cell and the code index's
 *  variables — the same ones the ticket containers get at `docker run`. */
export const nodeEnvWith = (indexDir: string): EnvFactory => (step) =>
	new AgentExecutionEnv({
		cwd: step.worktree,
		env: {
			...agentShellEnv(process.env, step.cell),
			INDEX_DIR: indexDir,
			...(step.cell.FACTORY_TICKET ? { INDEX_SCOPE: indexScope(step.cell.FACTORY_TICKET) } : {}),
		},
		pidFile: join(step.run, "exec.pids"),
	});
/** SANDBOX=docker: only the cell's variables go into the container; the image sets the rest. */
export const dockerEnv: EnvFactory = (step) => {
	if (step.container === null) throw new Error("SANDBOX=docker, but the ticket has no container");
	return new DockerExecutionEnv(step.container, { cwd: step.worktree, env: { ...step.cell, IS_SANDBOX: "1" } });
};

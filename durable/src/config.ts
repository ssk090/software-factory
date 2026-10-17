// The factory's settings, read from the environment. bin/ff sources config.env (the one file for
// settings and secrets, as before) before it starts node, so shell syntax in it keeps working.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Statuses = {
	readonly todo: string;
	readonly specReview: string;
	readonly approved: string;
	readonly working: string;
	readonly inReview: string;
	readonly blocked: string;
};

export type Config = {
	readonly here: string;
	readonly dataDir: string;
	readonly stateDir: string;
	readonly runsDir: string;
	readonly treesDir: string;
	readonly repo: string;
	/** The URL the factory's git commands use for origin (empty: the checkout's own). */
	readonly originUrl: string;
	readonly base: string;
	readonly setupCmd: string;
	readonly verifyCmd: string;
	readonly statuses: Statuses;
	readonly specGate: boolean;
	readonly maxReviewRounds: number;
	readonly maxParallel: number;
	readonly slots: number;
	readonly cellPortStart: number;
	readonly cellPortSpan: number;
	readonly agentTimeoutMs: number;
	/** Coordinator repairs per phase and run before a failure blocks the ticket (0: no coordinator). */
	readonly maxRepairs: number;
	readonly prLabel: string;
	readonly trackerComments: boolean;
	/** Attach the spec and plan to the ticket as .md files (default on). */
	readonly trackerAttach: boolean;
	readonly branchType: string;
	readonly skillsPath: readonly string[];
	readonly repoSkillDirs: readonly string[];
	readonly sandbox: "docker" | "none";
	readonly sandboxImage: string;
	readonly sandboxArgs: readonly string[];
	readonly cacheVolume: string;
	/** Where the codebase indexes live (state/index, inside the data folder every sandbox sees). */
	readonly indexDir: string;
	/** INDEX_AUTO=0: never refresh indexes in the background (the commands still work). */
	readonly indexAuto: boolean;
	readonly gcDays: number;
	readonly clickup: {
		readonly token: string;
		readonly teamId: string;
		readonly userId: string;
		readonly listId: string;
		readonly sprintListId: string;
		readonly sprintFolderId: string;
		/** The custom task id prefix (CHP): a bare number such as 7642 means CHP-7642. */
		readonly idPrefix: string;
		/** Where tickets made from Sentry issues go. */
		readonly sentryListId: string;
	};
	readonly sentry: {
		readonly token: string;
		readonly org: string;
		readonly projects: readonly string[];
		readonly environment: string;
		readonly url: string;
		readonly query: string;
		readonly period: string;
		readonly maxPages: number;
		readonly pollSeconds: number;
	};
	readonly dash: {
		readonly host: string;
		readonly port: number;
		readonly password: string;
		readonly allowedHosts: readonly string[];
	};
	readonly autoPickup: boolean;
	/** PRE_PUSH=0: push without the repo's pre-push hook (it does not run anywhere). */
	readonly prePush: boolean;
	readonly pollSeconds: number;
	/** Model API use: per provider (one API key each), requests and tokens per minute; spend per day. 0 = no limit. */
	readonly limits: {
		readonly rpm: number;
		readonly tpm: number;
		readonly dailyBudgetUsd: number;
	};
};

const num = (value: string | undefined, fallback: number, name: string): number => {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${value} is not a number`);
	return n;
};
const flag = (value: string | undefined, fallback: boolean): boolean =>
	value === undefined || value.trim() === "" ? fallback : value.trim() === "1" || value.trim().toLowerCase() === "true";
const list = (value: string | undefined, separator: string | RegExp): string[] =>
	(value ?? "").split(separator).map((part) => part.trim()).filter((part) => part !== "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, here = resolve(import.meta.dirname, "..", "..")): Config {
	const dataDir = resolve(env.DATA_DIR || here);
	const home = homedir();
	const sandbox = (env.SANDBOX || "docker").trim();
	if (sandbox !== "docker" && sandbox !== "none") throw new Error(`SANDBOX must be docker or none, got ${sandbox}`);
	const clickup = {
		token: env.CLICKUP_TOKEN ?? "",
		teamId: env.CLICKUP_TEAM_ID ?? "",
		userId: env.CLICKUP_USER_ID ?? "",
		listId: env.CLICKUP_LIST_ID ?? "",
		sprintListId: env.CLICKUP_SPRINT_LIST_ID ?? "",
		sprintFolderId: env.CLICKUP_SPRINT_FOLDER_ID ?? "",
		idPrefix: (env.CLICKUP_ID_PREFIX ?? "").trim().replace(/-$/, "").toUpperCase(),
		sentryListId: env.SENTRY_CLICKUP_LIST_ID || env.CLICKUP_LIST_ID || "",
	};
	return {
		here,
		dataDir,
		stateDir: join(dataDir, "state"),
		runsDir: join(dataDir, "runs"),
		treesDir: join(dataDir, "worktrees"),
		repo: resolve(env.REPO || process.cwd()),
		originUrl: (env.ORIGIN_URL ?? "").trim(),
		base: env.BASE || "develop",
		setupCmd: env.SETUP_CMD ?? "",
		verifyCmd: env.VERIFY_CMD ?? "",
		statuses: {
			todo: env.S_TODO || "to do",
			specReview: env.S_SPEC_REVIEW || "spec review",
			approved: env.S_APPROVED || "approved",
			working: env.S_WORKING || "in progress",
			inReview: env.S_IN_REVIEW || "in review",
			blocked: env.S_BLOCKED || "blocked",
		},
		specGate: flag(env.SPEC_GATE, true),
		maxReviewRounds: Math.max(1, num(env.MAX_REVIEW_ROUNDS, 2, "MAX_REVIEW_ROUNDS")),
		maxParallel: Math.max(1, num(env.MAX_PARALLEL, 1, "MAX_PARALLEL")),
		slots: Math.max(1, num(env.SLOTS, 8, "SLOTS")),
		cellPortStart: num(env.CELL_PORT_START, 20000, "CELL_PORT_START"),
		cellPortSpan: Math.max(1, num(env.CELL_PORT_SPAN, 100, "CELL_PORT_SPAN")),
		agentTimeoutMs: num(env.AGENT_TIMEOUT, 3600, "AGENT_TIMEOUT") * 1000,
		maxRepairs: num(env.MAX_REPAIRS, 2, "MAX_REPAIRS"),
		prLabel: env.PR_LABEL ?? "",
		trackerComments: flag(env.TRACKER_COMMENTS, false),
		trackerAttach: flag(env.TRACKER_ATTACH, true),
		branchType: env.BRANCH_TYPE ?? "",
		skillsPath: list(
			env.SKILLS_PATH ||
				[join(here, "skills"), join(home, ".agents/skills"), join(home, ".claude/skills"), join(home, ".codex/skills"), join(home, ".pi/agent/skills"), join(home, ".pi/agent/git")].join(":"),
			":",
		),
		repoSkillDirs: list(
			env.REPO_SKILL_DIRS ||
				".claude/skills .agents/skills .codex/skills .cursor/skills .opencode/skills .claude/commands .codex/prompts .cursor/commands .opencode/command",
			/\s+/,
		),
		sandbox,
		sandboxImage: env.SANDBOX_IMAGE || "software-factory",
		sandboxArgs: list(env.SANDBOX_ARGS, /\s+/),
		cacheVolume: env.CACHE_VOLUME ?? "factory-cache",
		indexDir: resolve(env.INDEX_DIR || join(dataDir, "state", "index")),
		indexAuto: flag(env.INDEX_AUTO, true),
		gcDays: num(env.GC_DAYS, 14, "GC_DAYS"),
		clickup,
		sentry: {
			token: env.SENTRY_AUTH_TOKEN ?? "",
			org: env.SENTRY_ORG ?? "",
			projects: list(env.SENTRY_PROJECTS, ","),
			environment: env.SENTRY_ENVIRONMENT || "production",
			url: (env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, ""),
			query: env.SENTRY_QUERY ?? "is:unresolved",
			period: env.SENTRY_PERIOD || "14d",
			maxPages: Math.max(1, num(env.SENTRY_MAX_PAGES, 5, "SENTRY_MAX_PAGES")),
			pollSeconds: Math.max(60, num(env.SENTRY_POLL_INTERVAL, 900, "SENTRY_POLL_INTERVAL")),
		},
		dash: {
			host: env.DASH_HOST || "127.0.0.1",
			port: num(env.DASH_PORT, 8090, "DASH_PORT"),
			password: env.DASH_PASSWORD ?? "",
			allowedHosts: list(env.DASH_ALLOWED_HOSTS, ","),
		},
		autoPickup: flag(env.AUTO_PICKUP, false),
		prePush: flag(env.PRE_PUSH, true),
		pollSeconds: Math.max(60, num(env.POLL_INTERVAL, 3600, "POLL_INTERVAL")),
		limits: {
			rpm: num(env.RATE_LIMIT_RPM, 50, "RATE_LIMIT_RPM"),
			tpm: num(env.RATE_LIMIT_TPM, 0, "RATE_LIMIT_TPM"),
			dailyBudgetUsd: num(env.DAILY_BUDGET_USD, 0, "DAILY_BUDGET_USD"),
		},
	};
}

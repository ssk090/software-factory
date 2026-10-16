// Guardrails for what leaves the machine: before a push, everything the branch adds (file lines,
// new files, commit messages) is scanned for secrets, and the push stops on a finding. Text the
// factory posts (the PR title and body, PR and tracker comments, attachments) is redacted.
//
// Two kinds of check:
// - exact values: every secret in the factory's own environment (a TOKEN, KEY, SECRET or PASSWORD
//   variable, as config.env sets them). These are never allowed anywhere, in a test or not;
// - patterns: well-known token shapes (cloud keys, git host tokens, private keys, connection strings
//   with a password, high-entropy values assigned to secret-looking names). The noisier ones skip
//   test files, where fake tokens are normal.
import { git } from "./git.ts";

export type Finding = { rule: string; where: string; hint: string };

type Rule = { id: string; re: RegExp; tests?: boolean; check?: (match: RegExpExecArray) => boolean };

/** Documentation values that look like secrets and are not. */
const EXAMPLES = /AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY|EXAMPLE|example|dummy|placeholder|changeme|your[_-]?|<[^>]*>|\$\{|xxxx|\*\*\*\*/;

const entropy = (s: string) => {
	const counts = new Map<string, number>();
	for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
	return bits;
};

const RULES: Rule[] = [
	{ id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
	{ id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ id: "aws-secret-key", re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
	{ id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
	{ id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
	{ id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
	{ id: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
	{ id: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
	{ id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ id: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
	{ id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: "sentry-token", re: /\bsntr[ysu]_[A-Za-z0-9+/=_-]{20,}/ },
	{ id: "clickup-token", re: /\bpk_\d{4,}_[A-Z0-9]{20,}\b/ },
	{ id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*[^\s$]{12,}/ },
	{ id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, tests: false },
	{
		id: "url-with-password",
		re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|https?|ftp):\/\/[^\s:/@'"]+:([^\s@/'"]{6,})@/i,
		check: (m) => !EXAMPLES.test(m[1]!) && !/^(?:pass(?:word)?|secret|test|admin|root|user)$/i.test(m[1]!),
	},
	{
		id: "secret-assignment",
		re: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i,
		tests: false,
		check: (m) => !EXAMPLES.test(m[1]!) && entropy(m[1]!) >= 3.5,
	},
];

/** Files that hold secrets by their nature (an example or template of them is fine). */
const SECRET_FILES = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|config\.env|\.netrc|\.git-credentials|\.pgpass|credentials(?:\.json)?|service[-_]?account.*\.json|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|fixtures?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$/i;

/** The values of the factory's own secrets: variables whose name says token, key, secret or password. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
	return Object.entries(env)
		.filter(([name, value]) => /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY$|PRIVATE|CREDENTIAL|_DSN$/i.test(name) && typeof value === "string" && value.length >= 8)
		.map(([name, value]) => ({ name, value: value!.replace(/^['"]|['"]$/g, "") }))
		.filter((s) => s.value.length >= 8);
}

/** A secret, shown only enough to find it: never the value. */
const mask = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.length} chars`);

/** Findings in one piece of text (a file's added lines, a message, a PR body). */
export function scanText(text: string, where: string, options: { path?: string; known?: { name: string; value: string }[] } = {}): Finding[] {
	const out: Finding[] = [];
	const isTest = options.path !== undefined && TEST_FILE.test(options.path);
	const lines = text.split("\n");
	for (const [i, line] of lines.entries()) {
		const at = lines.length > 1 ? `${where}:${i + 1}` : where;
		for (const s of options.known ?? []) {
			if (line.includes(s.value)) out.push({ rule: "factory-secret", where: at, hint: `the value of ${s.name} from the factory's environment` });
		}
		for (const rule of RULES) {
			if (isTest && rule.tests === false) continue;
			const m = rule.re.exec(line);
			if (m === null || EXAMPLES.test(m[0]) || (rule.check && !rule.check(m))) continue;
			out.push({ rule: rule.id, where: at, hint: mask(m[0]) });
		}
	}
	return out;
}

/** Replace every secret in `text` (the factory's own values and every pattern) with [redacted]. */
export function redact(text: string, known = knownSecrets()): { text: string; count: number } {
	let count = 0;
	let out = text;
	for (const s of known) {
		if (!out.includes(s.value)) continue;
		count += out.split(s.value).length - 1;
		out = out.split(s.value).join("[redacted]");
	}
	for (const rule of RULES) {
		const re = new RegExp(rule.re.source, `${rule.re.flags.replace("g", "")}g`);
		out = out.replace(re, (...args) => {
			const match = args.slice(0, -2) as unknown as RegExpExecArray;
			if (EXAMPLES.test(match[0]) || (rule.check && !rule.check(match))) return match[0];
			count++;
			return "[redacted]";
		});
	}
	return { text: out, count };
}

/**
 * Everything a push would add to the remote: the lines the branch adds (by file and line), the
 * files it adds or changes that hold secrets by nature, and its commit messages. `since` is the
 * ref the remote already has (the base branch, or the branch as last pushed).
 */
export async function scanBranch(worktree: string, since: string, known = knownSecrets()): Promise<Finding[]> {
	const out: Finding[] = [];
	const names = await git(worktree, "diff", "--name-only", "--diff-filter=ACMR", `${since}...HEAD`);
	for (const path of names.stdout.split("\n").filter(Boolean)) {
		if (SECRET_FILES.test(path)) out.push({ rule: "secret-file", where: path, hint: "a file that holds secrets by its nature" });
	}
	const diff = await git(worktree, "diff", "--no-color", "--no-ext-diff", "--unified=0", `${since}...HEAD`);
	let path = "";
	let line = 0;
	for (const row of diff.stdout.split("\n")) {
		if (row.startsWith("+++ ")) {
			path = row.startsWith("+++ b/") ? row.slice(6) : "";
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (row.startsWith("+") && path !== "") {
			out.push(...scanText(row.slice(1), `${path}:${line}`, { path, known }));
			line++;
		}
	}
	const log = await git(worktree, "log", "--format=%h%x00%B%x01", `${since}..HEAD`);
	for (const entry of log.stdout.split("\x01").map((e) => e.trim()).filter(Boolean)) {
		const [sha, message = ""] = entry.split("\x00");
		out.push(...scanText(message, `commit ${sha} message`, { known }).map((f) => ({ ...f, where: `commit ${sha} message` })));
	}
	return out;
}

export const formatFindings = (findings: Finding[]) => findings.slice(0, 50).map((f) => `- ${f.where}: ${f.rule} (${f.hint})`).join("\n") + (findings.length > 50 ? `\n- … and ${findings.length - 50} more` : "");

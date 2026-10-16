// Child process for the SIGKILL test: a factory that starts ticket T-K, whose coder's bash hangs.
// argv: <repo> <data dir>. Prints CODER_RUNNING once the coder's command runs, then waits to be killed.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Factory } from "../../src/host.ts";
import { FakeGitHost, FakeTracker, fauxAgents, lanes, testConfig } from "../support.ts";

const [repo, data] = process.argv.slice(2) as [string, string];
const config = testConfig(repo, data);
const { models } = fauxAgents({ coderSleep: 60 });
const factory = await Factory.open({ config, models, lanes, tracker: new FakeTracker(), gitHost: new FakeGitHost(), sentry: null, log: () => {}, admitPollMs: 50 });
await factory.start("T-K", { gate: false });
for (;;) {
	if (await stat(join(data, "runs", "T-K", "coder-started")).then(() => true, () => false)) {
		process.stdout.write("CODER_RUNNING\n");
		break;
	}
	await new Promise((r) => setTimeout(r, 50));
}
await new Promise(() => {});

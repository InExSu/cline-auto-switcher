// End-to-end test of the hook exactly the way Cline invokes it.
//
// Cline discovers `TaskError.<ext>` in its hooks dir and, for .mjs, spawns
// `["node", <path>]` with the event payload as JSON on stdin. This test
// reproduces that spawn faithfully — a real child process, real stdin, real
// stdout — because the stdout contract is unforgiving: Cline JSON.parses the
// entire stdout and silently drops the control object if it does not parse.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-e2e-"));
const settingsPath = path.join(sandbox, "providers.json");

process.env.ACCOUNT_SWITCHER_HOME = path.join(sandbox, "home");
process.env.CLINE_PROVIDER_SETTINGS_PATH = settingsPath;
process.env.CLINE_HOOKS_DIR = path.join(sandbox, "hooks");
process.env.ACCOUNT_SWITCHER_QUIET = "1";

const { captureCurrent, readVault, writeVault } = await import("../src/vault.mjs");
const { hookFilePath } = await import("../src/paths.mjs");
const { main } = await import("../src/cli.mjs");

const MODEL = "anthropic/claude-opus-4.8";

function writeProviders(accountId) {
	fs.writeFileSync(
		settingsPath,
		`${JSON.stringify(
			{
				version: 1,
				lastUsedProvider: "cline",
				modes: {},
				providers: {
					cline: {
						settings: {
							provider: "cline",
							auth: {
								accessToken: `tok-${accountId}`,
								refreshToken: `ref-${accountId}`,
								expiresAt: Date.now() + 3_600_000,
								accountId,
							},
							model: MODEL,
							reasoning: {},
						},
						updatedAt: new Date().toISOString(),
						tokenSource: "oauth",
					},
				},
			},
			null,
			2,
		)}\n`,
	);
}

/** Run a file with a string on stdin, the way Cline runs a hook. */
function runWithStdin(file, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [file], { env: process.env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

test("installed hook switches accounts when Cline pipes an agent_error", async () => {
	// Enrol two accounts, leaving A live.
	writeProviders("acct-a");
	captureCurrent({ label: "alpha" });
	writeProviders("acct-b");
	captureCurrent({ label: "bravo" });
	writeProviders("acct-a");
	const vault = readVault();
	vault.active = "acct-a";
	writeVault(vault);

	// Install the hook the way a user would.
	assert.equal(await main(["install-hook"]), 0);
	const hookFile = hookFilePath();
	assert.ok(fs.existsSync(hookFile), "hook file should exist");

	// The generated file must be valid ESM that Node can execute directly.
	const payload = JSON.stringify({
		clineVersion: "3.0.62",
		hookName: "agent_error",
		timestamp: new Date().toISOString(),
		taskId: "task-abc",
		workspaceRoots: [sandbox],
		user_id: "user-1",
		agent_id: "agent-1",
		parent_agent_id: null,
		iteration: 3,
		error: { name: "Error", message: "status code 429 - rate limit reached" },
	});

	const result = await runWithStdin(hookFile, payload);
	assert.equal(result.code, 0, `hook should exit 0; stderr: ${result.stderr}`);
	assert.equal(result.stdout, "", "stdout must stay empty in silent mode");

	const live = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(live.providers.cline.settings.auth.accountId, "acct-b");
	assert.equal(live.providers.cline.settings.model, MODEL, "model must be preserved");

	const marker = JSON.parse(
		fs.readFileSync(path.join(process.env.ACCOUNT_SWITCHER_HOME, "pending-switch.json"), "utf8"),
	);
	assert.equal(marker.taskId, "task-abc");
	assert.equal(marker.to, "acct-b");
});

test("installed hook leaves a non-limit error alone", async () => {
	writeProviders("acct-b");
	const vault = readVault();
	vault.active = "acct-b";
	writeVault(vault);

	const result = await runWithStdin(
		hookFilePath(),
		JSON.stringify({ hookName: "agent_error", error: { message: "ENOENT: no such file" } }),
	);

	assert.equal(result.code, 0);
	assert.equal(result.stdout, "");
	const live = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(live.providers.cline.settings.auth.accountId, "acct-b", "no switch expected");
});
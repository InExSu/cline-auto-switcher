// Tests for cline-account-switcher.
//
// Everything runs against a throwaway sandbox: the Cline settings path, hooks
// dir and switcher home are all redirected with env vars, so no real account or
// credentials are ever touched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-test-"));
const settingsPath = path.join(sandbox, "providers.json");

process.env.ACCOUNT_SWITCHER_HOME = path.join(sandbox, "home");
process.env.CLINE_PROVIDER_SETTINGS_PATH = settingsPath;
process.env.CLINE_HOOKS_DIR = path.join(sandbox, "hooks");
process.env.ACCOUNT_SWITCHER_QUIET = "1";

const { classifyError, describeVerdict } = await import("../src/ratelimit.mjs");
const { captureCurrent, readVault, writeVault, readProviderSettings } = await import(
	"../src/vault.mjs"
);
const { rotate, useAccount, resetCooldowns, buildStatus } = await import("../src/switcher.mjs");
const { readLedger, activeCooldown } = await import("../src/ledger.mjs");
const { writeConfig } = await import("../src/config.mjs");
const { pendingSwitchPath } = await import("../src/paths.mjs");
const { runTaskErrorHook } = await import("../src/hook.mjs");
const { main } = await import("../src/cli.mjs");

const MODEL = "anthropic/claude-opus-4.8";
const OTHER_MODEL = "openai/gpt-5.6-sol";

function writeProviders({ accountId, accessToken, refreshToken, model = MODEL }) {
	const settings = {
		version: 1,
		lastUsedProvider: "cline",
		modes: {},
		providers: {
			cline: {
				settings: {
					provider: "cline",
					auth: {
						accessToken,
						refreshToken,
						expiresAt: Date.now() + 3_600_000,
						accountId,
					},
					model,
					reasoning: {},
				},
				updatedAt: new Date().toISOString(),
				tokenSource: "oauth",
			},
		},
	};
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Enrol two accounts and leave account A live in providers.json. */
function seedTwoAccounts() {
	fs.rmSync(path.join(sandbox, "home"), { recursive: true, force: true });
	writeProviders({ accountId: "acct-a", accessToken: "tok-a", refreshToken: "ref-a" });
	captureCurrent({ label: "alpha" });
	writeProviders({ accountId: "acct-b", accessToken: "tok-b", refreshToken: "ref-b" });
	captureCurrent({ label: "bravo" });
	writeProviders({ accountId: "acct-a", accessToken: "tok-a", refreshToken: "ref-a" });
	const vault = readVault();
	vault.active = "acct-a";
	writeVault(vault);
}

async function captureStdout(fn) {
	const chunks = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks.join("");
}

test("classifyError mirrors Cline's rate-limit patterns", () => {
	assert.equal(classifyError("status code 429").isLimit, true);
	assert.equal(classifyError("Rate limit exceeded").isLimit, true);
	assert.equal(classifyError("Too Many Requests").isLimit, true);
	assert.equal(classifyError("quota exceeded for this model").isLimit, true);
	assert.equal(classifyError("Resource exhausted").isLimit, true);
	assert.equal(classifyError("Rate limit exceeded").kind, "rate_limit");
});

test("classifyError treats credits as terminal and auth as non-rotating", () => {
	const credits = classifyError("insufficient_credits: not enough credits");
	assert.equal(credits.isLimit, true);
	assert.equal(credits.terminal, true);

	const spend = classifyError("429 SPEND_LIMIT_EXCEEDED");
	assert.equal(spend.kind, "spend_limit");
	assert.equal(spend.terminal, false);

	const auth = classifyError("invalid api key: requires re-authentication");
	assert.equal(auth.isLimit, false);
	assert.equal(auth.kind, "auth");
});

test("classifyError ignores unrelated errors", () => {
	const verdict = classifyError("ENOENT: no such file or directory");
	assert.equal(verdict.isLimit, false);
	assert.equal(verdict.kind, null);
	assert.equal(describeVerdict(verdict), "ignored (not a limit)");
});

test("captureCurrent stores the OAuth block from providers.json", () => {
	seedTwoAccounts();
	const vault = readVault();
	assert.equal(vault.accounts.length, 2);
	const alpha = vault.accounts.find((a) => a.id === "acct-a");
	assert.ok(alpha, "acct-a should be in the vault");
	assert.equal(alpha.auth.refreshToken, "ref-a");
	assert.equal(alpha.label, "alpha");
	assert.equal(alpha.tokenSource, "oauth");
});

test("rotate parks the burned account for that model only", () => {
	seedTwoAccounts();
	const result = rotate({ kind: "rate_limit" });

	assert.equal(result.rotated, true);
	assert.equal(result.from, "acct-a");
	assert.equal(result.to, "acct-b");
	assert.equal(result.model, MODEL);

	// providers.json now carries account B's credentials.
	const live = readProviderSettings();
	assert.equal(live.providers.cline.settings.auth.accountId, "acct-b");
	assert.equal(live.providers.cline.settings.auth.refreshToken, "ref-b");
	assert.equal(live.lastUsedProvider, "cline");

	// A is cooling for the model in use...
	const ledger = readLedger();
	assert.ok(activeCooldown(ledger, "acct-a", MODEL), "acct-a should be cooling");
	assert.equal(ledger.entries[`acct-a::${MODEL}`].strikes, 1);

	// ...but remains usable for a different model. This is the whole point.
	assert.equal(activeCooldown(ledger, "acct-a", OTHER_MODEL), null);
});

test("repeated limits on the same account back off exponentially", () => {
	seedTwoAccounts();
	rotate({ kind: "rate_limit" });
	const first = readLedger().entries[`acct-a::${MODEL}`].until - Date.now();

	// A hits the limit again on the same model.
	const vault = readVault();
	vault.active = "acct-a";
	writeVault(vault);
	rotate({ kind: "rate_limit" });

	const entry = readLedger().entries[`acct-a::${MODEL}`];
	assert.equal(entry.strikes, 2);
	assert.ok(entry.until - Date.now() > first, "cooldown should grow on the second strike");
});

test("rotate is a no-op with a single account", () => {
	fs.rmSync(path.join(sandbox, "home"), { recursive: true, force: true });
	writeProviders({ accountId: "solo", accessToken: "tok-solo", refreshToken: "ref-solo" });
	captureCurrent({ label: "solo" });

	const result = rotate({ kind: "rate_limit" });
	assert.equal(result.rotated, false);
	assert.equal(result.reason, "no-other-account");
});

test("useAccount and resetCooldowns control state explicitly", () => {
	seedTwoAccounts();
	rotate({ kind: "rate_limit" });
	assert.ok(readLedger().entries[`acct-a::${MODEL}`]);

	useAccount("acct-a");
	assert.equal(readProviderSettings().providers.cline.settings.auth.accountId, "acct-a");
	assert.equal(readVault().active, "acct-a");

	resetCooldowns("acct-a");
	assert.equal(readLedger().entries[`acct-a::${MODEL}`], undefined);
});

test("buildStatus reports the live model and per-account cooling", () => {
	seedTwoAccounts();
	rotate({ kind: "rate_limit" });
	const status = buildStatus();
	assert.equal(status.model, MODEL);
	assert.equal(status.active, "acct-b");
	const a = status.accounts.find((x) => x.id === "acct-a");
	assert.equal(a.coolingFor, MODEL);
	assert.equal(a.active, false);
});

test("hook switches account on a 429 and writes the resume marker", async () => {
	seedTwoAccounts();
	fs.rmSync(pendingSwitchPath(), { force: true });

	const payload = JSON.stringify({
		hookName: "agent_error",
		taskId: "task-123",
		error: { name: "Error", message: "Cline API error: status code 429 Too Many Requests" },
	});

	const stdout = await captureStdout(() =>
		runTaskErrorHook({ readPayload: async () => payload, quiet: true }),
	);

	// Default hookOutput is "silent": stdout must stay completely empty so
	// Cline's JSON.parse of stdout never sees anything unexpected.
	assert.equal(stdout, "");
	assert.equal(readProviderSettings().providers.cline.settings.auth.accountId, "acct-b");

	const marker = JSON.parse(fs.readFileSync(pendingSwitchPath(), "utf8"));
	assert.equal(marker.to, "acct-b");
	assert.equal(marker.from, "acct-a");
	assert.equal(marker.model, MODEL);
	assert.equal(marker.taskId, "task-123");
});

test("hook stays silent on non-limit and auth errors", async () => {
	seedTwoAccounts();
	fs.rmSync(pendingSwitchPath(), { force: true });

	for (const message of [
		"ENOENT: no such file or directory",
		"invalid api key: requires re-authentication",
	]) {
		const stdout = await captureStdout(() =>
			runTaskErrorHook({
				readPayload: async () => JSON.stringify({ hookName: "agent_error", error: { message } }),
				quiet: true,
			}),
		);
		assert.equal(stdout, "");
		assert.equal(fs.existsSync(pendingSwitchPath()), false);
		assert.equal(readProviderSettings().providers.cline.settings.auth.accountId, "acct-a");
	}
});

test("hook emits parseable control JSON when hookOutput=context", async () => {
	seedTwoAccounts();
	writeConfig({ hookOutput: "context" });
	try {
		const stdout = await captureStdout(() =>
			runTaskErrorHook({
				readPayload: async () =>
					JSON.stringify({ hookName: "agent_error", error: { message: "rate limit" } }),
				quiet: true,
			}),
		);
		// The whole stdout must be one JSON object, which is exactly what
		// Cline's parser expects.
		const control = JSON.parse(stdout);
		assert.ok(control.contextModification.includes("acct-b"));
	} finally {
		writeConfig({ hookOutput: "silent" });
	}
});

test("CLI check command classifies a message", async () => {
	const stdout = await captureStdout(() => main(["check", "status code 429"]));
	assert.match(stdout, /isLimit : true/);
});

test("CLI status command runs end to end", async () => {
	seedTwoAccounts();
	const stdout = await captureStdout(() => main(["status"]));
	assert.match(stdout, /acct-a/);
	assert.match(stdout, /acct-b/);
	assert.match(stdout, new RegExp(MODEL.replace(/[/.]/g, "\\$&")));
});
// Tests for the demo-data guard: synthetic credentials must never be able to
// overwrite the real per-user Cline files (that data loss actually happened
// once, which is why the guard exists).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-guard-"));
process.env.ACCOUNT_SWITCHER_HOME = path.join(sandbox, "home");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(sandbox, "providers.json");
process.env.ACCOUNT_SWITCHER_QUIET = "1";

const { assertRealAccount, writeVault, writeProviderSettings } = await import(
	"../src/vault.mjs"
);

const DEMO_EMAILS = ["ada@example.com", "grace@studio.example", "alan@example.com"];

test("demo data cannot reach the real Cline files", () => {
	// The guard only bites when writes would land in the real per-user files,
	// i.e. when no sandbox override is set. Clear them for the duration; nothing
	// here performs file IO while they are clear — the guard throws first.
	const saved = { ...process.env };
	for (const key of ["ACCOUNT_SWITCHER_HOME", "CLINE_PROVIDER_SETTINGS_PATH", "CLINE_DATA_DIR", "CLINE_DIR"]) {
		delete process.env[key];
	}
	try {
		for (const email of DEMO_EMAILS) {
			assert.throws(
				() => assertRealAccount({ email, auth: { refreshToken: "refresh-acct-x" } }),
				/demo data|synthetic refresh token/,
			);
		}
		assert.throws(
			() =>
				assertRealAccount({
					email: "real@gmail.com",
					auth: { refreshToken: "refresh-acct-personal" },
				}),
			/synthetic refresh token/,
		);
		assert.doesNotThrow(() =>
			assertRealAccount({
				email: "real.person@gmail.com",
				auth: { refreshToken: "a real token shape" },
			}),
		);
		assert.doesNotThrow(() => assertRealAccount({ email: null, auth: null }));

		assert.throws(
			() =>
				writeVault({
					version: 1,
					active: null,
					accounts: [
						{
							id: "acct-personal",
							email: DEMO_EMAILS[0],
							auth: { refreshToken: "refresh-acct-personal" },
						},
					],
				}),
			/demo data/,
		);
		assert.throws(
			() =>
				writeProviderSettings({
					providers: { cline: { settings: { auth: { refreshToken: "refresh-acct-work" } } } },
				}),
			/synthetic refresh token/,
		);
	} finally {
		Object.assign(process.env, saved);
	}
});
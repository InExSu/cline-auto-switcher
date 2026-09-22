// Tests for the dashboard: credential mapping, the page itself, and the server's
// routes and access control.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-dash-"));
const settingsPath = path.join(sandbox, "providers.json");

process.env.ACCOUNT_SWITCHER_HOME = path.join(sandbox, "home");
process.env.CLINE_PROVIDER_SETTINGS_PATH = settingsPath;
process.env.CLINE_HOOKS_DIR = path.join(sandbox, "hooks");
process.env.ACCOUNT_SWITCHER_QUIET = "1";

const { toProviderAuth, credentialEmail } = await import("../src/clineauth.mjs");
const { upsertAccount, readVault, captureCurrent } = await import("../src/vault.mjs");
const { createServer } = await import("../src/server.mjs");
const { renderPage } = await import("../src/ui.mjs");

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

const CREDENTIALS = {
	access: "access-token-value",
	refresh: "refresh-token-value",
	expires: 1789731457000,
	accountId: "acct-google-1",
	email: "person@example.com",
	metadata: {
		tokenType: "Bearer",
		userInfo: { email: "person@example.com", name: "Person", clineUserId: "acct-google-1" },
	},
};

test("toProviderAuth maps device credentials onto the providers.json shape", () => {
	const auth = toProviderAuth(CREDENTIALS);
	assert.equal(auth.accessToken, "access-token-value");
	assert.equal(auth.refreshToken, "refresh-token-value");
	assert.equal(auth.expiresAt, 1789731457000);
	assert.equal(auth.accountId, "acct-google-1");
	assert.equal(auth.metadata.userInfo.email, "person@example.com");
	assert.equal(credentialEmail(CREDENTIALS), "person@example.com");
});

test("toProviderAuth falls back to clineUserId when accountId is absent", () => {
	const auth = toProviderAuth({ ...CREDENTIALS, accountId: undefined });
	assert.equal(auth.accountId, "acct-google-1");
});

test("upsertAccount adds once and updates on repeat sign-in", () => {
	const first = upsertAccount({
		auth: toProviderAuth(CREDENTIALS),
		email: "person@example.com",
	});
	assert.equal(first.created, true);
	assert.equal(first.account.id, "acct-google-1");

	const second = upsertAccount({
		auth: toProviderAuth(CREDENTIALS),
		email: "person@example.com",
	});
	assert.equal(second.created, false);
	assert.equal(readVault().accounts.length, 1);
});

test("renderPage injects the token and leaves no placeholders", () => {
	const html = renderPage({ token: "tok-abc" });
	assert.match(html, /"tok-abc"/);
	assert.doesNotMatch(html, /__TOKEN__/);
	assert.doesNotMatch(html, /__BODY__/);
	assert.match(html, /Cline accounts/);
	assert.match(html, /Open sign-in page/);
	assert.match(html, /x-switcher-token/);
	assert.match(html, /id="rotate"/);
	assert.match(html, /clear cooldowns/);
});

test("the page embeds as valid JavaScript", () => {
	const html = renderPage({ token: "tok-abc" });
	const script = html.split("<script>")[1].split("</script>")[0];
	// Throws if the embedded script has a syntax error.
	assert.doesNotThrow(() => new Function(script));
});

test("server serves the page but requires the token for the API", async (t) => {
	writeProviders("acct-a");
	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const page = await fetch(info.url);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Cline accounts/);

	const denied = await fetch(`${info.url}api/state`);
	assert.equal(denied.status, 403);

	const allowed = await fetch(`${info.url}api/state`, {
		headers: { "x-switcher-token": instance.token },
	});
	assert.equal(allowed.status, 200);
	const state = await allowed.json();
	assert.ok(Array.isArray(state.accounts));
	assert.equal(state.model, MODEL, "model comes from providers.json");
});

test("server rejects a cross-origin caller even with a valid token", async (t) => {
	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const response = await fetch(`${info.url}api/state`, {
		headers: { "x-switcher-token": instance.token, origin: "https://evil.example" },
	});
	assert.equal(response.status, 403);
});

test("server returns 404 for unknown routes", async (t) => {
	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const response = await fetch(`${info.url}api/nope`, {
		headers: { "x-switcher-token": instance.token },
	});
	assert.equal(response.status, 404);
});

test("POST /api/switch switches the live account over HTTP", async (t) => {
	// Enrol two accounts and leave A live.
	fs.rmSync(process.env.ACCOUNT_SWITCHER_HOME, { recursive: true, force: true });
	writeProviders("acct-a");
	captureCurrent({ label: "alpha" });
	writeProviders("acct-b");
	captureCurrent({ label: "bravo" });
	writeProviders("acct-a");

	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const response = await fetch(`${info.url}api/switch`, {
		method: "POST",
		headers: { "x-switcher-token": instance.token, "content-type": "application/json" },
		body: JSON.stringify({ id: "acct-b" }),
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json()).to, "acct-b");

	const live = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.equal(live.providers.cline.settings.auth.accountId, "acct-b");
	assert.equal(live.providers.cline.settings.model, MODEL);
});

test("POST /api/rotate and /api/cooldowns/reset work over HTTP", async (t) => {
	fs.rmSync(process.env.ACCOUNT_SWITCHER_HOME, { recursive: true, force: true });
	writeProviders("acct-a");
	captureCurrent({ label: "alpha" });
	writeProviders("acct-b");
	captureCurrent({ label: "bravo" });
	writeProviders("acct-a");

	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const headers = { "x-switcher-token": instance.token, "content-type": "application/json" };
	const rotated = await fetch(`${info.url}api/rotate`, { method: "POST", headers, body: "{}" });
	assert.equal(rotated.status, 200);
	const result = await rotated.json();
	assert.equal(result.rotated, true);
	assert.notEqual(result.to, result.from, "rotation moves to a different account");
	assert.equal(
		JSON.parse(fs.readFileSync(settingsPath, "utf8")).providers.cline.settings.auth.accountId,
		result.to,
	);

	// Rotating away parked the burned account for the live model...
	const parked = readVault().accounts.find((a) => a.id === result.from);
	assert.ok(parked, "the burned account is still enrolled");
	assert.notEqual(Object.keys((await import("../src/ledger.mjs")).readLedger().entries).length, 0);

	// ...so a reset has something to clear and reports the count.
	const cleared = await fetch(`${info.url}api/cooldowns/reset`, { method: "POST", headers, body: "{}" });
	assert.equal(cleared.status, 200);
	assert.equal((await cleared.json()).cleared >= 1, true);
});

test("POST /api/accounts/remove reports an unknown id", async (t) => {
	const instance = createServer();
	const info = await instance.listen(0);
	t.after(() => instance.server.close());

	const response = await fetch(`${info.url}api/accounts/remove`, {
		method: "POST",
		headers: { "x-switcher-token": instance.token, "content-type": "application/json" },
		body: JSON.stringify({ id: "does-not-exist" }),
	});
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /Unknown account/);
});
// The account vault.
//
// Each entry is a snapshot of the `settings.auth` block from providers.json for
// one Cline account. Cline refreshes the access token from `refreshToken`
// itself (5 minute buffer), so storing the refresh token is enough to make an
// account reusable indefinitely.

import { vaultPath, providerSettingsPath } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./jsonfile.mjs";

const EMPTY_VAULT = { version: 1, active: null, accounts: [] };

// Demo/fixture emails and token shapes. Google accounts cannot live on an
// example.com TLD, and no real Cline refresh token starts with "refresh-acct-",
// so anything matching below is documentation sample data.
const DEMO_EMAIL_DOMAINS = ["@example.com", "@example.example"];
const DEMO_TOKEN_RE = /^refresh-acct-/;

/**
 * True when writes would land in the real per-user Cline files (no sandbox env
 * override is in effect). Demo data must never reach them.
 */
function writingRealFiles() {
	return (
		process.env.ACCOUNT_SWITCHER_HOME === undefined &&
		process.env.CLINE_PROVIDER_SETTINGS_PATH === undefined &&
		process.env.CLINE_DATA_DIR === undefined &&
		process.env.CLINE_DIR === undefined
	);
}

/**
 * Refuse obviously synthetic credentials when they would otherwise overwrite
 * the real providers.json or vault. This exists because a demo seed once ran
 * without its sandbox env vars and clobbered the real auth block; the guard
 * turns that failure mode from silent data loss into a loud error.
 *
 * @param {{ auth?: object|null, email?: string|null }} account
 */
export function assertRealAccount(account) {
	if (!writingRealFiles()) return;
	const auth = account?.auth ?? {};
	const email = String(
		account?.email ?? auth?.metadata?.userInfo?.email ?? "",
	).toLowerCase();
	if (DEMO_EMAIL_DOMAINS.some((domain) => email.endsWith(domain))) {
		throw new Error(
			`Refusing to write "${email}" to the real Cline files: that looks like ` +
				"demo data. Point ACCOUNT_SWITCHER_HOME and CLINE_PROVIDER_SETTINGS_PATH " +
				"at a sandbox directory, or sign in to a real account.",
		);
	}
	if (typeof auth.refreshToken === "string" && DEMO_TOKEN_RE.test(auth.refreshToken)) {
		throw new Error(
			"Refusing to write a synthetic refresh token to the real Cline files. " +
				"Set ACCOUNT_SWITCHER_HOME and CLINE_PROVIDER_SETTINGS_PATH for demo data.",
		);
	}
}

export function readVault() {
	const stored = readJson(vaultPath(), null);
	if (!stored || typeof stored !== "object") return structuredClone(EMPTY_VAULT);
	return {
		...structuredClone(EMPTY_VAULT),
		...stored,
		accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
	};
}

export function writeVault(vault) {
	for (const account of vault?.accounts ?? []) assertRealAccount(account);
	writeJsonAtomic(vaultPath(), vault);
	return vault;
}

export function readProviderSettings() {
	const settings = readJson(providerSettingsPath(), null);
	if (!settings) {
		throw new Error(
			`No Cline provider settings at ${providerSettingsPath()}. Run \`cline auth\` first.`,
		);
	}
	return settings;
}

export function writeProviderSettings(settings) {
	for (const entry of Object.values(settings?.providers ?? {})) {
		assertRealAccount(entry?.settings ?? {});
	}
	writeJsonAtomic(providerSettingsPath(), settings);
	return settings;
}

export function slugify(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function findAccount(vault, id) {
	return vault.accounts.find((a) => a.id === id) ?? null;
}

/**
 * Capture the credentials currently sitting in providers.json into the vault.
 *
 * This is how accounts get enrolled: authenticate with `cline auth`, capture,
 * authenticate as the next account, capture again.
 */
export function captureCurrent({ label, providerId = "cline" } = {}) {
	const settings = readProviderSettings();
	const entry = settings?.providers?.[providerId];
	if (!entry) {
		throw new Error(
			`Provider "${providerId}" is not present in ${providerSettingsPath()}.`,
		);
	}

	const auth = entry.settings?.auth ?? {};
	const apiKey = auth.apiKey ?? entry.settings?.apiKey ?? null;
	const hasOauth = Boolean(auth.refreshToken || auth.accessToken);
	if (!hasOauth && !apiKey) {
		throw new Error(
			`Provider "${providerId}" has neither OAuth tokens nor an API key to capture.`,
		);
	}

	const identity = auth.accountId || label;
	if (!identity) {
		throw new Error(
			"Could not determine an account id. Pass --label <name> so the account can be tracked.",
		);
	}

	const id = slugify(identity);
	const vault = readVault();
	const existing = findAccount(vault, id);
	const now = new Date().toISOString();

	const account = {
		id,
		label: label ?? existing?.label ?? id,
		providerId,
		tokenSource: entry.tokenSource ?? null,
		model: entry.settings?.model ?? null,
		email: auth.metadata?.userInfo?.email ?? existing?.email ?? null,
		name: auth.metadata?.userInfo?.name ?? existing?.name ?? null,
		auth: hasOauth ? { ...auth } : undefined,
		apiKey: hasOauth ? undefined : apiKey,
		addedAt: existing?.addedAt ?? now,
		updatedAt: now,
	};

	if (existing) Object.assign(existing, account);
	else vault.accounts.push(account);

	if (!vault.active) vault.active = id;
	writeVault(vault);
	return { account, created: !existing };
}

export function removeAccount(vault, id) {
	const before = vault.accounts.length;
	vault.accounts = vault.accounts.filter((a) => a.id !== id);
	if (vault.active === id) vault.active = vault.accounts[0]?.id ?? null;
	return before !== vault.accounts.length;
}

/**
 * Insert or update an account from an already-built auth block.
 *
 * Used by the dashboard's sign-in flow, where the credentials come straight from
 * Cline's device authorization rather than from providers.json.
 */
export function upsertAccount({
	auth,
	email,
	name,
	label,
	providerId = "cline",
	tokenSource = "oauth",
	model = null,
}) {
	const identity = auth?.accountId || email || label;
	if (!identity) {
		throw new Error("Could not identify the account: no accountId, email or label.");
	}

	const id = slugify(identity);
	const vault = readVault();
	const existing = findAccount(vault, id);
	const now = new Date().toISOString();

	const account = {
		id,
		label: label ?? email ?? existing?.label ?? id,
		providerId,
		tokenSource,
		model: model ?? existing?.model ?? null,
		email: email ?? existing?.email ?? null,
		name: name ?? existing?.name ?? null,
		auth: auth ? { ...auth } : undefined,
		apiKey: undefined,
		addedAt: existing?.addedAt ?? now,
		updatedAt: now,
	};

	if (existing) Object.assign(existing, account);
	else vault.accounts.push(account);

	if (!vault.active) vault.active = id;
	writeVault(vault);
	return { account, created: !existing };
}

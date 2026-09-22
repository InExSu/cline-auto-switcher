// The switching engine: choose the next healthy account and write it into
// providers.json.

import { readConfig } from "./config.mjs";
import {
	readVault,
	writeVault,
	readProviderSettings,
	writeProviderSettings,
	findAccount,
} from "./vault.mjs";
import { providerSettingsPath } from "./paths.mjs";
import {
	readLedger,
	writeLedger,
	activeCooldown,
	markCooldown,
	cooldownKey,
	nextCooldownMs,
	pruneLedger,
	clearAccount,
} from "./ledger.mjs";

export function loadContext() {
	const config = readConfig();
	const vault = readVault();
	const ledger = pruneLedger(readLedger());
	return { config, vault, ledger };
}

/** The model the current session is using — read from providers.json. */
export function currentModel(providers, providerId) {
	return providers?.providers?.[providerId]?.settings?.model ?? null;
}

export function currentAccountId(providers, providerId) {
	return providers?.providers?.[providerId]?.settings?.auth?.accountId ?? null;
}

/**
 * Return a copy of the provider settings with `account`'s credentials installed.
 * Everything else (model, reasoning, other providers) is preserved.
 */
export function applyAccount(providers, account, providerId) {
	const next = structuredClone(providers);
	next.providers = next.providers ?? {};
	const entry = next.providers[providerId];
	if (!entry) {
		throw new Error(`Provider "${providerId}" is not present in provider settings.`);
	}
	entry.settings = entry.settings ?? {};
	if (account.auth) entry.settings.auth = { ...account.auth };
	else if (account.apiKey) entry.settings.auth = { apiKey: account.apiKey };
	if (account.tokenSource) entry.tokenSource = account.tokenSource;
	entry.updatedAt = new Date().toISOString();
	next.lastUsedProvider = providerId;
	return next;
}

/**
 * Pick the best next account.
 *
 * Preference order:
 *   1. accounts with no cooldown at all for this model
 *   2. (degraded) the account whose cooldown expires soonest, so work continues
 *
 * Among usable candidates we take the least-recently-used one, which spreads
 * load evenly instead of hammering a single account.
 */
export function selectAccount(ctx, { model, currentId, exclude = [] } = {}) {
	const now = Date.now();
	const candidates = ctx.vault.accounts.filter(
		(a) => a.id !== currentId && !exclude.includes(a.id),
	);
	if (candidates.length === 0) return null;

	const scored = candidates.map((account) => {
		const cooldown = activeCooldown(ctx.ledger, account.id, model, now);
		return { account, cooldown, usable: !cooldown };
	});

	const usable = scored.filter((s) => s.usable);
	if (usable.length > 0) {
		usable.sort((a, b) =>
			(a.account.lastUsedAt ?? "").localeCompare(b.account.lastUsedAt ?? ""),
		);
		return { account: usable[0].account, degraded: false, cooldown: null };
	}

	scored.sort((a, b) => (a.cooldown?.until ?? 0) - (b.cooldown?.until ?? 0));
	return { account: scored[0].account, degraded: true, cooldown: scored[0].cooldown };
}

/** Switch to a specific account and record that it was used. */
export function useAccount(id) {
	const ctx = loadContext();
	const account = findAccount(ctx.vault, id);
	if (!account) throw new Error(`Unknown account "${id}".`);

	const providers = readProviderSettings();
	writeProviderSettings(applyAccount(providers, account, ctx.config.providerId));

	account.lastUsedAt = new Date().toISOString();
	ctx.vault.active = account.id;
	writeVault(ctx.vault);
	return { to: account.id, model: currentModel(providers, ctx.config.providerId) };
}

/**
 * The reaction to a rate limit: park the account that just failed for this
 * model, then switch to a healthy one.
 */
export function rotate({ model, kind, terminal = false } = {}) {
	const ctx = loadContext();
	const providerId = ctx.config.providerId;
	const providers = readProviderSettings();
	const modelInUse = model ?? currentModel(providers, providerId);
	const from = ctx.vault.active ?? currentAccountId(providers, providerId);

	// Park the burned account for this specific model.
	if (from) {
		const strikes = ctx.ledger.entries[cooldownKey(from, modelInUse)]?.strikes ?? 0;
		const capMs = terminal ? ctx.config.terminalCooldownMs : ctx.config.maxCooldownMs;
		const waitMs = nextCooldownMs(ctx.config.baseCooldownMs, strikes, capMs);
		markCooldown(
			ctx.ledger,
			from,
			modelInUse,
			Date.now() + waitMs,
			kind ?? "rate_limit",
			terminal,
		);
		writeLedger(ctx.ledger);
	}

	const pick = selectAccount(ctx, { model: modelInUse, currentId: from });
	if (!pick) {
		return {
			rotated: false,
			reason: ctx.vault.accounts.length === 0 ? "no-accounts" : "no-other-account",
			from,
			to: null,
			model: modelInUse,
		};
	}

	writeProviderSettings(applyAccount(providers, pick.account, providerId));

	pick.account.lastUsedAt = new Date().toISOString();
	ctx.vault.active = pick.account.id;
	writeVault(ctx.vault);

	return {
		rotated: true,
		from,
		to: pick.account.id,
		model: modelInUse,
		degraded: pick.degraded,
		cooldownUntil: pick.cooldown?.until ?? null,
	};
}

/** Clear cooldowns for one account, or all of them. */
export function resetCooldowns(accountId) {
	if (!accountId) {
		const cleared = Object.keys(readLedger().entries).length;
		writeLedger({ version: 1, entries: {} });
		return cleared;
	}
	const ledger = readLedger();
	const removed = clearAccount(ledger, accountId);
	writeLedger(ledger);
	return removed;
}

/** A snapshot for the `status` command. */
export function buildStatus() {
	const ctx = loadContext();
	const providers = readProviderSettings();
	const model = currentModel(providers, ctx.config.providerId);
	const liveAuthId = currentAccountId(providers, ctx.config.providerId);
	const now = Date.now();

	const accounts = ctx.vault.accounts.map((account) => {
		const cooldown = activeCooldown(ctx.ledger, account.id, model, now);
		return {
			id: account.id,
			label: account.label,
			email: account.email ?? null,
			name: account.name ?? null,
			active: account.id === ctx.vault.active,
			inProvidersJson: Boolean(liveAuthId) && account.auth?.accountId === liveAuthId,
			model: account.model,
			lastUsedAt: account.lastUsedAt ?? null,
			coolingFor: cooldown ? cooldown.model : null,
			coolingUntil: cooldown ? cooldown.until : null,
			terminal: Boolean(cooldown?.terminal),
			reason: cooldown?.reason ?? null,
			strikes: cooldown?.strikes ?? 0,
		};
	});

	return {
		providerId: ctx.config.providerId,
		providerSettingsPath: providerSettingsPath(),
		model,
		active: ctx.vault.active,
		accounts,
	};
}
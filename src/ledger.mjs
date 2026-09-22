// Cooldown ledger.
//
// Limits are recorded per (account, model) pair, because Cline's rate limits are
// frequently per-model: an account throttled on one model can still serve
// another. `model: null` means "the whole account is limited".

import { cooldownsPath } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./jsonfile.mjs";

const EMPTY_LEDGER = { version: 1, entries: {} };

export function readLedger() {
	const stored = readJson(cooldownsPath(), null);
	if (!stored || typeof stored !== "object") return structuredClone(EMPTY_LEDGER);
	return {
		...structuredClone(EMPTY_LEDGER),
		...stored,
		entries: stored.entries && typeof stored.entries === "object" ? stored.entries : {},
	};
}

export function writeLedger(ledger) {
	writeJsonAtomic(cooldownsPath(), ledger);
	return ledger;
}

export function cooldownKey(accountId, model) {
	return `${accountId}::${model || "*"}`;
}

/**
 * Exponential backoff: base * 2^strikes, capped. `strikes` is the count of
 * *previous* limits for this key, so the first limit uses the base delay.
 */
export function nextCooldownMs(baseMs, strikes, capMs) {
	const raw = baseMs * 2 ** Math.max(0, strikes);
	return Math.min(raw, capMs);
}

export function markCooldown(ledger, accountId, model, untilMs, reason, terminal = false) {
	const key = cooldownKey(accountId, model);
	const previous = ledger.entries[key];
	ledger.entries[key] = {
		accountId,
		model: model || "*",
		until: Math.max(untilMs, previous?.until ?? 0),
		reason: reason ?? previous?.reason ?? null,
		terminal: Boolean(terminal || previous?.terminal),
		strikes: (previous?.strikes ?? 0) + 1,
		updatedAt: new Date().toISOString(),
	};
	return ledger.entries[key];
}

/**
 * The cooldown blocking this account for this model, if any.
 * Checks the exact model first, then the account-wide bucket.
 */
export function activeCooldown(ledger, accountId, model, now = Date.now()) {
	const keys = [cooldownKey(accountId, model), cooldownKey(accountId, null)];
	for (const key of keys) {
		const entry = ledger.entries[key];
		if (!entry) continue;
		if (entry.terminal || entry.until > now) return entry;
	}
	return null;
}

export function clearAccount(ledger, accountId) {
	let removed = 0;
	for (const key of Object.keys(ledger.entries)) {
		if (ledger.entries[key].accountId === accountId) {
			delete ledger.entries[key];
			removed += 1;
		}
	}
	return removed;
}

/** Drop entries that have expired and are not terminal. */
export function pruneLedger(ledger, now = Date.now()) {
	for (const [key, entry] of Object.entries(ledger.entries)) {
		if (!entry.terminal && entry.until <= now) delete ledger.entries[key];
	}
	return ledger;
}

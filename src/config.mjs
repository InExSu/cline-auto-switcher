// User-tunable behaviour, stored in ~/.cline-account-switcher/config.json.

import { configPath } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./jsonfile.mjs";

export const DEFAULT_CONFIG = {
	version: 1,
	/** Which provider entry in providers.json is treated as the pooled account. */
	providerId: "cline",
	/** First cooldown applied after a single 429. */
	baseCooldownMs: 60_000,
	/** Ceiling for exponential backoff on repeated limits. */
	maxCooldownMs: 60 * 60 * 1000,
	/** Parking time for accounts that are out of credits entirely. */
	terminalCooldownMs: 24 * 60 * 60 * 1000,
	/**
	 * What the hook writes to stdout.
	 *   "silent"  -> nothing (default; safest, Cline's own error UI is untouched)
	 *   "context" -> a contextModification telling the agent the account changed
	 */
	hookOutput: "silent",
	/** Max auto-resumes performed by `cline-switch run`. */
	maxAttempts: 5,
	/** Prompt used when resuming a task after a switch. */
	continuePrompt: "continue",
};

export function readConfig() {
	const stored = readJson(configPath(), null);
	return { ...DEFAULT_CONFIG, ...(stored && typeof stored === "object" ? stored : {}) };
}

export function writeConfig(patch) {
	const next = { ...readConfig(), ...patch, version: 1 };
	writeJsonAtomic(configPath(), next);
	return next;
}

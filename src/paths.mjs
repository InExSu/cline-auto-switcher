// Every filesystem location the switcher touches.
//
// These deliberately mirror the resolution functions shipped in
// @cline/shared/dist/storage/paths.js so the switcher reads and writes exactly
// the same files the Cline CLI does:
//
//   resolveProviderSettingsPath() -> $CLINE_PROVIDER_SETTINGS_PATH ?? <dataDir>/settings/providers.json
//   resolveHooksConfigSearchPaths() -> [<clineDir>/hooks, ...]
//
// All of them are functions (not module-level constants) so tests can point the
// whole system at a throwaway directory by setting env vars first.

import os from "node:os";
import path from "node:path";

function env(name) {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Root Cline directory. Defaults to `~/.cline`, matching `setClineDir`. */
export function clineDir() {
	return env("CLINE_DIR") ?? path.join(os.homedir(), ".cline");
}

/** Cline data directory. `CLINE_DATA_DIR` replaces `~/.cline/data/`. */
export function clineDataDir() {
	return env("CLINE_DATA_DIR") ?? path.join(clineDir(), "data");
}

/** The file holding provider credentials and the active model. */
export function providerSettingsPath() {
	return (
		env("CLINE_PROVIDER_SETTINGS_PATH") ??
		path.join(clineDataDir(), "settings", "providers.json")
	);
}

/** Global hooks directory — what `cline --hooks-dir` defaults to. */
export function hooksDir() {
	return env("CLINE_HOOKS_DIR") ?? path.join(clineDir(), "hooks");
}

/** Private home for the vault, ledger and logs. */
export function switcherHome() {
	return env("ACCOUNT_SWITCHER_HOME") ?? path.join(os.homedir(), ".cline-account-switcher");
}

export function vaultPath() {
	return path.join(switcherHome(), "accounts.json");
}

export function cooldownsPath() {
	return path.join(switcherHome(), "cooldowns.json");
}

export function configPath() {
	return path.join(switcherHome(), "config.json");
}

export function logPath() {
	return path.join(switcherHome(), "switcher.log");
}

/** Written by the TaskError hook, consumed by the `run` supervisor. */
export function pendingSwitchPath() {
	return path.join(switcherHome(), "pending-switch.json");
}

/** The hook file Cline discovers. Extension `.mjs` => executed as `node <path>`. */
export function hookFilePath() {
	return path.join(hooksDir(), "TaskError.mjs");
}

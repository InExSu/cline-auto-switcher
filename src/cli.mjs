// Command line interface for the switcher.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readConfig, writeConfig, DEFAULT_CONFIG } from "./config.mjs";
import { classifyError, describeVerdict, RATE_LIMIT_PATTERNS } from "./ratelimit.mjs";
import {
	captureCurrent,
	readVault,
	writeVault,
	removeAccount,
} from "./vault.mjs";
import { buildStatus, rotate, useAccount, resetCooldowns } from "./switcher.mjs";
import { readJson, removeIfExists } from "./jsonfile.mjs";
import {
	switcherHome,
	vaultPath,
	cooldownsPath,
	configPath,
	logPath,
	pendingSwitchPath,
	hookFilePath,
	hooksDir,
	providerSettingsPath,
	clineDir,
} from "./paths.mjs";

const USAGE = `cline-account-switcher - rotate Cline accounts when a model's rate limit is hit

Usage: cline-switch <command> [options]

Setup
  init                      Create the switcher home directory
  capture [--label L]       Save the account currently in providers.json
  install-hook              Install the TaskError hook into Cline's hooks dir
  uninstall-hook            Remove that hook

Dashboard
  serve [--port N]          Open the dashboard (alias: dashboard)

Daily use
  status                    Show accounts, cooldowns and the live account
  accounts                  List pooled accounts
  use <id>                  Switch to a specific account now
  rotate                    Force a switch to the next healthy account
  reset [<id>]              Clear cooldowns (all accounts, or one)

Automation
  run -- <cline args...>    Run cline, auto-resuming the session after a switch

Config
  config [key value]        Show or set options

Diagnostics
  check [message]           Explain how a message would be classified
  where                     Print every path in use
`;

/** Minimal flag parser. Returns { flags, positional }. */
function parseArgs(args) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (token === "--") {
			// Everything after `--` belongs to the wrapped command.
			positional.push(...args.slice(i + 1));
			break;
		}
		if (token.startsWith("--")) {
			const name = token.slice(2);
			// Support the conventional negation form: --no-open sets open=false.
			if (name.startsWith("no-")) {
				flags[name.slice(3)] = false;
				continue;
			}
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags[name] = true;
			} else {
				flags[name] = next;
				i += 1;
			}
		} else {
			positional.push(token);
		}
	}
	return { flags, positional };
}

function ensureHome() {
	fs.mkdirSync(switcherHome(), { recursive: true });
	return switcherHome();
}

function ok(message) {
	process.stdout.write(`${message}\n`);
}

function cmdInit() {
	ensureHome();
	writeVault(readVault());
	ok(`Switcher home:  ${switcherHome()}`);
	ok(`Vault:          ${vaultPath()}`);
	ok(`Cooldowns:      ${cooldownsPath()}`);
	ok(`Cline dir:      ${clineDir()}`);
	ok(`providers.json: ${providerSettingsPath()}`);
	ok("");
	ok("Next: run `cline auth` for your first account, then `cline-switch capture --label work`.");
	return 0;
}

function cmdCapture(flags) {
	ensureHome();
	const config = readConfig();
	const { account, created } = captureCurrent({
		label: typeof flags.label === "string" ? flags.label : undefined,
		providerId: config.providerId,
	});
	ok(`${created ? "Added" : "Updated"} account "${account.id}" (label "${account.label}").`);
	const vault = readVault();
	if (vault.accounts.length < 2) {
		ok("");
		ok("Only one account so far. To pool more:");
		ok("  1. cline auth                      # sign in as the next account");
		ok("  2. cline-switch capture --label <name>");
	}
	return 0;
}

function cmdAccounts() {
	const vault = readVault();
	if (vault.accounts.length === 0) {
		ok("No accounts captured yet. Run `cline-switch capture`.");
		return 0;
	}
	for (const account of vault.accounts) {
		const marker = account.id === vault.active ? "*" : " ";
		const kind = account.auth ? "oauth" : "api-key";
		ok(`${marker} ${account.id.padEnd(28)} ${kind.padEnd(8)} ${account.label ?? ""}`);
	}
	return 0;
}

function cmdStatus() {
	const status = buildStatus();
	ok(`provider: ${status.providerId}    model: ${status.model ?? "(unknown)"}`);
	ok(`settings: ${status.providerSettingsPath}`);
	ok("");
	if (status.accounts.length === 0) {
		ok("No accounts captured yet. Run `cline-switch capture`.");
		return 0;
	}
	ok("  id                            active  cooling");
	for (const account of status.accounts) {
		const active = account.active ? "yes" : "no";
		let cooling = "-";
		if (account.coolingFor) {
			const secs = Math.max(
				0,
				Math.round((Date.parse(account.coolingUntil) - Date.now()) / 1000),
			);
			const suffix = account.terminal ? ", terminal" : "";
			cooling = `${account.coolingFor} for ${secs}s (${account.reason}${suffix})`;
		}
		ok(`  ${account.id.padEnd(28)}  ${active.padEnd(6)}  ${cooling}`);
	}
	return 0;
}

function cmdUse(id) {
	if (!id) throw new Error("Usage: cline-switch use <account-id>");
	const result = useAccount(id);
	ok(`Now using "${result.to}" for model "${result.model ?? "(unknown)"}".`);
	return 0;
}

function cmdRotate() {
	const result = rotate({ kind: "manual" });
	if (!result.rotated) {
		ok(`Could not rotate: ${result.reason}.`);
		return 1;
	}
	ok(`Rotated ${result.from ?? "(none)"} -> ${result.to} for model "${result.model}".`);
	return 0;
}

function cmdRemove(id) {
	if (!id) throw new Error("Usage: cline-switch remove <account-id>");
	const vault = readVault();
	if (!removeAccount(vault, id)) throw new Error(`Unknown account "${id}".`);
	writeVault(vault);
	ok(`Removed "${id}".`);
	return 0;
}

function cmdReset(id) {
	const cleared = resetCooldowns(id);
	const noun = cleared === 1 ? "entry" : "entries";
	ok(`Cleared ${cleared} cooldown ${noun}${id ? ` for "${id}"` : ""}.`);
	return 0;
}

function cmdConfig(positional) {
	if (positional.length === 0) {
		ok(JSON.stringify(readConfig(), null, 2));
		return 0;
	}
	const [key, value] = positional;
	if (!(key in DEFAULT_CONFIG)) {
		throw new Error(
			`Unknown option "${key}". Known: ${Object.keys(DEFAULT_CONFIG).join(", ")}`,
		);
	}
	const current = readConfig()[key];
	let parsed = value;
	if (typeof current === "number") parsed = Number(value);
	else if (typeof current === "boolean") parsed = value === "true" || value === "1";
	if (typeof current === "number" && Number.isNaN(parsed)) {
		throw new Error(`"${key}" expects a number.`);
	}
	writeConfig({ [key]: parsed });
	ok(`${key} = ${JSON.stringify(parsed)}`);
	return 0;
}

function cmdCheck(positional) {
	const message = positional.join(" ") || "status code 429 Too Many Requests";
	const verdict = classifyError(message);
	ok(`message : ${message}`);
	ok(`verdict : ${describeVerdict(verdict)}`);
	ok(`isLimit : ${verdict.isLimit}`);
	ok(`terminal: ${verdict.terminal}`);
	ok(`matched : ${verdict.matched.join(", ") || "(none)"}`);
	ok("");
	ok("Patterns mirrored from Cline's ClineError.RATE_LIMIT_PATTERNS:");
	for (const pattern of RATE_LIMIT_PATTERNS) ok(`  ${pattern}`);
	return 0;
}

function cmdWhere() {
	ok(`switcherHome    ${switcherHome()}`);
	ok(`vault           ${vaultPath()}`);
	ok(`cooldowns       ${cooldownsPath()}`);
	ok(`config          ${configPath()}`);
	ok(`log             ${logPath()}`);
	ok(`pending switch  ${pendingSwitchPath()}`);
	ok(`clineDir        ${clineDir()}`);
	ok(`hooks dir       ${hooksDir()}`);
	ok(`hook file       ${hookFilePath()}`);
	ok(`providers.json  ${providerSettingsPath()}`);
	ok("");
	ok(`provider exists ${fs.existsSync(providerSettingsPath())}`);
	ok(`vault exists    ${fs.existsSync(vaultPath())}`);
	ok(`hook installed  ${fs.existsSync(hookFilePath())}`);
	return 0;
}

function packageRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Write the hook Cline discovers.
 *
 * Cline maps the file name "TaskError" to the agent_error event and, because the
 * extension is .mjs, runs it as `node <path>` on every platform — no shebang or
 * executable bit needed, which is what makes this work on Windows.
 */
function cmdInstallHook() {
	ensureHome();
	const target = hookFilePath();
	const moduleUrl = pathToFileURL(path.join(packageRoot(), "src", "hook.mjs")).href;
	const body = `#!/usr/bin/env node
// Generated by cline-account-switcher. Re-run \`cline-switch install-hook\` to refresh.
// Cline spawns this file on the agent_error event (hook file name "TaskError").
import { runTaskErrorHook } from ${JSON.stringify(moduleUrl)};

process.exitCode = await runTaskErrorHook();
`;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, body, { encoding: "utf8", mode: 0o755 });
	ok(`Installed hook: ${target}`);
	return 0;
}

function cmdUninstallHook() {
	const target = hookFilePath();
	if (removeIfExists(target)) ok(`Removed hook: ${target}`);
	else ok(`No hook at ${target}.`);
	return 0;
}

/** Locate the cline executable so the supervisor can launch it. */
function resolveClineInvocation(args) {
	const explicit = process.env.CLINE_BIN?.trim();
	if (explicit) {
		if (/\.(mjs|cjs|js)$/i.test(explicit)) {
			return { file: process.execPath, args: [explicit, ...args] };
		}
		return { file: explicit, args };
	}

	// The Cline CLI sets CLINE_WRAPPER_PATH when it shells out to itself.
	const wrapper = process.env.CLINE_WRAPPER_PATH?.trim();
	if (wrapper) {
		const bin = path.join(path.dirname(wrapper), "node_modules", "cline", "bin", "cline");
		if (fs.existsSync(bin)) return { file: process.execPath, args: [bin, ...args] };
	}

	// Global installs put a wrapper on PATH next to node_modules.
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const bin = path.join(dir, "node_modules", "cline", "bin", "cline");
		if (fs.existsSync(bin)) return { file: process.execPath, args: [bin, ...args] };
	}

	if (process.platform === "win32") {
		const quote = (part) => (/[\s"&|<>^]/.test(part) ? `"${part}"` : part);
		return {
			file: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", ["cline", ...args].map(quote).join(" ")],
		};
	}
	return { file: "cline", args };
}

function spawnCline(args) {
	const invocation = resolveClineInvocation(args);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.file, invocation.args, {
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
	});
}

/**
 * Run cline and, whenever the hook switched accounts mid-task, resume the same
 * session so the switch is invisible to the user.
 */
async function cmdRun(args) {
	const splitAt = args.indexOf("--");
	const clineArgs = splitAt === -1 ? [] : args.slice(splitAt + 1);
	if (clineArgs.length === 0) {
		throw new Error('Nothing to run. Usage: cline-switch run -- -p "your prompt"');
	}

	const config = readConfig();
	removeIfExists(pendingSwitchPath());

	let nextArgs = clineArgs;
	for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
		const { code } = await spawnCline(nextArgs);

		const marker = readJson(pendingSwitchPath(), null);
		if (!marker) return code;

		removeIfExists(pendingSwitchPath());
		if (attempt === config.maxAttempts) {
			ok(`Reached maxAttempts (${config.maxAttempts}); giving up.`);
			return code;
		}

		ok(
			`Rate limit on "${marker.model}" — switched ${marker.from ?? "(none)"} -> ${marker.to}. ` +
				`Resuming (attempt ${attempt + 1}/${config.maxAttempts})...`,
		);

		nextArgs = marker.taskId ? ["-i", marker.taskId, config.continuePrompt] : clineArgs;
	}
	return 0;
}

function openBrowser(url) {
	const cmd =
		process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// Not fatal: the URL is printed for the user to open.
	}
}

/**
 * Serve the dashboard.
 *
 * The heavy @cline/core import is lazy, so the server is up almost instantly and
 * only the first "add an account" click pays the load cost.
 */
async function cmdServe(flags) {
	ensureHome();
	const { createServer } = await import("./server.mjs");
	const instance = createServer();

	const requested = flags.port ? Number(flags.port) : 4317;
	let info;
	try {
		info = await instance.listen(requested);
	} catch (error) {
		if (error.code === "EADDRINUSE") {
			ok(`Port ${requested} is busy; picking a free one.`);
			info = await instance.listen(0);
		} else {
			throw error;
		}
	}

	ok(`Dashboard   ${info.url}`);
	ok(
		`Cline core  ${info.coreFound ? "found" : "NOT found — sign-in will fail. Set CLINE_CORE_PATH."}`,
	);
	ok(`Settings    ${info.providerSettingsPath}`);
	ok("");
	ok("Press Ctrl+C to stop.");

	if (flags.open !== false) openBrowser(info.url);

	// Keep the process alive until interrupted.
	return new Promise(() => {});
}

export async function main(argv) {
	const command = argv[0];
	const rest = argv.slice(1);
	const { flags, positional } = parseArgs(rest);

	try {
		switch (command) {
			case "init":
				return cmdInit();
			case "capture":
				return cmdCapture(flags);
			case "accounts":
				return cmdAccounts();
			case "status":
				return cmdStatus();
			case "use":
				return cmdUse(positional[0]);
			case "rotate":
				return cmdRotate();
			case "remove":
				return cmdRemove(positional[0]);
			case "reset":
				return cmdReset(positional[0]);
			case "config":
				return cmdConfig(positional);
			case "check":
				return cmdCheck(positional);
			case "where":
				return cmdWhere();
			case "install-hook":
				return cmdInstallHook();
			case "uninstall-hook":
				return cmdUninstallHook();
			case "run":
				return await cmdRun(rest);
			case "serve":
			case "dashboard":
				return await cmdServe(flags);
			case undefined:
			case "help":
			case "--help":
			case "-h":
				process.stdout.write(USAGE);
				return 0;
			default:
				process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
				return 1;
		}
	} catch (error) {
		process.stderr.write(`cline-switch: ${error.message}\n`);
		return 1;
	}
}
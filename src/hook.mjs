// The Cline `TaskError` hook.
//
// Cline discovers a file named `TaskError.<ext>` in its hooks directory and, on
// an `agent_error` event, spawns it as a subprocess with the event payload as
// JSON on stdin. All of this is verified against @cline/core v3.0.62:
//
//   hook-file-config.js : HookConfigFileName.TaskError -> "agent_error"
//   events.d.ts         : AgentErrorHookPayload = { taskId, error:{ name, message, stack? } }
//   command builder      : ".mjs" -> ["node", <path>]
//   stdout parser        : JSON.parse(entire stdout) => control object
//
// THE ONE RULE: stdout may contain nothing but the final control JSON.
// Every diagnostic must go to stderr or a log file, otherwise Cline's parser
// throws and the control object is silently discarded.

import fs from "node:fs";
import path from "node:path";

import { readConfig } from "./config.mjs";
import { classifyError, describeVerdict } from "./ratelimit.mjs";
import { rotate } from "./switcher.mjs";
import { logPath, pendingSwitchPath } from "./paths.mjs";
import { writeJsonAtomic } from "./jsonfile.mjs";

let quiet = false;

function log(message) {
	const line = `${new Date().toISOString()} [TaskError] ${message}\n`;
	try {
		fs.mkdirSync(path.dirname(logPath()), { recursive: true });
		fs.appendFileSync(logPath(), line);
	} catch {
		// Never let logging break the hook.
	}
	if (quiet) return;
	try {
		process.stderr.write(line);
	} catch {
		// stderr may be closed.
	}
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Handle one agent_error event.
 *
 * @param {object} [options]
 * @param {() => Promise<string>} [options.readPayload] Override the stdin reader (tests).
 * @param {boolean} [options.quiet] Suppress stderr logging (tests).
 * @returns {Promise<number>} process exit code
 */
export async function runTaskErrorHook(options = {}) {
	quiet = Boolean(options.quiet ?? process.env.ACCOUNT_SWITCHER_QUIET);

	let payload;
	try {
		const raw = await (options.readPayload ? options.readPayload() : readStdin());
		payload = raw.trim() ? JSON.parse(raw) : {};
	} catch (error) {
		log(`unreadable payload: ${error.message}`);
		return 0;
	}

	if (payload?.hookName && payload.hookName !== "agent_error") {
		log(`ignoring event ${payload.hookName}`);
		return 0;
	}

	const message = payload?.error?.message ?? "";
	const verdict = classifyError(message);
	log(`event taskId=${payload?.taskId ?? "unknown"} verdict=${describeVerdict(verdict)}`);

	if (!verdict.isLimit) {
		log(`message was: ${message.slice(0, 300)}`);
		return 0;
	}

	if (verdict.kind === "auth") {
		log("auth failure — not switching (rotating a dead token would hide the cause)");
		return 0;
	}

	const config = readConfig();

	let result;
	try {
		result = rotate({ kind: verdict.kind, terminal: verdict.terminal });
	} catch (error) {
		log(`switch failed: ${error.message}`);
		return 0;
	}

	if (!result.rotated) {
		log(`limit hit on "${result.model}" but could not switch: ${result.reason}`);
		return 0;
	}

	log(
		`switched ${result.from ?? "(none)"} -> ${result.to} for model "${result.model}"` +
			(result.degraded ? " (all accounts cooling; using the soonest to free up)" : ""),
	);

	// Marker consumed by the `run` supervisor so it can resume the session.
	try {
		writeJsonAtomic(pendingSwitchPath(), {
			at: new Date().toISOString(),
			taskId: payload?.taskId ?? null,
			model: result.model,
			from: result.from,
			to: result.to,
			kind: verdict.kind,
			degraded: Boolean(result.degraded),
		});
	} catch (error) {
		log(`could not write pending-switch marker: ${error.message}`);
	}

	if (config.hookOutput === "context") {
		// The ONLY thing allowed on stdout.
		process.stdout.write(
			JSON.stringify({
				contextModification:
					`The previous request for model "${result.model}" hit its rate limit on the ` +
					`previous account. The active Cline account has been switched to "${result.to}". ` +
					`Retry the last operation; if the task must be restarted, resume it.`,
			}),
		);
	}

	return 0;
}
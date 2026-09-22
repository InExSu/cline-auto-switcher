// The dashboard server.
//
// Plain node:http, bound to the loopback interface only. Two layers of
// protection on the API, because a localhost HTTP server is reachable by any
// process on the machine and by any web page the browser happens to have open:
//
//   1. a per-session random token, required as the x-switcher-token header
//   2. an Origin check, rejecting cross-origin browser requests
//
// The token is injected into the page, so the legitimate UI has it and nothing
// else does.

import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

import { readConfig } from "./config.mjs";
import { buildStatus, useAccount, rotate, resetCooldowns } from "./switcher.mjs";
import { readVault, writeVault, removeAccount, upsertAccount } from "./vault.mjs";
import { renderPage } from "./ui.mjs";
import {
	startDeviceAuth,
	completeDeviceAuth,
	toProviderAuth,
	credentialEmail,
	findClineCore,
} from "./clineauth.mjs";
import { providerSettingsPath } from "./paths.mjs";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

/** A usable status even when Cline has not been authenticated yet. */
function fallbackState(error) {
	const vault = readVault();
	return {
		providerId: readConfig().providerId,
		model: null,
		active: vault.active,
		warning: error.message,
		accounts: vault.accounts.map((a) => ({
			id: a.id,
			label: a.label,
			email: a.email ?? null,
			name: a.name ?? null,
			active: a.id === vault.active,
			inProvidersJson: false,
			model: a.model,
			lastUsedAt: a.lastUsedAt ?? null,
			coolingFor: null,
			coolingUntil: null,
			terminal: false,
			reason: null,
			strikes: 0,
		})),
	};
}

function safeState() {
	try {
		return buildStatus();
	} catch (error) {
		return fallbackState(error);
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large."));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw.trim()) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("Request body is not valid JSON."));
			}
		});
		req.on("error", reject);
	});
}

export function createServer() {
	const token = crypto.randomBytes(24).toString("hex");
	let flow = { phase: "idle" };
	let flowId = 0;

	async function beginFlow() {
		// One sign-in at a time: while a code is live, hand the same code out
		// again instead of forking a second poll whose result would be discarded.
		if (flow.phase === "waiting") return flow;
		const id = ++flowId;
		const device = await startDeviceAuth();
		flow = {
			phase: "waiting",
			userCode: device.userCode,
			verificationUri: device.verificationUri,
			verificationUriComplete: device.verificationUriComplete,
			expiresInSeconds: device.expiresInSeconds,
		};

		// Poll in the background; the page watches /api/auth/state.
		completeDeviceAuth(device)
			.then((credentials) => {
				if (flowId !== id) return; // superseded by a newer request or a cancel
				const auth = toProviderAuth(credentials);
				const email = credentialEmail(credentials);
				const { account, created } = upsertAccount({
					auth,
					email,
					label: email ?? undefined,
					providerId: readConfig().providerId,
				});
				const vault = readVault();
				if (vault.active === account.id || vault.accounts.length === 1) {
					try {
						useAccount(account.id);
					} catch {
						// providers.json might be uninitialized in sandbox tests
					}
				}
				flow = {
					phase: "done",
					email: email ?? auth.accountId,
					accountId: auth.accountId,
					created,
				};
			})
			.catch((error) => {
				if (flowId !== id) return;
				flow = { phase: "error", message: error.message };
			});

		return flow;
	}

	const routes = {
		"GET /api/state": () => safeState(),
		"GET /api/auth/state": () => flow,
		"POST /api/auth/start": () => beginFlow(),
		"POST /api/auth/cancel": () => {
			flowId += 1;
			flow = { phase: "idle" };
			return flow;
		},
		"POST /api/switch": (body) => {
			const result = useAccount(body.id);
			const account = readVault().accounts.find((a) => a.id === result.to);
			return { ok: true, ...result, email: account?.email ?? null };
		},
		"POST /api/rotate": () => rotate({ kind: "manual" }),
		"POST /api/accounts/remove": (body) => {
			const vault = readVault();
			if (!removeAccount(vault, body.id)) throw new Error(`Unknown account "${body.id}".`);
			writeVault(vault);
			return { ok: true, removed: body.id };
		},
		"POST /api/cooldowns/reset": () => ({ ok: true, cleared: resetCooldowns() }),
	};

	function isAuthorized(req) {
		const origin = req.headers.origin;
		if (origin) {
			try {
				const parsed = new URL(origin);
				if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return false;
			} catch {
				return false;
			}
		}
		const provided = req.headers["x-switcher-token"];
		if (typeof provided !== "string" || provided.length !== token.length) return false;
		return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
	}

	function sendJson(res, status, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(body),
		});
		res.end(body);
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);

		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const body = renderPage({ token });
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
			return;
		}

		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			res.writeHead(204).end();
			return;
		}

		const key = `${req.method} ${url.pathname}`;
		const handler = routes[key];
		if (!handler) {
			sendJson(res, 404, { error: `No route for ${key}.` });
			return;
		}

		if (!isAuthorized(req)) {
			sendJson(res, 403, { error: "Not authorised. Open the dashboard from its own URL." });
			return;
		}

		(async () => {
			const body = req.method === "POST" ? await readBody(req) : {};
			sendJson(res, 200, await handler(body));
		})().catch((error) => {
			sendJson(res, 400, { error: error.message });
		});
	});

	return {
		server,
		token,
		listen(port = 0) {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, HOST, () => {
					const address = server.address();
					resolve({
						port: address.port,
						url: `http://${HOST}:${address.port}/`,
						coreFound: Boolean(findClineCore()),
						providerSettingsPath: providerSettingsPath(),
					});
				});
			});
		},
	};
}
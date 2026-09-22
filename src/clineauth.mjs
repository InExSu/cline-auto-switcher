// Bridge to Cline's own OAuth implementation.
//
// Rather than reimplementing the device flow, we import the real thing out of
// the installed Cline package. @cline/core exports exactly what a GUI needs:
//
//   startClineDeviceAuth()    -> { deviceCode, userCode, verificationUri,
//                                  verificationUriComplete, expiresInSeconds,
//                                  pollIntervalSeconds }
//   completeClineDeviceAuth() -> ClineOAuthCredentials
//
// The device flow (RFC 8628) is ideal for a local dashboard: no callback server
// and no port juggling — show the user a code, they approve it in the browser at
// authkit.cline.bot (Cline's WorkOS AuthKit, which fronts Google), and we poll.
//
// NOTE: @cline/core ships as a single 1.1MB barrel whose import takes several
// seconds and installs open handles. We therefore import it lazily, once, and
// cache the promise.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_API_BASE_URL = "https://api.cline.bot";

/** Candidate locations for @cline/core, most specific first. */
function coreCandidates() {
	const candidates = [];
	const override = process.env.CLINE_CORE_PATH?.trim();
	if (override) candidates.push(override);

	const roots = [];
	const wrapper = process.env.CLINE_WRAPPER_PATH?.trim();
	if (wrapper) roots.push(path.dirname(wrapper));
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir) roots.push(dir);
	}
	// Also try alongside our own install, in case of a local dev setup.
	roots.push(process.cwd());

	for (const root of roots) {
		candidates.push(path.join(root, "node_modules", "cline", "node_modules", "@cline", "core", "dist", "index.js"));
		candidates.push(path.join(root, "node_modules", "@cline", "core", "dist", "index.js"));
	}
	return candidates;
}

/** Path to @cline/core's entry point, or null when Cline is not installed. */
export function findClineCore() {
	for (const candidate of coreCandidates()) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// Unreadable PATH entry; keep looking.
		}
	}
	return null;
}

let corePromise = null;

/** Load @cline/core once. Throws with an actionable message if unavailable. */
export async function loadClineCore() {
	if (!corePromise) {
		const entry = findClineCore();
		if (!entry) {
			throw new Error(
				"Could not find @cline/core. Install the Cline CLI, or set CLINE_CORE_PATH to " +
					"its dist/index.js.",
			);
		}
		corePromise = import(pathToFileURL(entry).href).catch((error) => {
			corePromise = null;
			throw new Error(`Failed to load @cline/core from ${entry}: ${error.message}`);
		});
	}
	return corePromise;
}

/** The API base URL Cline itself would use, honouring CLINE_API_BASE_URL. */
export async function resolveApiBaseUrl() {
	const override = process.env.CLINE_API_BASE_URL?.trim();
	if (override) return override;
	try {
		const entry = findClineCore();
		if (entry) {
			const sharedEntry = entry.replace(
				path.join("@cline", "core", "dist", "index.js"),
				path.join("@cline", "shared", "dist", "index.js"),
			);
			if (fs.existsSync(sharedEntry)) {
				const shared = await import(pathToFileURL(sharedEntry).href);
				const config = shared.getClineEnvironmentConfig?.();
				if (config?.apiBaseUrl) return config.apiBaseUrl;
			}
		}
	} catch {
		// Fall through to the documented default.
	}
	return DEFAULT_API_BASE_URL;
}

/** Begin a device authorization. Returns the code the user must approve. */
export async function startDeviceAuth() {
	const core = await loadClineCore();
	return core.startClineDeviceAuth({ requestTimeoutMs: 20_000 });
}

/**
 * Poll until the user finishes signing in.
 * @returns {Promise<object>} ClineOAuthCredentials
 */
export async function completeDeviceAuth({ deviceCode, expiresInSeconds, pollIntervalSeconds }) {
	const core = await loadClineCore();
	const apiBaseUrl = await resolveApiBaseUrl();
	return core.completeClineDeviceAuth({
		deviceCode,
		expiresInSeconds,
		pollIntervalSeconds,
		apiBaseUrl,
	});
}

/**
 * Map ClineOAuthCredentials onto the `settings.auth` block that providers.json
 * uses. Field names verified against a real providers.json:
 *
 *   accessToken, refreshToken, expiresAt (epoch ms), accountId,
 *   metadata: { tokenType, userInfo: { email, name, clineUserId, ... } }
 */
export function toProviderAuth(credentials) {
	const userInfo = credentials?.metadata?.userInfo ?? {};
	return {
		accessToken: credentials.access,
		refreshToken: credentials.refresh,
		expiresAt: credentials.expires,
		accountId:
			credentials.accountId ?? userInfo.clineUserId ?? credentials.email ?? undefined,
		metadata: credentials.metadata ?? {},
	};
}

/** Best display label for a freshly authorised account. */
export function credentialEmail(credentials) {
	return (
		credentials?.email ??
		credentials?.metadata?.userInfo?.email ??
		credentials?.metadata?.userInfo?.name ??
		null
	);
}

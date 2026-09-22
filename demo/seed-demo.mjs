// Seed a realistic demo state so the dashboard's states can be reviewed:
// one account in use, one cooling on the live model, one out of credits.
//
// SELF-SANDBOXING: the env vars below are set before anything imports the
// switcher modules, so this script can only ever touch the sandbox under
// TEMP\as-demo. It once ran without them and clobbered the real ~/.cline —
// vault.mjs's demo-data guard would now refuse that write, but the demo
// should not rely on the guard being the thing that saves you.
//
// Usage:  node demo/seed-demo.mjs --serve            (seeds, then serves on 4318)
//         node demo/seed-demo.mjs --serve --port 5000
//         node demo/seed-demo.mjs                     (seed only)

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const demoRoot = path.join(os.tmpdir(), "as-demo");
process.env.ACCOUNT_SWITCHER_HOME = path.join(demoRoot, "home");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(demoRoot, "providers.json");
process.env.CLINE_HOOKS_DIR = path.join(demoRoot, "hooks");
process.env.ACCOUNT_SWITCHER_QUIET = "1";
fs.mkdirSync(process.env.ACCOUNT_SWITCHER_HOME, { recursive: true });

const { upsertAccount, readVault, writeVault, writeProviderSettings } = await import(
	new URL("../src/vault.mjs", import.meta.url).href
);
const { markCooldown, writeLedger } = await import(new URL("../src/ledger.mjs", import.meta.url).href);

const MODEL = "cline-free/muse-spark-1.3-contributor";

function creds(accountId, email, name) {
	return {
		accessToken: `access-${accountId}`,
		refreshToken: `refresh-${accountId}`,
		expiresAt: Date.now() + 3_600_000,
		accountId,
		metadata: { tokenType: "Bearer", userInfo: { email, name, clineUserId: accountId } },
	};
}

const people = [
	["acct-personal", "ada@example.com", "Ada Lovelace"],
	["acct-work", "grace@studio.example", "Grace Hopper"],
	["acct-alt", "alan@example.com", "Alan Turing"],
];

// providers.json must exist: it is the source of "which model is in use".
writeProviderSettings({
	version: 1,
	lastUsedProvider: "cline",
	modes: {},
	providers: {
		cline: {
			settings: {
				provider: "cline",
				auth: creds(people[0][0], people[0][1], people[0][2]),
				model: MODEL,
				reasoning: {},
			},
			updatedAt: new Date().toISOString(),
			tokenSource: "oauth",
		},
	},
});

people.forEach(([id, email, name]) => {
	upsertAccount({ auth: creds(id, email, name), email, name, label: name });
});

const vault = readVault();
vault.accounts.forEach((a) => {
	a.lastUsedAt = new Date(Date.now() - 1000 * 60 * 7).toISOString();
});
vault.active = "acct-personal";
vault.accounts[0].lastUsedAt = new Date().toISOString();
writeVault(vault);

// acct-work is throttled on the live model; acct-alt is out of credits.
const ledger = { version: 1, entries: {} };
markCooldown(ledger, "acct-work", MODEL, Date.now() + 1000 * 60 * 42, "rate_limit", false);
markCooldown(ledger, "acct-alt", MODEL, Date.now() + 1000 * 60 * 60 * 20, "credits", true);
writeLedger(ledger);

console.log("seeded:", readVault().accounts.map((a) => a.id).join(", "));

// With --serve, keep the sandboxed env we just set and run the dashboard in
// this same process. (Launching `serve` separately would start a fresh process
// without these env vars and read the real Cline home instead.)
if (process.argv.includes("--serve")) {
	const portFlag = process.argv.indexOf("--port");
	const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 4318;
	const { createServer } = await import(new URL("../src/server.mjs", import.meta.url).href);
	const instance = createServer();
	const info = await instance.listen(port);
	console.log(`Dashboard   ${info.url}`);
	console.log("Press Ctrl+C to stop.");
	setInterval(() => {}, 1 << 30); // hold the event loop open
}

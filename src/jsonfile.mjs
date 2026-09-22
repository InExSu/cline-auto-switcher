// JSON helpers.
//
// Writes are atomic (temp file + rename) because the TaskError hook rewrites
// providers.json while the Cline process may be reading it. A torn write would
// corrupt the user's credentials file.

import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback = undefined) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return fallback;
		throw err;
	}
	if (!raw.trim()) return fallback;
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${file}: ${err.message}`);
	}
}

export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
	fs.renameSync(tmp, file);
	return file;
}

export function removeIfExists(file) {
	try {
		fs.rmSync(file);
		return true;
	} catch (err) {
		if (err.code === "ENOENT") return false;
		throw err;
	}
}

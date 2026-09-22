#!/usr/bin/env node
// Entry point for the `cline-switch` command.

import { main } from "../src/cli.mjs";

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`cline-switch: ${error.message}\n`);
		process.exitCode = 1;
	});

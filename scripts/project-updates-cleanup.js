"use strict";

const { runProjectUpdatesCleanup } = require("../src/project-updates-cleanup-client");

async function main() {
  try {
    const summary = await runProjectUpdatesCleanup();
    process.stdout.write(`[PROJECT UPDATES CLEANUP] ${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = /^[A-Z0-9_]{2,64}$/.test(String(error && error.code || ""))
      ? error.code
      : "CLEANUP_FAILED";
    // Never log the cleanup key, request headers, or response bodies.
    process.stderr.write(`[PROJECT UPDATES CLEANUP] ${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();

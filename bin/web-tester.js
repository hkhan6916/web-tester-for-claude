#!/usr/bin/env node
// web-tester launcher. Delegates to the TypeScript CLI via tsx so we can ship
// source rather than pre-built JS — the runtime cost is one tsx startup
// (~150ms on warm cache) and it keeps the published package tiny.
//
// We resolve tsx from this package's own node_modules so the launcher never
// fights with the consumer project's installed version. The CLI entry is
// `../src/cli.ts` relative to this file regardless of where npm placed us
// (top-level node_modules, pnpm's nested layout, npx cache, etc).

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const PACKAGE_ROOT = resolve(__dirname, "..");
const CLI_ENTRY = resolve(PACKAGE_ROOT, "src/cli.ts");

let tsxBin;
try {
  tsxBin = require.resolve("tsx/cli", { paths: [PACKAGE_ROOT] });
} catch (err) {
  console.error(
    "web-tester: could not locate tsx (web-tester's TypeScript runner).\n" +
      "  Reinstall web-tester-for-claude (this should have come with it as a dep).\n" +
      `  Underlying error: ${err && err.message ? err.message : err}`
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tsxBin, CLI_ENTRY, ...process.argv.slice(2)],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);

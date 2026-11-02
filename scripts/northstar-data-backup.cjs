"use strict";

// Offline-only PGlite/file-allowlist fixture tool. This is not connected to
// server startup or release deployment and is not a PostgreSQL backup tool.
const path = require("node:path");
const { createBackup, restoreBackup } = require("../shell/runtime/data-backup.cjs");

const usage = [
  "Usage:",
  "  node scripts/northstar-data-backup.cjs backup --backend pglite --db-dir ABS --runtime-dir ABS --output ABS --offline-confirmed",
  "  node scripts/northstar-data-backup.cjs restore --backend pglite --input ABS --target-root ABS",
  "",
  "backup requires the operator to stop all writers first; --offline-confirmed is an assertion, not a process detector.",
  "restore requires a new target directory. PG configuration is rejected; PG requires its own database-native backup workflow.",
].join("\n");

function parse(argv) {
  const [action, ...rest] = argv;
  if (!new Set(["backup", "restore"]).has(action)) throw Object.assign(new Error(usage), { code: "BACKUP_USAGE" });
  const values = new Map();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === "--offline-confirmed") {
      if (values.has(key)) throw Object.assign(new Error("duplicate option"), { code: "BACKUP_USAGE" });
      values.set(key, true);
      continue;
    }
    if (!/^--[a-z-]+$/.test(key) || i + 1 >= rest.length || rest[i + 1].startsWith("--") || values.has(key)) {
      throw Object.assign(new Error(usage), { code: "BACKUP_USAGE" });
    }
    values.set(key, rest[++i]);
  }
  const allowed = action === "backup"
    ? new Set(["--backend", "--db-dir", "--runtime-dir", "--output", "--offline-confirmed"])
    : new Set(["--backend", "--input", "--target-root"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw Object.assign(new Error(usage), { code: "BACKUP_USAGE" });
  const required = action === "backup"
    ? ["--backend", "--db-dir", "--runtime-dir", "--output", "--offline-confirmed"]
    : ["--backend", "--input", "--target-root"];
  for (const key of required) if (!values.has(key)) throw Object.assign(new Error(usage), { code: "BACKUP_USAGE" });
  return { action, values };
}

function main(argv = process.argv.slice(2)) {
  const { action, values } = parse(argv);
  const backend = values.get("--backend");
  let result;
  if (action === "backup") {
    result = createBackup({
      backend,
      dbDir: values.get("--db-dir"),
      runtimeDir: values.get("--runtime-dir"),
      outputFile: values.get("--output"),
      masterKeyFile: process.env.PT_MASTER_KEY_FILE || path.resolve(__dirname, "../secrets/master.key"),
      env: process.env,
    });
  } else {
    result = restoreBackup({
      backend,
      inputFile: values.get("--input"),
      targetRoot: values.get("--target-root"),
      env: process.env,
    });
  }
  process.stdout.write(JSON.stringify({ ok: true, action, ...result }) + "\n");
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code || "BACKUP_FAILED", error: error.message }) + "\n");
    process.exitCode = 1;
  }
}

module.exports = { main, parse };

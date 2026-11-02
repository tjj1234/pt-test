#!/usr/bin/env node
"use strict";
// Offline maintenance: never imported by service startup. Does not start DSH,
// install packages, delete backups, or read secrets from environment files.
const path = require("node:path");
const { rebuildProfile, recoverProfile } = require("../shell/runtime/dsh-adapter.cjs");
const { inspectSettings, adoptSettings } = require("../shell/runtime/settings-version.cjs");
const { upgradeSettings, recoverSettings, inspectSettingsRecovery } = require("../shell/runtime/settings-upgrade.cjs");
function main(args) {
  const action = args.shift();
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(values, key)) throw new Error("Duplicate maintenance argument");
    if (["--offline", "--preserve-current", "--reviewed"].includes(key)) values[key] = true;
    else if (["--home", "--lock-token", "--settings-hash", "--template-hash", "--baseline-hash", "--journal-hash"].includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i];
    else throw new Error("Unknown or incomplete maintenance argument");
  }
  if (!["rebuild", "restore-backup", "keep-current", "inspect-settings", "adopt-settings", "upgrade-settings", "inspect-settings-recovery", "rollback-settings"].includes(action) || !values["--home"] || !values["--offline"]) {
    throw new Error("Stop all Northstar/DSH processes using this home first. Usage: node scripts/northstar-profile.cjs <rebuild|restore-backup|keep-current|inspect-settings|adopt-settings> --home <path> --offline; adopt-settings also requires --reviewed --settings-hash <sha256> --template-hash <sha256> --baseline-hash <sha256|none>");
  }
  const home = path.resolve(values["--home"]);
  const template = path.resolve(__dirname, "../shell/dsh-settings.yaml");
  if (["inspect-settings-recovery", "rollback-settings"].includes(action)) {
    const allowed = action === "inspect-settings-recovery" ? ["--home", "--offline"]
      : ["--home", "--offline", "--reviewed", "--journal-hash", "--lock-token"];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Argument is not valid for settings recovery");
    const result = action === "inspect-settings-recovery" ? inspectSettingsRecovery({ home })
      : recoverSettings({ home, expectedJournalHash: values["--journal-hash"], reviewed: values["--reviewed"] === true,
        offline: true, staleLockToken: values["--lock-token"] });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (["inspect-settings", "adopt-settings", "upgrade-settings"].includes(action)) {
    const allowed = action === "inspect-settings" ? ["--home", "--offline"]
      : ["--home", "--offline", "--reviewed", "--settings-hash", "--template-hash", "--baseline-hash"];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Argument is not valid for settings maintenance");
    const result = action === "inspect-settings" ? inspectSettings({ home, template }) : (action === "upgrade-settings" ? upgradeSettings : adoptSettings)({
      home, template, reviewed: values["--reviewed"] === true, offline: true,
      expected: { settingsHash: values["--settings-hash"], templateHash: values["--template-hash"],
        baselineHash: values["--baseline-hash"] === "none" ? null : values["--baseline-hash"] },
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (Object.keys(values).some(key => !["--home", "--offline", "--lock-token", "--preserve-current"].includes(key))) throw new Error("Argument is not valid for profile maintenance");
  const result = action === "rebuild"
    ? rebuildProfile(home, path.resolve(__dirname, "../shell/dsh-settings.yaml"), path.resolve(__dirname, "../shell/persistent-runner.mjs"))
    : recoverProfile(home, { action, lockToken: values["--lock-token"], preserveCurrent: values["--preserve-current"] === true });
  process.stdout.write(JSON.stringify(result) + "\n");
}
try { main(process.argv.slice(2)); }
catch (error) { process.stderr.write(JSON.stringify({ ok: false, code: error.code || "PROFILE_MAINTENANCE_FAILED", message: error.message }) + "\n"); process.exitCode = 1; }

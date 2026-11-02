"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fail = () => Object.assign(new Error("Undeclared DSH bootstrap input is present or inaccessible"), { code: "DSH_BOOTSTRAP_INPUT_UNTRUSTED" });

// DSH reads these layers independently of the parent environment allowlist.
// Refuse them without reading contents or deleting operator/tenant files.
// Shared profiles/node_modules is maintained by DSH and is outside this guard.
function assertBootstrapPolicy({ home, workspace, profileDir }) {
  if (![home, workspace, profileDir].every(value => typeof value === "string" && path.isAbsolute(value))) throw fail();
  try {
    fs.lstatSync(path.join(home, ".northstar-settings-upgrade-journal.json"));
    throw Object.assign(new Error("Settings upgrade requires explicit recovery before DSH startup"), { code: "SETTINGS_RECOVERY_REQUIRED" });
  } catch (error) {
    if (error.code !== "ENOENT") throw error.code === "SETTINGS_RECOVERY_REQUIRED" ? error : fail();
  }
  for (const filename of [
    path.join(home, ".env"), path.join(workspace, ".env"),
    path.join(home, "cordis.patch.yml"),
    path.join(home, "node_modules"), path.join(profileDir, "node_modules"),
  ]) {
    try { fs.lstatSync(filename); }
    catch (error) { if (error.code === "ENOENT") continue; throw fail(); }
    throw fail();
  }
}
module.exports = { assertBootstrapPolicy };

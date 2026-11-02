import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "shell/package.json"));
const { makeProfile } = require(path.join(root, "shell/runtime/dsh-adapter.cjs"));

test("run-persistent profile fails closed for skills and web until approved loader/network wiring exists", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t13-t14-profile-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const dshHome = path.join(tempRoot, "dsh");
  makeProfile(dshHome, path.join(root, "shell/dsh-settings.yaml"), path.join(root, "shell/persistent-runner.mjs"));
  const profileDir = path.join(dshHome, "profiles", "run-persistent");
  const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
  const settings = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
  const profilePackage = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "northstar-profile-manifest.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "shell/package-lock.json"), "utf8"));

  for (const toolId of ["tool-skill", "tool-web"]) {
    assert.match(patch, new RegExp(`- id: ${toolId}\\n  disabled: true`), `${toolId} must stay explicitly disabled`);
  }
  assert.deepEqual(profilePackage.dsh.profile.bundles, ["@deepseek-ai/dsh-base"]);
  assert.deepEqual(Object.keys(profilePackage.dependencies), ["@deepseek-ai/dsh-base"]);
  assert.equal(lock.packages["node_modules/@deepseek-ai/dsh-base"].version, "0.1.1-rc.2");
  assert.match(lock.packages["node_modules/@deepseek-ai/dsh-base"].resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(lock.packages["node_modules/@deepseek-ai/dsh-base"].integrity, /^sha512-/);
  assert.match(settings, /web-search-pro:[\s\S]*?registerProvider:\s*true/);
  assert.match(settings, /web-search-pro:[\s\S]*?enableCliBackends:\s*true/);
  assert.match(patch, /- id: tool-web\n  disabled: true/);
  assert.equal(Object.hasOwn(manifest.files, "cordis.patch.yml"), true);
  assert.equal(Object.hasOwn(manifest.files, "package.json"), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { buildProfileDependencyContract: buildContract } = require("../../shell/runtime/profile-dependencies.cjs");
const buildProfileDependencyContract = (input) => buildContract({ npmrc: "legacy-peer-deps=true\n", ...input });
const name = "@deepseek-ai/dsh-base";
const entry = { version: "0.1.1-rc.2", resolved: "https://registry.example/base.tgz", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` };
const makeLock = (value = entry) => JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${name}`]: value } });

test("profile dependency contract pins bundles and retains release provenance", () => {
  const result = buildProfileDependencyContract({ lockfile: makeLock() });
  assert.deepEqual(result.dependencies, { [name]: "0.1.1-rc.2" });
  assert.deepEqual(result.bundles, [name]);
  assert.deepEqual(result.releaseInput.bundles[name], entry);
  assert.match(result.releaseInput.shellLockfileSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(buildProfileDependencyContract({ lockfile: Buffer.from(makeLock()) }), result);
});

test("any shell lockfile byte change changes managed release input", () => {
  const a = buildProfileDependencyContract({ lockfile: makeLock() });
  const b = buildProfileDependencyContract({ lockfile: `${makeLock()}\n` });
  assert.deepEqual(a.dependencies, b.dependencies);
  assert.notEqual(a.releaseInput.shellLockfileSha256, b.releaseInput.shellLockfileSha256);
});

test("missing, ranged, linked, dev-only, optional and unverified bundle entries fail closed", () => {
  for (const value of [null, {}, { ...entry, version: "^0.1.1" }, { ...entry, link: true },
    { ...entry, dev: true }, { ...entry, optional: true }, { ...entry, integrity: undefined },
    { ...entry, resolved: undefined }]) {
    assert.throws(() => buildProfileDependencyContract({ lockfile: makeLock(value) }), { code: "PROFILE_DEPENDENCIES_INVALID" });
  }
});

test("invalid lockfile formats and bundle selectors fail closed", () => {
  for (const lockfile of [undefined, {}, "no-json", "null", JSON.stringify({ lockfileVersion: 1 })]) {
    assert.throws(() => buildProfileDependencyContract({ lockfile }), { code: "PROFILE_DEPENDENCIES_INVALID" });
  }
  for (const bundles of [[], [name, name], ["../bad"], ["@deepseek-ai/dsh-base@latest"]]) {
    assert.throws(() => buildProfileDependencyContract({ lockfile: makeLock(), bundles }), { code: "PROFILE_DEPENDENCIES_INVALID" });
  }
});

test("repository shell lockfile declares the production base bundle", () => {
  const lockfile = fs.readFileSync(new URL("../../shell/package-lock.json", import.meta.url));
  const result = buildProfileDependencyContract({ lockfile });
  assert.equal(result.dependencies[name], "0.1.1-rc.2");
});

 test("npm installation policy bytes bind the release and cannot be omitted", () => {
  const lockfile = makeLock();
  const first = buildContract({ lockfile, npmrc: "legacy-peer-deps=true\n" });
  const second = buildContract({ lockfile, npmrc: "legacy-peer-deps=false\n" });
  assert.notEqual(first.releaseInput.shellNpmrcSha256, second.releaseInput.shellNpmrcSha256);
  assert.throws(() => buildContract({ lockfile }), { code: "PROFILE_DEPENDENCIES_INVALID" });
});

test("malformed exact versions and corrupt SRI digests fail closed", () => {
  for (const version of ["01.02.03", "1.2.3-01", "1.2.3-a..b", "1.2.3+", "1.2.3-", "1.2.3+foo..bar"]) {
    assert.throws(() => buildProfileDependencyContract({ lockfile: makeLock({ ...entry, version }) }), { code: "PROFILE_DEPENDENCIES_INVALID" });
  }
  for (const integrity of ["sha512-YWJj", `sha256-${Buffer.alloc(64).toString("base64")}`,
    entry.integrity.replace(/=+$/, ""), entry.integrity.replace(/A==$/, "B==")]) {
    assert.throws(() => buildProfileDependencyContract({ lockfile: makeLock({ ...entry, integrity }) }), { code: "PROFILE_DEPENDENCIES_INVALID" });
  }
  for (const version of ["0.0.0", "1.2.3-a.0.b-1+001.foo", "1.2.3+01"]) {
    assert.equal(buildProfileDependencyContract({ lockfile: makeLock({ ...entry, version }) }).dependencies[name], version);
  }
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { assertTargetPlatform, assertNodeVersion, assertPackageNodeEngines, safeRelativePath, walkPackageFiles, productionClosure, rejectExtraneousProductionPackages, normalizedResolved, packageRecord, lockPackageIdentity, manifestsMatch } = require("../../scripts/northstar-dependency-closure.cjs");

test("T16 target gate accepts only Linux/amd64", () => {
  assert.equal(assertTargetPlatform("linux", "x64"), undefined);
  assert.throws(() => assertTargetPlatform("darwin", "arm64"), { code: "TARGET_PLATFORM_REQUIRED" });
  assert.throws(() => assertTargetPlatform("linux", "arm64"), { code: "TARGET_PLATFORM_REQUIRED" });
});

test("T16 runtime gate requires Node 22.19 or newer", () => {
  assert.equal(assertNodeVersion("22.19.0"), undefined);
  assert.equal(assertNodeVersion("24.1.0"), undefined);
  assert.throws(() => assertNodeVersion("22.18.9"), { code: "NODE_VERSION_UNSUPPORTED" });
});

test("T16 validates every installed production package Node engine", () => {
  const packageNode = (name, range) => ({ name, version: "1.0.0", package: { engines: { node: range } } });
  assert.equal(assertPackageNodeEngines([packageNode("supported", ">=20.0.0"), packageNode("missing-engine", null)], "22.23.4"), undefined);
  assert.throws(() => assertPackageNodeEngines([packageNode("future-only", ">=23.0.0")], "22.23.4"), { code: "DEPENDENCY_NODE_ENGINE_UNSUPPORTED" });
  assert.throws(() => assertPackageNodeEngines([packageNode("bad-range", "not-semver")], "22.23.4"), { code: "DEPENDENCY_NODE_ENGINE_UNSUPPORTED" });
});

test("dependency manifest rejects unsafe package-relative paths", () => {
  assert.equal(safeRelativePath("lib/index.js"), "lib/index.js");
  for (const value of ["", "/etc/passwd", "../escape", "a/../b", "a\\b", "a\0b"]) {
    assert.throws(() => safeRelativePath(value), { code: "PACKAGE_PATH_INVALID" });
  }
});

test("per-file manifest hashes regular files and excludes nested dependency trees", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t16-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "lib", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(root, "node_modules", "nested", "index.js"), "separate Arborist node\n");
  const entries = walkPackageFiles(root);
  assert.deepEqual(entries.map((entry) => entry.path), ["lib/index.js", "package.json"]);
  const code = fs.readFileSync(path.join(root, "lib", "index.js"));
  assert.equal(entries[0].sha256, crypto.createHash("sha256").update(code).digest("hex"));
  assert.equal(entries[0].size, code.length);
});

test("package manifest rejects symlinks that escape the package root", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t16-symlink-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "package");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(parent, "outside"), "outside\n");
  fs.symlinkSync(path.join(parent, "outside"), path.join(root, "escape"));
  assert.throws(() => walkPackageFiles(root), { code: "PACKAGE_SYMLINK_ESCAPE" });
});

test("local file dependency manifests use the locked relative source and preserve identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t16-local-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "vendor");
  const packagePath = path.join(root, "node_modules", "@fixture", "local");
  fs.mkdirSync(vendor, { recursive: true });
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(path.join(vendor, "local.tgz"), "locked tarball\n");
  fs.writeFileSync(path.join(packagePath, "package.json"), "{}\n");

  const node = {
    path: fs.realpathSync(packagePath),
    root: { path: root },
    resolved: `file:${path.join(vendor, "local.tgz")}`,
    package: { resolved: "file:vendor/local.tgz", engines: { node: ">=22.19.0" } },
    integrity: "sha512-locked-integrity",
    name: "@fixture/local",
    version: "1.2.3",
    location: "node_modules/@fixture/local",
  };
  const record = packageRecord(node);
  assert.equal(record.resolved, "file:vendor/local.tgz");
  assert.equal(record.name, "@fixture/local");
  assert.equal(record.version, "1.2.3");
  assert.equal(record.integrity, "sha512-locked-integrity");

  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t16-local-source-copy-"));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(otherRoot, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(otherRoot, "vendor", "local.tgz"), "locked tarball\n");
  const lockNode = {
    ...node,
    root: { path: otherRoot },
    resolved: `file:${path.join(otherRoot, "vendor", "local.tgz")}`,
  };
  assert.equal(normalizedResolved(lockNode), "file:vendor/local.tgz");
  assert.equal(lockPackageIdentity(node), lockPackageIdentity(lockNode));
});

test("local file dependency source must match its locked relative path and be a regular in-root file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-t16-local-source-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "local.tgz"), "locked tarball\n");
  const node = {
    root: { path: root },
    resolved: `file:${path.join(root, "vendor", "local.tgz")}`,
    package: { resolved: "file:vendor/local.tgz" },
  };
  fs.writeFileSync(path.join(root, "vendor", "other.tgz"), "other tarball\n");
  assert.throws(() => normalizedResolved({ ...node, resolved: `file:${path.join(root, "vendor", "other.tgz")}` }), { code: "DEPENDENCY_LOCAL_SOURCE_MISMATCH" });
  assert.throws(() => normalizedResolved({ ...node, package: { resolved: "file:../outside/local.tgz" } }), { code: "PACKAGE_PATH_INVALID" });

  fs.renameSync(path.join(root, "vendor", "local.tgz"), path.join(root, "vendor", "real.tgz"));
  fs.symlinkSync("real.tgz", path.join(root, "vendor", "local.tgz"));
  assert.throws(() => normalizedResolved(node), { code: "DEPENDENCY_LOCAL_SOURCE_INVALID" });
});

test("registry dependency resolution remains unchanged", () => {
  const resolved = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
  const node = { resolved, package: { resolved: "different metadata is not used for registry sources" } };
  assert.equal(normalizedResolved(node), resolved);
});

test("Arborist closure follows production, optional, and peer edges but skips dev-only edges", () => {
  const edge = (name, type, to, error = null) => ({ name, type, to, error });
  const pkg = (location, edges = []) => ({ location, isLink: false, errors: [], edgesOut: new Map(edges.map((value) => [value.name, value])) });
  const transitive = pkg("node_modules/transitive");
  const optional = pkg("node_modules/optional");
  const production = pkg("node_modules/production", [
    edge("transitive", "peer", transitive),
    edge("optional", "optional", optional),
    edge("missing-optional", "peerOptional", null, "MISSING"),
  ]);
  const dev = pkg("node_modules/dev-tool");
  const root = pkg("", [edge("production", "prod", production), edge("dev-tool", "dev", dev)]);
  const closure = productionClosure(root);
  assert.deepEqual([...closure.keys()].sort(), ["node_modules/optional", "node_modules/production", "node_modules/transitive"]);
  const invalid = pkg("", [edge("required", "prod", null, "MISSING")]);
  assert.throws(() => productionClosure(invalid), { code: "DEPENDENCY_EDGE_UNRESOLVED" });
});

test("T16 rejects extraneous or unlisted installed production packages", () => {
  const root = { location: "", inventory: new Map() };
  const locked = new Set(["node_modules/allowed"]);
  root.inventory.set("node_modules/allowed", { location: "node_modules/allowed", dev: false, devOptional: false, extraneous: false });
  root.inventory.set("node_modules/extra", { location: "node_modules/extra", dev: false, devOptional: false, extraneous: true });
  root.inventory.set("node_modules/dev-extra", { location: "node_modules/dev-extra", dev: true, devOptional: false, extraneous: true });
  assert.throws(() => rejectExtraneousProductionPackages(root, locked), { code: "DEPENDENCY_EXTRANEOUS" });
  root.inventory.delete("node_modules/extra");
  root.inventory.set("node_modules/unlisted", { location: "node_modules/unlisted", dev: false, devOptional: false, extraneous: false });
  assert.throws(() => rejectExtraneousProductionPackages(root, locked), { code: "DEPENDENCY_EXTRANEOUS" });
  root.inventory.delete("node_modules/unlisted");
  assert.equal(rejectExtraneousProductionPackages(root, locked), undefined);
});

test("manifest check ignores checker Node version only and still compares all closure fields", () => {
  const generated = { target: { platform: "linux", arch: "x64" }, evidence: { node: "v22.23.4", packageLockSha256: "lock-a" }, packages: [{ sha256: "files-a" }] };
  const checkedOnTarget = { target: { platform: "linux", arch: "x64" }, evidence: { node: "v24.22.0", packageLockSha256: "lock-a" }, packages: [{ sha256: "files-a" }] };
  assert.equal(manifestsMatch(generated, checkedOnTarget), true);
  assert.equal(manifestsMatch(generated, { ...checkedOnTarget, packages: [{ sha256: "files-b" }] }), false);
  assert.equal(manifestsMatch(generated, { ...checkedOnTarget, evidence: { ...checkedOnTarget.evidence, packageLockSha256: "lock-b" } }), false);
});

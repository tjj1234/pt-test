"use strict";

// Build/verify the production dependency closure on the frozen Linux/amd64
// target. Arborist supplies the lock/installed dependency graph; file hashes
// bind the exact installed bytes for each production package.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const SHELL = path.join(ROOT, "shell");
const ARBORIST_VERSION = "8.0.5";
const MIN_NODE = [22, 19, 0];
const requireShell = createRequire(path.join(SHELL, "package.json"));
const semver = requireShell("semver");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const compareStable = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function assertTargetPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" || arch !== "x64") {
    fail("TARGET_PLATFORM_REQUIRED", `Expected Linux/amd64 (linux/x64), received ${platform}/${arch}`);
  }
}

function assertNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) fail("NODE_VERSION_INVALID", `Cannot parse Node.js version: ${version}`);
  const found = match.slice(1).map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if (found[i] > MIN_NODE[i]) return;
    if (found[i] < MIN_NODE[i]) fail("NODE_VERSION_UNSUPPORTED", `Node.js >=22.19.0 is required by the locked production dependency engines, received ${version}`);
  }
}

function assertPackageNodeEngines(nodes, version = process.versions.node, semverImpl = semver) {
  for (const node of nodes) {
    const range = node.package?.engines?.node;
    if (typeof range !== "string" || !range.trim()) continue;
    if (!semverImpl.validRange(range) || !semverImpl.satisfies(version, range)) {
      fail("DEPENDENCY_NODE_ENGINE_UNSUPPORTED", `Node ${version} does not satisfy ${node.name}@${node.version} engine ${range}`);
    }
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("PACKAGE_PATH_INVALID", "Dependency package contains an unsafe relative path");
  }
  return value;
}

function walkPackageFiles(packagePath) {
  const rootStat = fs.lstatSync(packagePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("PACKAGE_ROOT_INVALID", "Dependency package root is not a real directory");
  const realRoot = fs.realpathSync(packagePath);
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareStable(a.name, b.name))) {
      if (entry.name === "node_modules") continue; // represented as separate Arborist nodes
      const relative = safeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(absolute, relative);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = fs.readFileSync(absolute);
        files.push({ path: relative, kind: "file", mode: stat.mode & 0o777, size: bytes.length, sha256: sha256(bytes) });
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (path.isAbsolute(target)) fail("PACKAGE_SYMLINK_ESCAPE", "Dependency package contains an absolute symlink");
        let resolved;
        try { resolved = fs.realpathSync(absolute); }
        catch { fail("PACKAGE_SYMLINK_DANGLING", "Dependency package contains a dangling symlink"); }
        const relativeTarget = path.relative(realRoot, resolved);
        if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
          fail("PACKAGE_SYMLINK_ESCAPE", "Dependency package symlink resolves outside its package root");
        }
        files.push({ path: relative, kind: "symlink", mode: stat.mode & 0o777, target });
      } else {
        fail("PACKAGE_ENTRY_TYPE_UNSUPPORTED", `Dependency package contains an unsupported entry: ${relative}`);
      }
    }
  };
  walk(packagePath, "");
  files.sort((a, b) => compareStable(a.path, b.path));
  return files;
}

function productionClosure(tree) {
  const selected = new Map();
  const visited = new Set();
  const queue = [tree];
  while (queue.length) {
    const node = queue.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    if (node !== tree) {
      if (node.isLink) fail("DEPENDENCY_LINK_UNSUPPORTED", `Linked dependency is outside the frozen package closure: ${node.location}`);
      if (node.errors?.length) fail("DEPENDENCY_METADATA_INVALID", `Invalid package metadata at ${node.location}`);
      selected.set(node.location, node);
    }
    for (const edge of node.edgesOut.values()) {
      if (edge.type === "dev" || edge.type === "devOptional") continue;
      if (!edge.to) {
        if (edge.type === "optional" || edge.type === "peerOptional") continue;
        fail("DEPENDENCY_EDGE_UNRESOLVED", `Required dependency is unresolved: ${node.location || "<root>"} -> ${edge.name}`);
      }
      queue.push(edge.to);
    }
  }
  return selected;
}

function rejectExtraneousProductionPackages(tree, lockedProduction) {
  for (const node of tree.inventory?.values?.() || []) {
    if (node === tree || node.dev || node.devOptional) continue;
    if (node.extraneous || !lockedProduction.has(node.location)) {
      fail("DEPENDENCY_EXTRANEOUS", `Unreferenced production package is installed: ${node.location}`);
    }
  }
}

function normalizedResolved(node) {
  const resolved = node.resolved || null;
  if (!resolved || !resolved.startsWith("file:")) return resolved;

  const lockedResolved = node.package?.resolved;
  if (typeof lockedResolved !== "string" || !lockedResolved.startsWith("file:")) {
    fail("DEPENDENCY_LOCAL_SOURCE_INVALID", "Local dependency source does not match its locked package metadata");
  }
  const relativeSource = safeRelativePath(lockedResolved.slice("file:".length));
  const rootPath = node.root?.path;
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    fail("DEPENDENCY_LOCAL_ROOT_INVALID", "Local dependency has no absolute project root");
  }

  const realRoot = fs.realpathSync(rootPath);
  const expectedPath = path.resolve(realRoot, ...relativeSource.split("/"));
  const actualSource = resolved.slice("file:".length);
  if (!path.isAbsolute(actualSource)) {
    fail("DEPENDENCY_LOCAL_SOURCE_MISMATCH", "Installed local dependency differs from its locked relative source");
  }

  let sourceStat;
  let realSource;
  try {
    sourceStat = fs.lstatSync(expectedPath);
    realSource = fs.realpathSync(expectedPath);
  } catch {
    fail("DEPENDENCY_LOCAL_SOURCE_INVALID", "Locked local dependency source is missing");
  }
  const relativeToRoot = path.relative(realRoot, realSource);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || realSource !== expectedPath ||
      relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    fail("DEPENDENCY_LOCAL_SOURCE_INVALID", "Locked local dependency source is not a regular in-root file");
  }
  let actualRealSource;
  try { actualRealSource = fs.realpathSync(path.resolve(actualSource)); }
  catch { fail("DEPENDENCY_LOCAL_SOURCE_INVALID", "Installed local dependency source is missing"); }
  if (actualRealSource !== realSource) {
    fail("DEPENDENCY_LOCAL_SOURCE_MISMATCH", "Installed local dependency differs from its locked relative source");
  }
  return lockedResolved;
}

function packageRecord(node) {
  const resolvedPath = fs.realpathSync(node.path);
  if (resolvedPath !== path.resolve(node.path)) fail("DEPENDENCY_PATH_REDIRECTED", `Dependency path resolves elsewhere: ${node.location}`);
  return {
    location: node.location,
    name: node.name,
    version: node.version,
    resolved: normalizedResolved(node),
    integrity: node.integrity || null,
    nodeEngine: node.package?.engines?.node || null,
    files: walkPackageFiles(node.path),
  };
}

function lockPackageIdentity(node) {
  return JSON.stringify({ name: node.name, version: node.version, resolved: normalizedResolved(node), integrity: node.integrity || null });
}

function manifestsMatch(expected, actual) {
  const normalize = (manifest) => {
    if (!manifest || typeof manifest !== "object" || !manifest.evidence || typeof manifest.evidence !== "object") return null;
    return JSON.stringify({
      ...manifest,
      evidence: { ...manifest.evidence, node: "<checker-runtime>" },
    });
  };
  const left = normalize(expected);
  return left != null && left === normalize(actual);
}

async function buildManifest({ root = ROOT, allowNonTargetInspection = false } = {}) {
  const shellDir = path.join(root, "shell");
  if (!allowNonTargetInspection) {
    assertTargetPlatform();
    assertNodeVersion();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(shellDir, "package.json"), "utf8"));
  const lockBytes = fs.readFileSync(path.join(shellDir, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (pkg.devDependencies?.["@npmcli/arborist"] !== ARBORIST_VERSION) fail("ARBORIST_VERSION_UNLOCKED", "package.json must pin the approved Arborist version exactly");
  const lockedArborist = lock.packages?.["node_modules/@npmcli/arborist"];
  if (!lockedArborist || lockedArborist.version !== ARBORIST_VERSION || !lockedArborist.integrity) {
    fail("ARBORIST_LOCK_MISMATCH", "package-lock.json does not integrity-lock the approved Arborist version");
  }
  const Arborist = requireShell("@npmcli/arborist");
  const arboristEntry = requireShell.resolve("@npmcli/arborist");
  const arboristPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(arboristEntry), "..", "package.json"), "utf8"));
  if (arboristPackage.version !== ARBORIST_VERSION) fail("ARBORIST_RUNTIME_MISMATCH", "Loaded Arborist does not match the locked version");

  const arb = new Arborist({ path: shellDir });
  const lockedTree = await arb.loadVirtual();
  const actualTree = await arb.loadActual();
  const expected = productionClosure(lockedTree);
  const actual = productionClosure(actualTree);
  rejectExtraneousProductionPackages(actualTree, expected);
  assertPackageNodeEngines(actual.values());
  for (const [location, node] of actual) {
    const lockNode = expected.get(location);
    if (!lockNode) fail("DEPENDENCY_NOT_LOCKED", `Installed production dependency is absent from lock closure: ${location}`);
    if (lockPackageIdentity(node) !== lockPackageIdentity(lockNode)) {
      fail("DEPENDENCY_LOCK_MISMATCH", `Installed package identity differs from lockfile: ${location}`);
    }
  }
  for (const [location, node] of expected) {
    if (!actual.has(location) && !node.optional) fail("DEPENDENCY_MISSING", `Locked required production dependency is not installed: ${location}`);
  }

  const packages = [...actual.values()].sort((a, b) => compareStable(a.location, b.location)).map(packageRecord);
  const lockSha256 = sha256(lockBytes);
  return {
    formatVersion: 1,
    target: { platform: process.platform, arch: process.arch, gate: allowNonTargetInspection ? "inspection-bypass" : "enforced" },
    evidence: {
      node: process.version,
      arborist: ARBORIST_VERSION,
      arboristIntegrity: lockedArborist.integrity,
      packageJsonSha256: sha256(fs.readFileSync(path.join(shellDir, "package.json"))),
      packageLockSha256: lockSha256,
      npmrcSha256: fs.existsSync(path.join(shellDir, ".npmrc")) ? sha256(fs.readFileSync(path.join(shellDir, ".npmrc"))) : null,
    },
    packageCount: packages.length,
    fileCount: packages.reduce((sum, item) => sum + item.files.length, 0),
    packages,
  };
}

async function main(argv) {
  const [mode, manifestPath, ...rest] = argv;
  if (!new Set(["--write", "--check"]).has(mode) || !manifestPath || rest.length) {
    fail("USAGE", "Usage: node scripts/northstar-dependency-closure.cjs (--write|--check) <manifest-path>");
  }
  const target = path.resolve(manifestPath);
  const manifest = await buildManifest();
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  if (mode === "--write") {
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  } else {
    let expected;
    try { expected = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch { fail("MANIFEST_INVALID", "Dependency closure manifest is not valid JSON"); }
    if (!manifestsMatch(expected, manifest)) fail("MANIFEST_MISMATCH", "Dependency closure manifest differs from this locked Linux/amd64 installation");
  }
  process.stdout.write(JSON.stringify({ result: "PASS", target: manifest.target, packageCount: manifest.packageCount, fileCount: manifest.fileCount,
    arborist: manifest.evidence.arborist, packageLockSha256: manifest.evidence.packageLockSha256,
    generatedWithNode: mode === "--check" ? JSON.parse(fs.readFileSync(target, "utf8")).evidence.node : manifest.evidence.node,
    checkedWithNode: process.version }, null, 2) + "\n");
}

module.exports = { assertTargetPlatform, assertNodeVersion, assertPackageNodeEngines, safeRelativePath, walkPackageFiles, productionClosure, rejectExtraneousProductionPackages, normalizedResolved, packageRecord, lockPackageIdentity, manifestsMatch, buildManifest };

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`DEPENDENCY_CLOSURE_FAILED: ${error.code || "CHECK_FAILED"}\n`);
  process.exitCode = 1;
});

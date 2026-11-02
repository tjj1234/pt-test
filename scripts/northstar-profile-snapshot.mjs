/**
 * Reproducible source-generated snapshot for the run-persistent DSH profile.
 * This never inspects the deployed runtime home, developer ~/.dsh, or .env.
 * Usage: node scripts/northstar-profile-snapshot.mjs [check|write]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = path.join(ROOT, "docs/dsh-profile-snapshot/run-persistent");
const MANIFEST = "northstar-profile-manifest.json";
const REQUIRED = [
  "budget.cjs", "cordis.patch.yml", "ga-query-executor.cjs", "northstar-patch-watch-compat.mjs",
  "northstar-profile-dependencies.json", "package.json", "persistent-runner.mjs", "pnpm-workspace.yaml", "run-budget.json", "run-budget-csv.json", "run-budget-media.json",
  "powertokens.cjs", "presets.cjs", "usage.cjs",
];
const sha256 = (value) => require("node:crypto").createHash("sha256").update(value).digest("hex");

/** Reject symlinked or non-directory snapshot ancestors before any snapshot write/read. */
export function assertSnapshotDirectoryContained(root, target, { allowMissing = false } = {}) {
  const rootReal = fs.realpathSync(root);
  const targetAbs = path.resolve(target);
  const rel = path.relative(path.resolve(root), targetAbs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Snapshot directory is outside repository root");
  }
  let current = path.resolve(root);
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(current) !== rootReal) {
    throw new Error("Repository root is not a real directory");
  }
  for (const component of rel.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Snapshot path contains a non-directory or symlink");
    const real = fs.realpathSync(current);
    const fromRoot = path.relative(rootReal, real);
    if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error("Snapshot directory resolves outside repository root");
    }
  }
  return true;
}

function makeSourceSnapshot() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "northstar-profile-snapshot-"));
  try {
    fs.chmodSync(temp, 0o700);
    const settingsTemplate = path.join(temp, "settings-template.yaml");
    fs.writeFileSync(settingsTemplate, "# Empty fixture used only to satisfy isolated profile generation.\n", { mode: 0o600, flag: "wx" });
    const dshHome = path.join(temp, "dsh-home");
    const runner = path.join(ROOT, "shell/persistent-runner.mjs");
    const { makeProfile } = require(path.join(ROOT, "shell/runtime/dsh-adapter.cjs"));
    const profile = makeProfile(dshHome, settingsTemplate, runner);
    const manifestPath = path.join(profile.dir, MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest || manifest.formatVersion !== 1 || manifest.rpcProtocolVersion !== 1 ||
        Object.keys(manifest.files || {}).sort().join("\0") !== [...REQUIRED].sort().join("\0")) {
      throw new Error("Generated run-persistent manifest has an unexpected file contract");
    }
    const files = new Map([[MANIFEST, fs.readFileSync(manifestPath)]]);
    for (const [name, expected] of Object.entries(manifest.files)) {
      const bytes = fs.readFileSync(path.join(profile.dir, name));
      if (sha256(bytes) !== expected) throw new Error(`Generated profile manifest mismatch: ${name}`);
      files.set(name, bytes);
    }
    const packageJson = JSON.parse(files.get("package.json").toString("utf8"));
    if (packageJson.name !== "dsh-profile-run-persistent" || !Array.isArray(packageJson.dsh?.profile?.bundles)) {
      throw new Error("Generated package.json is not the run-persistent profile");
    }
    return files;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function checkSnapshot(expected) {
  assertSnapshotDirectoryContained(ROOT, SNAPSHOT_DIR);
  const actualNames = fs.readdirSync(SNAPSHOT_DIR).filter((name) => name !== "README.md").sort();
  const expectedNames = [...expected.keys()].sort();
  if (actualNames.join("\0") !== expectedNames.join("\0")) throw new Error("Snapshot file set differs from current generated profile");
  for (const [name, bytes] of expected) {
    const target = path.join(SNAPSHOT_DIR, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(target).equals(bytes)) {
      throw new Error(`Snapshot differs from current generated profile: ${name}`);
    }
  }
}

function writeSnapshot(expected) {
  // Validate existing ancestors and reject symlinks before mkdir/write can follow them.
  assertSnapshotDirectoryContained(ROOT, SNAPSHOT_DIR, { allowMissing: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  assertSnapshotDirectoryContained(ROOT, SNAPSHOT_DIR);
  for (const [name, bytes] of expected) {
    const target = path.join(SNAPSHOT_DIR, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular snapshot target: ${name}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.writeFileSync(target, bytes, { mode: 0o644 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const mode = process.argv[2] || "check";
  if (!new Set(["check", "write"]).has(mode)) throw new Error("Expected check or write");
  const snapshot = makeSourceSnapshot();
  if (mode === "write") writeSnapshot(snapshot);
  checkSnapshot(snapshot);
  const manifest = JSON.parse(snapshot.get(MANIFEST).toString("utf8"));
  process.stdout.write(JSON.stringify({
    result: "PASS",
    scope: "source-generated-run-persistent-candidate",
    fileCount: snapshot.size,
    manifestSha256: sha256(snapshot.get(MANIFEST)),
    files: Object.keys(manifest.files).sort(),
    deployedProfileVerified: false,
  }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`PROFILE_SNAPSHOT_FAILED: ${error.code || "SNAPSHOT_INVALID"}\n`);
  process.exitCode = 1;
}

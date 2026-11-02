"use strict";

// Isolated PGlite + allowlisted-file snapshot prototype. This is deliberately
// not wired into server startup or deployment. Archives are uncompressed and
// size-bounded. Checksums detect accidental corruption; they are not signatures
// and do not authenticate a backup against an attacker who can rewrite it.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAGIC = Buffer.from("NSBKP001", "ascii");
const DIGEST_BYTES = 32;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const ROOTS = Object.freeze([
  ["db", (dbDir) => dbDir],
  ["runtime/_uploads", (_dbDir, runtimeDir) => path.join(runtimeDir, "_uploads")],
  ["runtime/workspaces", (_dbDir, runtimeDir) => path.join(runtimeDir, "workspaces")],
  ["runtime/workspace/.dsh/skills", (_dbDir, runtimeDir) => path.join(runtimeDir, "workspace", ".dsh", "skills")],
]);
const ALLOWED_ROOTS = ROOTS.map(([name]) => name);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest();
const fail = (code, message) => Object.assign(new Error(message), { code });

function resolveAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw fail("BACKUP_PATH_ABSOLUTE_REQUIRED", label + " must be an absolute path");
  return path.resolve(value);
}

function assertNoSymlinkComponents(value, { allowMissing = false } = {}) {
  const absolute = resolveAbsolute(value, "path");
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let missing = false;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (missing) continue;
    let st;
    try { st = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
      missing = true;
      continue;
    }
    if (st.isSymbolicLink()) throw fail("BACKUP_SYMLINK_REJECTED", "symlink path rejected");
  }
  return absolute;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function assertDisjoint(paths) {
  const normalized = paths.map((p) => path.resolve(p));
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (isWithin(normalized[i], normalized[j]) || isWithin(normalized[j], normalized[i])) {
        throw fail("BACKUP_ROOTS_OVERLAP", "backup source roots must be disjoint");
      }
    }
  }
}

function assertPGliteOnly(backend, env) {
  if (backend !== "pglite") throw fail("BACKUP_BACKEND_UNSUPPORTED", "only explicit pglite snapshots are supported");
  for (const [name, value] of Object.entries(env || {})) {
    if (/^PT_PG_/i.test(name) && typeof value === "string" && value.trim()) {
      throw fail("BACKUP_POSTGRES_CONFIGURED", "PostgreSQL configuration is present; refusing filesystem backup");
    }
  }
}

function relativeMember(rootName, relative) {
  const value = relative ? rootName + "/" + relative.split(path.sep).join("/") : rootName;
  if (value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail("BACKUP_PATH_INVALID", "non-canonical backup member path");
  }
  return value;
}

function checkMasterKeyBoundary(masterKeyFile, sourceRoots) {
  if (!masterKeyFile) return;
  let keyPath = resolveAbsolute(masterKeyFile, "masterKeyFile");
  try { keyPath = fs.realpathSync(keyPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (sourceRoots.some((root) => isWithin(root, keyPath))) {
    throw fail("BACKUP_MASTER_KEY_IN_SOURCE", "configured master key is inside an allowlisted backup root");
  }
}

function assertRegularDirectory(abs, { allowMissing = false } = {}) {
  assertNoSymlinkComponents(abs, { allowMissing });
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) throw fail("BACKUP_ROOT_INVALID", "backup root must be a regular directory");
    return fs.realpathSync(abs);
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return path.resolve(abs);
    throw error;
  }
}

function walkRoot(sourceRoot, memberRoot, entries) {
  assertNoSymlinkComponents(sourceRoot, { allowMissing: true });
  const rootStat = fs.existsSync(sourceRoot) ? fs.lstatSync(sourceRoot) : null;
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw fail("BACKUP_ROOT_INVALID", "allowlisted component must be a regular directory");
  entries.push({ path: memberRoot, type: "directory", size: 0, sha256: null, mode: rootStat ? (rootStat.mode & 0o700) : 0o700, source: sourceRoot });
  if (!rootStat) return;

  const walk = (absDir, relDir) => {
    const children = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const abs = path.join(absDir, child.name);
      const rel = relDir ? path.join(relDir, child.name) : child.name;
      const member = relativeMember(memberRoot, rel);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) throw fail("BACKUP_SYMLINK_REJECTED", "symlink entry rejected");
      if (st.isDirectory()) {
        entries.push({ path: member, type: "directory", size: 0, sha256: null, mode: 0o700, source: abs });
        walk(abs, rel);
      } else if (st.isFile() && st.nlink === 1) {
        entries.push({ path: member, type: "file", size: st.size, sha256: null, mode: (st.mode & 0o100) ? 0o700 : 0o600, source: abs });
      } else {
        throw fail("BACKUP_ENTRY_TYPE_REJECTED", "non-regular or hard-linked source entry rejected");
      }
    }
  };
  walk(sourceRoot, "");
};

function hashStableFile(abs) {
  const before = fs.lstatSync(abs);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw fail("BACKUP_ENTRY_CHANGED", "source file is not a unique regular file");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(abs, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw fail("BACKUP_ENTRY_CHANGED", "source file changed before reading");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (!n) break;
      total += n;
      hash.update(chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd);
    if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) throw fail("BACKUP_ENTRY_CHANGED", "source file changed while hashing");
    return { size: total, sha256: hash.digest("hex"), stat: opened };
  } finally { fs.closeSync(fd); }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function copyStableFile(source, outFd, expected) {
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw fail("BACKUP_ENTRY_CHANGED", "source file changed before archive write");
  const inFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(inFd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== expected.size || opened.nlink !== 1) throw fail("BACKUP_ENTRY_CHANGED", "source file identity changed");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const n = fs.readSync(inFd, chunk, 0, chunk.length, total);
      if (!n) break;
      const bytes = chunk.subarray(0, n);
      writeAll(outFd, bytes);
      hash.update(bytes);
      total += n;
    }
    const after = fs.fstatSync(inFd);
    if (total !== expected.size || hash.digest("hex") !== expected.sha256 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw fail("BACKUP_ENTRY_CHANGED", "source file changed during archive write");
  } finally { fs.closeSync(inFd); }
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== "northstar-pglite-backup" || manifest.version !== 1 || manifest.backend !== "pglite" || !Array.isArray(manifest.entries) || typeof manifest.createdAt !== "string") {
    throw fail("BACKUP_MANIFEST_INVALID", "unsupported backup manifest");
  }
  let previous = "";
  let payloadBytes = 0;
  const byPath = new Map();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || !["directory", "file"].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isInteger(entry.mode) || (entry.mode & ~0o700) !== 0) throw fail("BACKUP_MANIFEST_INVALID", "invalid backup manifest entry");
    const parts = entry.path.split("/");
    if (entry.path.includes("\\") || entry.path.startsWith("/") || parts.some((part) => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(entry.path)) throw fail("BACKUP_PATH_INVALID", "invalid backup member path");
    if (!ALLOWED_ROOTS.some((root) => entry.path === root || entry.path.startsWith(root + "/"))) throw fail("BACKUP_PATH_NOT_ALLOWED", "manifest path is outside the allowlist");
    if (entry.path <= previous) throw fail("BACKUP_MANIFEST_INVALID", "manifest entries must be unique and sorted");
    previous = entry.path;
    byPath.set(entry.path, entry);
    if (entry.type === "directory") {
      if (entry.size !== 0 || entry.sha256 !== null) throw fail("BACKUP_MANIFEST_INVALID", "directory entry must not carry payload");
    } else {
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw fail("BACKUP_MANIFEST_INVALID", "file digest is invalid");
      payloadBytes += entry.size;
      if (!Number.isSafeInteger(payloadBytes)) throw fail("BACKUP_TOO_LARGE", "backup payload is too large");
    }
  }
  for (const root of ALLOWED_ROOTS) {
    const rootEntries = manifest.entries.filter((entry) => entry.path === root);
    if (rootEntries.length !== 1 || rootEntries[0].type !== "directory") throw fail("BACKUP_MANIFEST_INVALID", "required allowlisted root must appear exactly once as a directory");
  }
  // Validate the archive as a tree before extraction. Every descendant below
  // an allowlisted root must have explicit directory ancestors; otherwise a
  // file-as-parent collision could pass checksum verification and fail only
  // after the target has been partially populated.
  for (const entry of manifest.entries) {
    const root = ALLOWED_ROOTS.find((candidate) => entry.path === candidate || entry.path.startsWith(candidate + "/"));
    if (!root || entry.path === root) continue;
    const relativeParts = entry.path.slice(root.length + 1).split("/");
    let parent = root;
    for (const component of relativeParts.slice(0, -1)) {
      parent += "/" + component;
      const parentEntry = byPath.get(parent);
      if (!parentEntry || parentEntry.type !== "directory") throw fail("BACKUP_MANIFEST_INVALID", "manifest entry has a missing or non-directory parent");
    }
  }
  return payloadBytes;
}

function createBackup({ backend, dbDir, runtimeDir, outputFile, env = process.env, masterKeyFile, maxArchiveBytes = MAX_ARCHIVE_BYTES }) {
  assertPGliteOnly(backend, env);
  const db = assertRegularDirectory(resolveAbsolute(dbDir, "dbDir"));
  const runtime = assertRegularDirectory(resolveAbsolute(runtimeDir, "runtimeDir"));
  assertDisjoint([db, runtime]);
  const output = assertNoSymlinkComponents(resolveAbsolute(outputFile, "outputFile"), { allowMissing: true });
  const parent = path.dirname(output);
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== parent) throw fail("BACKUP_OUTPUT_PARENT_SYMLINK", "archive parent must not contain symlinks");
  if (fs.existsSync(output)) throw fail("BACKUP_OUTPUT_EXISTS", "backup output already exists");
  if (isWithin(db, output) || isWithin(runtime, output)) throw fail("BACKUP_OUTPUT_IN_SOURCE", "backup output must be outside source roots");

  const sourceRoots = ROOTS.map(([member, resolve]) => [member, path.resolve(resolve(db, runtime))]);
  checkMasterKeyBoundary(masterKeyFile, sourceRoots.map(([, root]) => root));
  const entries = [];
  for (const [member, source] of sourceRoots) walkRoot(source, member, entries);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const entry of entries) if (entry.type === "file") {
    const hashed = hashStableFile(entry.source);
    entry.size = hashed.size;
    entry.sha256 = hashed.sha256;
    entry.mode = (entry.mode & 0o100) ? 0o700 : 0o600;
  }
  const manifest = {
    format: "northstar-pglite-backup",
    version: 1,
    backend: "pglite",
    createdAt: new Date().toISOString(),
    entries: entries.map(({ path: member, type, size, sha256: digest, mode }) => ({ path: member, type, size, sha256: digest, mode })),
  };
  const payloadBytes = validateManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw fail("BACKUP_MANIFEST_TOO_LARGE", "backup manifest is too large");
  const archiveBytes = MAGIC.length + 4 + manifestBytes.length + DIGEST_BYTES + payloadBytes;
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes > maxArchiveBytes) throw fail("BACKUP_TOO_LARGE", "backup exceeds the configured size limit");

  const temp = path.join(parent, "." + path.basename(output) + ".tmp-" + crypto.randomBytes(12).toString("hex"));
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    writeAll(fd, MAGIC);
    const length = Buffer.alloc(4); length.writeUInt32BE(manifestBytes.length);
    writeAll(fd, length);
    writeAll(fd, manifestBytes);
    writeAll(fd, sha256(manifestBytes));
    for (const entry of entries) if (entry.type === "file") copyStableFile(entry.source, fd, entry);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    // link() creates the final name without replacing an existing file.
    fs.linkSync(temp, output);
    try { fs.unlinkSync(temp); } catch { /* the verified final archive is already published */ }
    return { outputFile: output, manifestSha256: sha256(manifestBytes).toString("hex"), entries: manifest.entries.length, payloadBytes };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(temp); } catch { /* no temp to clean */ }
    throw error;
  }
}

function readExact(fd, length, position) {
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, out, offset, length - offset, position + offset);
    if (!read) throw fail("BACKUP_ARCHIVE_TRUNCATED", "backup archive is truncated");
    offset += read;
  }
  return out;
}

function openAndVerifyArchive(inputFile, maxArchiveBytes) {
  const input = assertNoSymlinkComponents(resolveAbsolute(inputFile, "inputFile"));
  const st = fs.lstatSync(input);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw fail("BACKUP_ARCHIVE_INVALID", "backup must be a unique regular file");
  if (st.size > maxArchiveBytes || st.size < MAGIC.length + 4 + DIGEST_BYTES) throw fail("BACKUP_ARCHIVE_SIZE_INVALID", "backup archive size is invalid");
  const fd = fs.openSync(input, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) throw fail("BACKUP_ARCHIVE_CHANGED", "backup archive identity changed");
    if (!readExact(fd, MAGIC.length, 0).equals(MAGIC)) throw fail("BACKUP_ARCHIVE_INVALID", "backup archive magic is invalid");
    const manifestLength = readExact(fd, 4, MAGIC.length).readUInt32BE(0);
    if (manifestLength <= 0 || manifestLength > MAX_MANIFEST_BYTES) throw fail("BACKUP_MANIFEST_TOO_LARGE", "backup manifest size is invalid");
    const manifestOffset = MAGIC.length + 4;
    const manifestBytes = readExact(fd, manifestLength, manifestOffset);
    const expectedManifestHash = readExact(fd, DIGEST_BYTES, manifestOffset + manifestLength);
    if (!crypto.timingSafeEqual(sha256(manifestBytes), expectedManifestHash)) throw fail("BACKUP_MANIFEST_HASH_MISMATCH", "backup manifest checksum mismatch");
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw fail("BACKUP_MANIFEST_INVALID", "backup manifest is not valid JSON"); }
    const payloadBytes = validateManifest(manifest);
    const payloadOffset = manifestOffset + manifestLength + DIGEST_BYTES;
    if (payloadOffset + payloadBytes !== opened.size) throw fail("BACKUP_ARCHIVE_LENGTH_MISMATCH", "backup payload length does not match manifest");
    let cursor = payloadOffset;
    for (const entry of manifest.entries) if (entry.type === "file") {
      const hash = crypto.createHash("sha256");
      let left = entry.size;
      while (left > 0) {
        const size = Math.min(left, 64 * 1024);
        const bytes = readExact(fd, size, cursor);
        hash.update(bytes);
        cursor += size;
        left -= size;
      }
      if (hash.digest("hex") !== entry.sha256) throw fail("BACKUP_FILE_HASH_MISMATCH", "backup payload checksum mismatch");
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw fail("BACKUP_ARCHIVE_CHANGED", "backup archive changed while verifying");
    return { fd, input, stat: opened, manifest, manifestSha256: expectedManifestHash.toString("hex"), payloadOffset };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function writePayloadFile(fd, archiveFd, entry, position, destination) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const outFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const hash = crypto.createHash("sha256");
  let cursor = position;
  let left = entry.size;
  try {
    while (left > 0) {
      const size = Math.min(left, 64 * 1024);
      const bytes = readExact(archiveFd, size, cursor);
      writeAll(outFd, bytes);
      hash.update(bytes);
      cursor += size;
      left -= size;
    }
    if (hash.digest("hex") !== entry.sha256) throw fail("BACKUP_FILE_HASH_MISMATCH", "backup payload changed during restore");
    fs.fchmodSync(outFd, entry.mode & 0o700);
    fs.fsyncSync(outFd);
  } finally { fs.closeSync(outFd); }
  return cursor;
}

function restoreBackup({ backend, inputFile, targetRoot, env = process.env, maxArchiveBytes = MAX_ARCHIVE_BYTES }) {
  assertPGliteOnly(backend, env);
  const target = assertNoSymlinkComponents(resolveAbsolute(targetRoot, "targetRoot"), { allowMissing: true });
  const parent = path.dirname(target);
  const parentReal = fs.realpathSync(parent);
  if (parentReal !== parent) throw fail("BACKUP_TARGET_PARENT_SYMLINK", "restore target parent must not contain symlinks");
  if (fs.existsSync(target)) throw fail("BACKUP_TARGET_EXISTS", "restore target already exists; refusing overwrite");
  const archiveReal = fs.realpathSync(resolveAbsolute(inputFile, "inputFile"));
  if (isWithin(target, archiveReal) || isWithin(archiveReal, target)) throw fail("BACKUP_TARGET_OVERLAP", "restore target and archive path must be disjoint");

  const verified = openAndVerifyArchive(inputFile, maxArchiveBytes);
  try {
    // Exclusive mkdir is the no-overwrite claim. A failed extraction leaves an
    // explicit marker; it never clears or replaces any directory.
    fs.mkdirSync(target, { mode: 0o700 });
    const marker = path.join(target, "RESTORE-INCOMPLETE");
    fs.writeFileSync(marker, "Restore did not finish successfully. Preserve and inspect this directory.\n", { flag: "wx", mode: 0o600 });
    const rootModes = new Map();
    let cursor = verified.payloadOffset;
    for (const entry of verified.manifest.entries) {
      const destination = path.join(target, ...entry.path.split("/"));
      const relative = path.relative(target, destination);
      if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) throw fail("BACKUP_PATH_INVALID", "restore member escaped target root");
      if (entry.type === "directory") {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        rootModes.set(destination, entry.mode & 0o700);
      } else cursor = writePayloadFile(verified.fd, verified.fd, entry, cursor, destination);
    }
    if (cursor !== verified.stat.size) throw fail("BACKUP_ARCHIVE_LENGTH_MISMATCH", "restore did not consume the full archive");
    const after = fs.fstatSync(verified.fd);
    if (after.dev !== verified.stat.dev || after.ino !== verified.stat.ino || after.size !== verified.stat.size || after.mtimeMs !== verified.stat.mtimeMs) throw fail("BACKUP_ARCHIVE_CHANGED", "backup archive changed during restore");
    for (const [dir, mode] of [...rootModes.entries()].sort((a, b) => b[0].length - a[0].length)) fs.chmodSync(dir, mode || 0o700);
    fs.unlinkSync(marker);
    return { targetRoot: target, dbDir: path.join(target, "db"), runtimeDir: path.join(target, "runtime"), manifestSha256: verified.manifestSha256, entries: verified.manifest.entries.length };
  } catch (error) {
    // Keep marker and partial target for explicit operator inspection.
    throw error;
  } finally { fs.closeSync(verified.fd); }
}

module.exports = { createBackup, restoreBackup, assertPGliteOnly, ROOTS, MAX_ARCHIVE_BYTES };

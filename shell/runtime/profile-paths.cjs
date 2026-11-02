"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const error = (code, message) => Object.assign(new Error(message), { code });
const uid = () => typeof process.getuid === "function" ? process.getuid() : null;

// POSIX ownership is part of this contract. Windows ACLs need a separate
// implementation; permission bits there must not be treated as equivalent.
function trustedDirectory(target, { managed = false, create = false } = {}) {
  if (uid() === null) throw error("PROFILE_PATH_POLICY_UNSUPPORTED", "Profile path ownership requires a POSIX policy");
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (cause) {
      if (cause.code !== "ENOENT" || !create) throw cause;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      // macOS publishes these root-owned system aliases. No user-controlled
      // symlink, including the supplied home or profiles directory, is allowed.
      const systemAlias = process.platform === "darwin" && stat.uid === 0 &&
        ["/tmp", "/var", "/etc"].includes(current) &&
        fs.realpathSync(current) === "/private" + current;
      if (!systemAlias) throw error("PROFILE_PATH_UNSAFE", "Profile path traverses a symbolic link");
      current = fs.realpathSync(current);
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory()) throw error("PROFILE_PATH_UNSAFE", "Profile path is not a directory");
    const isTarget = index === parts.length - 1;
    const stickySystemAncestor = !isTarget && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.uid !== 0 && stat.uid !== uid()) || ((stat.mode & 0o022) !== 0 && !stickySystemAncestor)) {
      throw error("PROFILE_PATH_UNSAFE", "Profile directory ownership or write permissions are unsafe");
    }
  }
  const result = fs.realpathSync(absolute);
  const stat = fs.lstatSync(result);
  if (managed && (stat.uid !== uid() || (stat.mode & 0o022) !== 0)) {
    throw error("PROFILE_PATH_UNSAFE", "Managed profile directories require private write ownership");
  }
  return result;
}
function absoluteExists(target) { try { fs.lstatSync(target); return true; } catch (cause) { if (cause.code === "ENOENT") return false; throw cause; } }

function prepareProfilePaths(dshHome) {
  if (typeof dshHome !== "string" || !dshHome.trim()) throw error("PROFILE_PATH_UNSAFE", "Explicit DSH home is required");
  const home = trustedDirectory(dshHome, { managed: true, create: true });
  const profilesDir = trustedDirectory(path.join(home, "profiles"), { managed: true, create: true });
  return { home, profilesDir };
}
function checkSettings(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o022) !== 0) {
    throw error("PROFILE_SETTINGS_UNSAFE", "Settings must be a regular file with trusted write ownership");
  }
}
function seedSettings(home, settingsTemplate) {
  trustedDirectory(home, { managed: true });
  const destination = path.join(home, "settings.yaml");
  if (absoluteExists(destination)) { checkSettings(destination); return; }
  if (!settingsTemplate) throw error("PROFILE_SETTINGS_MISSING", "Settings template is required for a new DSH home");
  const temporary = path.join(home, ".northstar-settings-" + crypto.randomBytes(16).toString("hex"));
  try {
    const content = fs.readFileSync(settingsTemplate);
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    // Exclusive publication: link fails if another creator already published.
    // Unlike rename, this never replaces an existing operator settings file.
    try { fs.linkSync(temporary, destination); }
    catch (cause) { if (cause.code !== "EEXIST") throw cause; }
    checkSettings(destination);
  } catch (cause) {
    if (cause.code === "PROFILE_SETTINGS_UNSAFE") throw cause;
    throw error("PROFILE_SETTINGS_FAILED", "Could not seed DSH settings; runtime startup is blocked");
  } finally {
    if (absoluteExists(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { prepareProfilePaths, seedSettings };

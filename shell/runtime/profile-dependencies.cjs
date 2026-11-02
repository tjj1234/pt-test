"use strict";

const crypto = require("node:crypto");
const PROFILE_DEPENDENCY_FILE = "northstar-profile-dependencies.json";

function invalid(message) {
  return Object.assign(new Error(message), { code: "PROFILE_DEPENDENCIES_INVALID" });
}

function exactVersion(version) {
  if (typeof version !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  return !!match && (!match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")));
}

function validIntegrity(value) {
  if (typeof value !== "string") return false;
  const match = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  return bytes.length === Number(match[1]) / 8 && bytes.toString("base64") === match[2];
}

/**
 * Bind generated profile inputs to the release's npm lockfile. This is a
 * declaration of release inputs, not verification of installed dependencies.
 * Accept raw bytes so whitespace changes also invalidate the managed profile.
 */
function buildProfileDependencyContract({ lockfile, npmrc, bundles = ["@deepseek-ai/dsh-base"] } = {}) {
  if (!(typeof lockfile === "string" || Buffer.isBuffer(lockfile))) {
    throw invalid("Profile dependencies require raw shell lockfile bytes");
  }
  if (!(typeof npmrc === "string" || Buffer.isBuffer(npmrc))) {
    throw invalid("Profile dependencies require raw shell npm installation policy bytes");
  }
  let lock;
  try { lock = JSON.parse(lockfile.toString()); }
  catch { throw invalid("Shell dependency lockfile is invalid JSON"); }
  if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages || typeof lock.packages !== "object") {
    throw invalid("Shell dependency lockfile requires npm packages metadata");
  }
  if (!Array.isArray(bundles) || !bundles.length || new Set(bundles).size !== bundles.length) {
    throw invalid("Profile bundles must be a nonempty unique package list");
  }
  const dependencies = {};
  const lockedBundles = {};
  for (const name of bundles) {
    if (typeof name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw invalid("Profile bundle name is invalid");
    }
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || entry.link || entry.dev || entry.optional ||
        !exactVersion(entry.version) ||
        typeof entry.resolved !== "string" || !entry.resolved ||
        !validIntegrity(entry.integrity)) {
      throw invalid(`Profile bundle lacks a production exact-version lock entry: ${name}`);
    }
    dependencies[name] = entry.version;
    lockedBundles[name] = { version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
  }
  return {
    dependencies,
    bundles: [...bundles],
    releaseInput: {
      schemaVersion: 1,
      shellLockfileSha256: crypto.createHash("sha256").update(lockfile).digest("hex"),
      shellNpmrcSha256: crypto.createHash("sha256").update(npmrc).digest("hex"),
      bundles: lockedBundles,
    },
  };
}

module.exports = { buildProfileDependencyContract, PROFILE_DEPENDENCY_FILE };

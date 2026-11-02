"use strict";

const crypto = require("node:crypto");

const HASH_RE = /^[a-f0-9]{64}$/;
const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalid(message) {
  return new TypeError(`Invalid skill release snapshot: ${message}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw invalid("file entry must be an object");
  const filePath = file.path;
  if (typeof filePath !== "string" || !filePath || filePath.startsWith("/") || /^[a-z]:/i.test(filePath) ||
      filePath.includes("\\") || filePath.includes("\0")) {
    throw invalid("file path must be a non-empty relative POSIX path");
  }
  const parts = filePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw invalid("file path is not canonical");
  if (filePath.normalize("NFC") !== filePath) throw invalid("file path must use Unicode NFC normalization");
  if (!(typeof file.content === "string" || Buffer.isBuffer(file.content))) throw invalid("file content must be text or bytes");
  const content = Buffer.isBuffer(file.content) ? Buffer.from(file.content) : Buffer.from(file.content, "utf8");
  return Object.freeze({ path: filePath, bytes: content.length, sha256: sha256(content) });
}

/**
 * Build deterministic release content identity from the exact regular-file
 * snapshot supplied by a trusted publisher/loader boundary. This helper does
 * not read disk, select files, grant capabilities, or authorize publication.
 */
function createSkillReleaseSnapshot({ skillId, version, files } = {}) {
  if (typeof skillId !== "string" || !SKILL_ID_RE.test(skillId)) throw invalid("skillId must use DSH kebab-case skill naming");
  if (typeof version !== "string" || !version.trim() || version !== version.trim()) throw invalid("version must be a non-empty opaque string");
  if (!Array.isArray(files) || files.length === 0) throw invalid("files must contain at least one file");
  const normalized = files.map(normalizeFile).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(normalized.map((file) => file.path)).size !== normalized.length) throw invalid("file paths must be unique");
  const portablePaths = normalized.map((file) => file.path.toLowerCase());
  if (new Set(portablePaths).size !== portablePaths.length) throw invalid("file paths must be unique under case-insensitive comparison");
  const canonical = JSON.stringify(normalized.map(({ path, bytes, sha256: digest }) => [path, bytes, digest]));
  const contentHash = sha256(Buffer.concat([Buffer.from("northstar-skill-content-v1\0", "utf8"), Buffer.from(canonical, "utf8")]));
  return Object.freeze({
    schemaVersion: 1,
    skillId,
    version,
    contentHash,
    files: Object.freeze(normalized),
  });
}

/**
 * Pin the identity of already-authorized releases for one Run. Input order is
 * ignored; one version per skill is allowed. Publication/enabled-state checks
 * and persistence remain the caller's responsibility.
 */
function pinSkillReleases(releases) {
  if (!Array.isArray(releases)) throw invalid("Run pin input must be an array");
  const skills = releases.map((release) => {
    if (!release || typeof release !== "object" || Array.isArray(release) || release.schemaVersion !== 1 ||
        typeof release.skillId !== "string" || !SKILL_ID_RE.test(release.skillId) ||
        typeof release.version !== "string" || !release.version.trim() || release.version !== release.version.trim() ||
        typeof release.contentHash !== "string" || !HASH_RE.test(release.contentHash)) {
      throw invalid("Run pin requires schema v1 skillId/version/contentHash identities");
    }
    return Object.freeze({ skillId: release.skillId, version: release.version, contentHash: release.contentHash });
  }).sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0);
  if (new Set(skills.map((skill) => skill.skillId)).size !== skills.length) throw invalid("Run pin may contain only one release per skillId");
  return Object.freeze({ schemaVersion: 1, skills: Object.freeze(skills) });
}

module.exports = { createSkillReleaseSnapshot, pinSkillReleases };

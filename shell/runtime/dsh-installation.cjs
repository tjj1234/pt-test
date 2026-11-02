'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NAME = '@deepseek-ai/dsh';
const VERSION = '0.1.1-rc.2';
const RESOLVED = 'file:vendor/deepseek-ai-dsh-0.1.1-rc.2.tgz';
const fail = (message, code = 'DSH_INSTALLATION_INVALID') => Object.assign(new Error(message), { code });
function regular(filename, directory = false) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw fail('Required DSH installation entry is missing', 'DSH_INSTALLATION_MISSING'); }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw fail('DSH installation entry is not regular');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  function checkOwnerMode(current, ancestor) {
    const allowedOwner = uid === null || current.uid === uid || current.uid === 0;
    const stickyAncestor = ancestor && current.isDirectory() && current.uid === 0 && (current.mode & 0o1000) !== 0;
    if (!allowedOwner || ((current.mode & 0o022) !== 0 && !stickyAncestor)) throw fail('DSH installation path is writable by an untrusted principal', 'DSH_INSTALLATION_UNSAFE');
  }
  checkOwnerMode(stat, false);
  let ancestor = path.dirname(filename);
  for (;;) {
    const current = fs.lstatSync(ancestor);
    if (current.isSymbolicLink() || !current.isDirectory()) throw fail('DSH installation path has an unsafe ancestor', 'DSH_ENTRY_UNTRUSTED');
    checkOwnerMode(current, true);
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
}
function json(filename) { regular(filename); try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw fail('DSH installation metadata is invalid'); } }
const digest = (bytes, type = 'sha256', encoding = 'hex') => crypto.createHash(type).update(bytes).digest(encoding);
/** Trusted manifest covers every regular file of the DSH package and rejects
 * unlisted files/symlinks. It does not verify the dependency package closure.
 * packageRoot/lockfilePath/manifestPath are deployment configuration, never input
 * from a tenant. No PATH, global npm, cwd or package-version-only fallback exists.
 */
function resolveDshInstallation({ explicitEntry, envEntry, packageRoot = path.resolve(__dirname, '../node_modules/@deepseek-ai/dsh'), lockfilePath = path.resolve(__dirname, '../package-lock.json'), manifestPath = path.join(__dirname, 'dsh-release-manifest.json') } = {}) {
  if (![packageRoot, lockfilePath, manifestPath].every(value => typeof value === 'string' && path.isAbsolute(value))) throw fail('DSH installation configuration must use absolute paths');
  const root = path.normalize(packageRoot);
  const entry = path.join(root, 'lib/bin.js');
  for (const override of [explicitEntry, envEntry]) {
    if (override == null) continue;
    if (typeof override !== 'string' || !path.isAbsolute(override) || path.normalize(override) !== entry) throw fail('DSH entry override must reference the packaged installation', 'DSH_ENTRY_UNTRUSTED');
  }
  regular(root, true); regular(path.join(root, 'lib'), true);
  regular(path.join(root, 'package.json')); regular(entry);
  if (fs.realpathSync(root) !== root || fs.realpathSync(entry) !== entry) throw fail('DSH entry resolves outside packaged installation', 'DSH_ENTRY_UNTRUSTED');
  for (const filename of [lockfilePath, manifestPath]) { regular(filename); if (fs.realpathSync(filename) !== path.normalize(filename)) throw fail('DSH trust metadata has symlink ancestors'); }
  const manifest = json(manifestPath);
  if (manifest?.schemaVersion !== 1 || manifest.packageName !== NAME || manifest.version !== VERSION || manifest.entry !== 'lib/bin.js' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !Object.hasOwn(manifest.files, 'package.json') || !Object.hasOwn(manifest.files, 'lib/bin.js') || Object.keys(manifest.files).some(relative => !relative || path.posix.normalize(relative) !== relative || relative.startsWith('/') || relative.split('/').some(segment => segment === '..' || segment === '.') || relative.includes('\\') || relative.includes(String.fromCharCode(0))) || Object.values(manifest.files).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) || !/^[a-f0-9]{64}$/.test(manifest.vendorSha256 || '') || manifest.lock?.resolved !== RESOLVED || typeof manifest.lock?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(manifest.lock.integrity)) throw fail('Trusted DSH release manifest is invalid', 'DSH_MANIFEST_INVALID');
  if (manifest.lockfileSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(manifest.lockfileSha256) || digest(fs.readFileSync(lockfilePath)) !== manifest.lockfileSha256)) throw fail('Lockfile differs from trusted release manifest', 'DSH_LOCK_MISMATCH');
  const lock = json(lockfilePath);
  const locked = lock.packages?.['node_modules/@deepseek-ai/dsh'];
  if (![2, 3].includes(lock.lockfileVersion) || locked?.version !== VERSION || locked.resolved !== manifest.lock.resolved || locked.integrity !== manifest.lock.integrity || lock.packages?.['']?.dependencies?.[NAME] !== RESOLVED) throw fail('DSH lockfile does not match trusted release manifest', 'DSH_LOCK_MISMATCH');
  const vendor = path.join(path.dirname(lockfilePath), RESOLVED.slice(5));
  regular(path.dirname(vendor), true); regular(vendor);
  if (fs.realpathSync(vendor) !== vendor) throw fail('DSH vendor path has symlink ancestors');
  const vendorBytes = fs.readFileSync(vendor);
  if (digest(vendorBytes) !== manifest.vendorSha256 || 'sha512-' + digest(vendorBytes, 'sha512', 'base64') !== locked.integrity) throw fail('DSH vendor artifact differs from trusted release', 'DSH_VENDOR_MISMATCH');
  const installedFiles = [];
  function walk(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name), relative = prefix ? prefix + '/' + name : name;
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail('DSH package tree contains non-regular entries');
      regular(filename, stat.isDirectory());
      if (stat.isDirectory()) walk(filename, relative); else installedFiles.push(relative);
    }
  }
  walk(root);
  if (installedFiles.sort().join('\0') !== Object.keys(manifest.files).sort().join('\0')) throw fail('DSH installed file tree differs from trusted release', 'DSH_FILE_MISMATCH');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (digest(fs.readFileSync(path.join(root, relative))) !== hash) throw fail('Installed DSH file differs from trusted release', 'DSH_FILE_MISMATCH');
  }
  const installed = json(path.join(root, 'package.json'));
  if (installed.name !== NAME || installed.version !== VERSION || installed.bin?.dsh !== 'lib/bin.js') throw fail('Installed DSH package metadata differs from pinned release');
  return { entry, packageRoot: root, version: VERSION, integrityScope: Object.keys(manifest.files).sort(), vendorVerified: true, manifestSha256: digest(fs.readFileSync(manifestPath)), vendorSha256: digest(vendorBytes), lockfileSha256: digest(fs.readFileSync(lockfilePath)), packageFileCount: installedFiles.length };
}
module.exports = { resolveDshInstallation };

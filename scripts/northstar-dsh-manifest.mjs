/** Offline release evidence only. Does not execute DSH, read .env, or install files.
 * A generated manifest becomes a trust anchor only after independent review and
 * release publication. This covers the CLI package, not its dependency graph.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@deepseek-ai/dsh';
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'DSH_MANIFEST_INVALID' }); };
const safeRelative = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !path.posix.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
const field = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
const descriptor = (name, bytes) => ({ path: name, size: bytes.length, sha256: digest(bytes) });
const sorted = files => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function regularBytes(filename) {
  if (/^\.env(?:\.|$)/.test(path.basename(filename))) fail('Environment files are outside manifest scope');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Expected a regular file: ' + filename);
  return fs.readFileSync(filename);
}
function directory(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Expected a real directory: ' + filename);
}
function installedFiles(base, relative = '') {
  directory(path.join(base, relative));
  const files = [];
  for (const name of fs.readdirSync(path.join(base, relative))) {
    const rel = relative ? relative + '/' + name : name;
    if (!safeRelative(rel)) fail('Unsafe package path');
    if (rel.split('/').some(part => ['node_modules', '.cache'].includes(part))) fail('Unexpected dependency/dynamic directory in package: ' + rel);
    const filename = path.join(base, rel), stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) fail('Package symlinks are not allowed: ' + rel);
    if (stat.isDirectory()) files.push(...installedFiles(base, rel));
    else files.push(descriptor(rel, regularBytes(filename)));
  }
  return sorted(files);
}

// Deliberately narrow npm tar profile: POSIX regular files/directories only.
// No extraction, subprocesses, links, PAX/GNU extensions or path traversal.
function archiveFiles(compressed) {
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = [], seen = new Set(); let ended = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; if (!tar.subarray(offset).every(byte => byte === 0)) fail('Unexpected data after tar terminator'); break; }
    const checksumText = field(header.subarray(148, 156)).trim();
    if (!/^[0-7]+$/.test(checksumText)) fail('Invalid tar checksum field');
    const storedChecksum = parseInt(checksumText, 8);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== storedChecksum) fail('Invalid tar checksum');
    const prefix = field(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + field(header.subarray(0, 100));
    const type = header[156];
    const sizeText = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail('Invalid tar size');
    const size = parseInt(sizeText, 8), start = offset + 512, next = start + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || next > tar.length) fail('Truncated tar member');
    const clean = type === 53 ? name.replace(/\/$/, '') : name;
    if (clean === 'package' && type === 53 && size === 0) { offset = next; continue; }
    if (!clean.startsWith('package/') || !safeRelative(clean)) fail('Unsafe tar member: ' + name);
    const rel = clean.slice(8);
    if (seen.has(rel)) fail('Duplicate tar member: ' + rel); seen.add(rel);
    if (type !== 0 && type !== 48 && type !== 53) fail('Unsupported tar member type');
    if (type === 53 && size !== 0) fail('Invalid tar directory');
    if (type !== 53) files.push(descriptor(rel, tar.subarray(start, start + size)));
    offset = next;
  }
  if (!ended || !files.length) fail('Incomplete or empty tar archive');
  return sorted(files);
}

export function buildDshManifest({ root = DEFAULT_ROOT, entry } = {}) {
  root = fs.realpathSync(root);
  const shell = path.join(root, 'shell');
  directory(shell);
  directory(path.join(shell, 'vendor'));
  const packageBytes = regularBytes(path.join(shell, 'package.json'));
  const lockBytes = regularBytes(path.join(shell, 'package-lock.json'));
  const shellPackage = JSON.parse(packageBytes), lock = JSON.parse(lockBytes);
  const locked = lock.packages?.['node_modules/' + PACKAGE], spec = shellPackage.dependencies?.[PACKAGE];
  if (typeof spec !== 'string' || !/^file:vendor\/[A-Za-z0-9._-]+\.tgz$/.test(spec) || locked?.resolved !== spec || lock.packages?.['']?.dependencies?.[PACKAGE] !== spec) fail('Vendor spec and lock disagree');
  const vendorRelative = spec.slice(5), vendorBytes = regularBytes(path.join(shell, vendorRelative));
  const integrity = 'sha512-' + crypto.createHash('sha512').update(vendorBytes).digest('base64');
  if (locked.integrity !== integrity) fail('Vendor integrity does not match lock');
  const packageRoot = path.join(shell, 'node_modules', '@deepseek-ai', 'dsh');
  directory(path.join(shell, 'node_modules'));
  directory(path.join(shell, 'node_modules', '@deepseek-ai'));
  directory(packageRoot);
  const metadata = JSON.parse(regularBytes(path.join(packageRoot, 'package.json')));
  if (metadata.name !== PACKAGE || typeof metadata.version !== 'string' || metadata.version !== locked.version) fail('Installed package identity/version disagrees with lock');
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.dsh;
  if (!safeRelative(bin)) fail('Invalid declared DSH entry');
  const expectedEntry = path.join(packageRoot, bin);
  regularBytes(expectedEntry);
  // The runtime caller must pass its selected entry; unrelated global/override
  // installations cannot be certified by this repository-local release manifest.
  const selectedEntry = entry ? path.resolve(entry) : expectedEntry;
  regularBytes(selectedEntry);
  if (fs.realpathSync(selectedEntry) !== fs.realpathSync(expectedEntry)) fail('Selected DSH entry differs from the release package');
  const files = installedFiles(packageRoot), archived = archiveFiles(vendorBytes);
  if (!same(files, archived)) fail('Installed DSH package files differ from vendor archive');
  return {
    schemaVersion: 1, packageName: PACKAGE, version: metadata.version, entry: bin,
    files: Object.fromEntries(files.map(file => [file.path, file.sha256])),
    lock: { resolved: spec, integrity },
    vendorSha256: digest(vendorBytes), lockfileSha256: digest(lockBytes),
  };
}

export function checkDshManifest(manifest, options = {}) {
  const actual = buildDshManifest(options);
  if (!same(manifest, actual)) fail('Release manifest does not match current package/vendor/lock');
  return { ok: true, scope: 'repository-local-dsh-cli-package', version: actual.version, fileCount: Object.keys(actual.files).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    if (!['generate', 'check'].includes(command)) fail('Use generate [--out file] or check --manifest file; optional --root dir --entry file');
    for (let i = 0; i < args.length; i += 2) {
      if (!['--root', '--entry', '--out', '--manifest'].includes(args[i]) || !args[i + 1]) fail('Invalid command arguments');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.entry && process.env.DSH_JS) options.entry = process.env.DSH_JS;
    if (command === 'generate') {
      const result = JSON.stringify(buildDshManifest(options), null, 2) + '\n';
      if (options.out) fs.writeFileSync(options.out, result, { flag: 'wx' });
      else process.stdout.write(result);
    } else {
      if (!options.manifest) fail('check requires --manifest');
      const manifest = JSON.parse(regularBytes(options.manifest));
      process.stdout.write(JSON.stringify(checkDshManifest(manifest, options)) + '\n');
    }
  } catch (error) { process.stderr.write((error.code || 'DSH_MANIFEST_INVALID') + ': ' + error.message + '\n'); process.exitCode = 1; }
}

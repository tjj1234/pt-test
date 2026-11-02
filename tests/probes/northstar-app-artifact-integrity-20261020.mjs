/**
 * Offline integrity probe for selected Northstar first-party source roots.
 * It checks allowlisted files in those roots and HTML /assets/ references;
 * it does not establish full source/runtime/dependency closure or boot the app.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync('/private/tmp/northstar-app-artifact-integrity-');
const stage = path.join(temp, 'artifact');
const roots = ['shell', 'business/media', 'business/attribution', 'analytics/backend', 'analytics/lib', 'analytics/schema'];
const mutableDirs = new Set([
  'shell/node_modules',
  'shell/runtime/dsh-home',
  'shell/runtime/workspace',
  'shell/runtime/workspaces',
  'shell/runtime/_tmp',
  'shell/runtime/_uploads',
  'shell/runtime/logs',
]);
const ignoredNames = new Set(['node_modules', '.git', '.cache', 'coverage']);
const allowedExtensions = new Set([
  '.cjs', '.mjs', '.js', '.json', '.yaml', '.yml', '.sql', '.html', '.css',
  '.svg', '.md', '.txt', '.tgz', '.patch',
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const copied = [];

function shouldCopy(relative, name) {
  if (name === '.npmrc' || name === '.gitignore') return true;
  if (/^\.env(?:\.|$)/i.test(name) || name === '.DS_Store') return false;
  if (relative.startsWith('business/attribution/docs/') ||
      relative.startsWith('business/attribution/tests/') ||
      relative.endsWith('.test.js') || relative.endsWith('.spec.js')) return false;
  return allowedExtensions.has(path.extname(name).toLowerCase());
}

function copyTree(relativeRoot) {
  const sourceRoot = path.join(repo, relativeRoot);
  const targetRoot = path.join(stage, relativeRoot);
  assert.ok(fs.lstatSync(sourceRoot).isDirectory(), `source root must be a directory: ${relativeRoot}`);

  function walk(sourceDir, targetDir, relativeDir) {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const source = path.join(sourceDir, entry.name);
      const relative = path.posix.join(relativeDir, entry.name);
      const target = path.join(targetDir, entry.name);
      if (ignoredNames.has(entry.name) || mutableDirs.has(relative)) continue;
      const stat = fs.lstatSync(source);
      assert.ok(!stat.isSymbolicLink(), `symlink is outside artifact scope: ${relative}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        walk(source, target, relative);
      } else if (stat.isFile() && shouldCopy(relative, entry.name)) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        copied.push(relative);
      }
    }
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  walk(sourceRoot, targetRoot, relativeRoot);
}

function htmlAssetReferences() {
  const publicDir = path.join(stage, 'shell/public');
  const refs = [];
  for (const name of fs.readdirSync(publicDir).sort()) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    for (const match of html.matchAll(/(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
      const value = match[2].trim();
      if (!value.startsWith('/assets/')) continue;
      const pathname = value.slice('/assets/'.length).split(/[?#]/, 1)[0];
      const segments = pathname.split('/');
      assert.ok(pathname && segments.every(part => part && part !== '.' && part !== '..'), `unsafe asset reference in ${name}: ${value}`);
      const asset = path.resolve(publicDir, ...segments);
      assert.ok(asset.startsWith(publicDir + path.sep), `asset escapes public root in ${name}: ${value}`);
      assert.ok(fs.lstatSync(asset).isFile(), `missing staged asset for ${name}: ${value}`);
      refs.push({ html: `shell/public/${name}`, href: value, artifact: `shell/public/${segments.join('/')}` });
    }
  }
  return refs;
}

try {
  for (const root of roots) copyTree(root);
  const sortedPaths = [...copied].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(new Set(sortedPaths).size, sortedPaths.length, 'artifact paths must be unique');
  const manifest = sortedPaths.map(relative => ({ path: relative, sha256: sha256(fs.readFileSync(path.join(stage, relative))) }));
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(temp, 'artifact-manifest.json'), manifestBytes, { flag: 'wx' });

  const references = htmlAssetReferences();
  for (const required of [
    'shell/server.cjs', 'shell/package.json', 'shell/package-lock.json',
    'shell/db-migrations/001_auth.sql', 'shell/runtime/dsh-adapter.cjs',
    'shell/public/index.html', 'business/media/index.js', 'business/attribution/index.js',
    'analytics/backend/ads/ingest.js', 'analytics/lib/db.cjs',
  ]) assert.ok(sortedPaths.includes(required), `required release input is missing: ${required}`);
  for (const excluded of [
    'shell/node_modules', 'shell/runtime/dsh-home', 'shell/runtime/workspace',
    'shell/runtime/_tmp', 'shell/runtime/_uploads',
  ]) assert.ok(!sortedPaths.some(relative => relative === excluded || relative.startsWith(excluded + '/')),
    `mutable or installed state entered artifact: ${excluded}`);

  const keyPaths = [
    'shell/server.cjs', 'shell/package.json', 'shell/package-lock.json',
    'shell/db-migrations/001_auth.sql', 'shell/runtime/dsh-adapter.cjs',
    'shell/public/index.html', 'business/media/index.js', 'business/attribution/index.js',
    'analytics/backend/ads/ingest.js', 'analytics/lib/db.cjs',
  ];
  console.log(JSON.stringify({
    result: 'PASS',
    scope: 'allowlisted files in checked first-party source roots with SHA-256 integrity; HTML /assets/ references; not full source/runtime/dependency closure',
    roots,
    fileCount: manifest.length,
    manifestSha256: sha256(manifestBytes),
    assetReferenceCount: references.length,
    keyHashes: manifest.filter(item => keyPaths.includes(item.path)),
    limitations: ['Only listed source roots and allowed extensions are checked; no full source/runtime/dependency closure verification', 'No dependency install, HTTP server startup or same-origin/API acceptance', 'No production deployment or upgrade validation'],
  }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`CLEANUP ${fs.existsSync(temp) ? 'FAIL' : 'PASS'} removed owned staging directory under /private/tmp`);
}

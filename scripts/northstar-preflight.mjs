/** Read-only, offline deployment evidence. Never loads application modules or .env. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const version = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v) ? v : null;
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const staticSource = p => { try { return fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, '').replace(/'/g, '"'); } catch { return ''; } };
const present = v => typeof v === 'string' && v.trim().length > 0;
const RUN_PERSISTENT_FILES = [
  'budget.cjs', 'cordis.patch.yml', 'ga-query-executor.cjs', 'northstar-patch-watch-compat.mjs',
  'northstar-profile-dependencies.json', 'package.json', 'persistent-runner.mjs', 'pnpm-workspace.yaml', 'run-budget.json', 'run-budget-csv.json', 'run-budget-media.json',
  'powertokens.cjs', 'presets.cjs', 'usage.cjs',
].sort();
function verifyRunPersistentSnapshot(root) {
  const dir = path.join(root, 'docs/dsh-profile-snapshot/run-persistent');
  const directoryContained = () => {
    try {
      const rootPath=path.resolve(root), rootStat=fs.lstatSync(rootPath), rootReal=fs.realpathSync(rootPath);
      if(!rootStat.isDirectory()||rootStat.isSymbolicLink())return false;
      const rel=path.relative(rootPath,dir);
      if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))return false;
      let current=rootPath;
      for(const component of rel.split(path.sep)){
        current=path.join(current,component);
        const stat=fs.lstatSync(current);
        if(!stat.isDirectory()||stat.isSymbolicLink())return false;
        const real=fs.realpathSync(current), fromRoot=path.relative(rootReal,real);
        if(fromRoot==='..'||fromRoot.startsWith(`..${path.sep}`)||path.isAbsolute(fromRoot))return false;
      }
      return true;
    } catch { return false; }
  };
  if(!directoryContained())return false;
  const readFile = p => {
    try { const s=fs.lstatSync(p); return s.isFile()&&!s.isSymbolicLink()?fs.readFileSync(p):null; } catch { return null; }
  };
  try {
    const manifestBytes=readFile(path.join(dir,'northstar-profile-manifest.json'));
    const manifest=manifestBytes&&JSON.parse(manifestBytes.toString('utf8'));
    if(manifest?.formatVersion!==1||manifest?.rpcProtocolVersion!==1||!manifest.files||Array.isArray(manifest.files))return false;
    const names=Object.keys(manifest.files).sort();
    if(names.join('\0')!==RUN_PERSISTENT_FILES.join('\0'))return false;
    const actualNames=fs.readdirSync(dir).filter(n=>n!=='README.md'&&n!=='northstar-profile-manifest.json').sort();
    if([...actualNames,'northstar-profile-manifest.json'].sort().join('\0')!==[...RUN_PERSISTENT_FILES,'northstar-profile-manifest.json'].sort().join('\0'))return false;
    for(const [name,hash] of Object.entries(manifest.files)){
      if(!/^[a-f0-9]{64}$/.test(hash))return false;
      const bytes=readFile(path.join(dir,name));
      if(!bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==hash)return false;
    }
    const pkg=JSON.parse(readFile(path.join(dir,'package.json')).toString('utf8'));
    const dependencies=JSON.parse(readFile(path.join(dir,'northstar-profile-dependencies.json')).toString('utf8'));
    if(pkg.name!=='dsh-profile-run-persistent'||!Array.isArray(pkg.dsh?.profile?.bundles)||
       dependencies.schemaVersion!==1||!dependencies.bundles||Array.isArray(dependencies.bundles))return false;
    const bundleNames=Object.keys(dependencies.bundles).sort();
    if(bundleNames.join('\0')!==[...pkg.dsh.profile.bundles].sort().join('\0')||
       bundleNames.join('\0')!==Object.keys(pkg.dependencies||{}).sort().join('\0'))return false;
    const lockBytes=readFile(path.join(root,'shell/package-lock.json'));
    const npmrcBytes=readFile(path.join(root,'shell/.npmrc'));
    if(!lockBytes||!npmrcBytes||dependencies.shellLockfileSha256!==crypto.createHash('sha256').update(lockBytes).digest('hex')||
       dependencies.shellNpmrcSha256!==crypto.createHash('sha256').update(npmrcBytes).digest('hex'))return false;
    const currentLock=JSON.parse(lockBytes.toString('utf8'));
    for(const name of bundleNames){
      const dep=dependencies.bundles[name];
      const locked=currentLock.packages?.[`node_modules/${name}`];
      if(!dep||!locked||dep.version!==locked.version||dep.resolved!==locked.resolved||dep.integrity!==locked.integrity||
         pkg.dependencies[name]!==dep.version)return false;
    }
    return true;
  } catch { return false; }
}

function migrations(dir) {
  try {
    return new Map(fs.readdirSync(dir).filter(n => /^\d+_[a-zA-Z0-9_]+\.sql$/.test(n))
      .map(n => [n, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,n))).digest('hex')]));
  } catch { return null; }
}

export function inspectPreflight({ root = DEFAULT_ROOT, env = process.env } = {}) {
  const pkg = readJson(path.join(root,'shell/package.json'));
  const lock = readJson(path.join(root,'shell/package-lock.json'));
  const locked = lock?.packages?.['node_modules/@deepseek-ai/dsh'];
  const spec = pkg?.dependencies?.['@deepseek-ai/dsh'];
  const vendorRelative = typeof spec === 'string' && /^file:vendor\/[a-zA-Z0-9._-]+\.tgz$/.test(spec) ? spec.slice(5) : null;
  const vendor = vendorRelative && path.join(root,'shell',vendorRelative);
  let integrityMatches = false;
  if (vendor && exists(vendor) && /^sha512-[A-Za-z0-9+/=]+$/.test(locked?.integrity || '')) {
    integrityMatches = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(vendor)).digest('base64') === locked.integrity;
  }
  // Match the explicit override or repository-local install only. Do not traverse global homes.
  const entry = present(env.DSH_JS) ? path.resolve(root,env.DSH_JS) : path.join(root,'shell/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const installed = readJson(path.join(path.dirname(path.dirname(entry)),'package.json'));
  const installedVersion = installed?.name === '@deepseek-ai/dsh' ? version(installed.version) : null;
  const a = migrations(path.join(root,'shell/db-migrations'));
  const b = migrations(path.join(root,'shell/storage/migrations'));
  const sourcesAgree = !!a && !!b && a.size === b.size && [...a].every(([n,h]) => b.get(n) === h);
  const authSource = staticSource(path.join(root,'shell/auth.cjs'));
  const googleAuthSource = staticSource(path.join(root,'shell/auth-google.cjs'));
  const googleRoutesSource = staticSource(path.join(root,'shell/auth-google-routes.cjs'));
  const googleServerSource = staticSource(path.join(root,'shell/server.cjs'));
  const googleContractPresent = ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI'].every(k => googleAuthSource.includes(k)) &&
    googleRoutesSource.includes('/api/auth/google/start') && googleRoutesSource.includes('/api/auth/google/callback');
  const googleIntegrationEvidencePresent = exists(path.join(root,'shell/public/google-login.js')) &&
    exists(path.join(root,'tests/regression/google-login-server-test.mjs')) && googleServerSource.includes('createGoogleAuthRoutes');
  const storageSource = staticSource(path.join(root,'shell/storage/index.cjs'));
  const migrationDefaultMetadataAligned = !!a?.size &&
    authSource.includes('constmigrationsDir=opts.migrationsDir||path.join(__dirname,"db-migrations");') &&
    storageSource.includes('constDEFAULT_MIGRATIONS_DIR=path.join(__dirname,"..","db-migrations");') &&
    storageSource.includes('constmigrationsDir=opts.migrationsDir||DEFAULT_MIGRATIONS_DIR;') &&
    storageSource.includes('migrationsDir,');
  const checks = {
    mockDisabled: env.PT_MOCK_DSH !== '1' && env.PT_CHAT_DRYRUN !== '1',
    vendorPresent: !!vendor && exists(vendor),
    vendorIntegrityMatches: integrityMatches,
    vendorLockMatchesManifest: !!vendorRelative && locked?.resolved === spec,
    installedEntryPresent: exists(entry),
    installedVersionMatchesLock: !!installedVersion && installedVersion === version(locked?.version),
    migrationDefaultMetadataAligned,
    runPersistentSourceSnapshotComplete: verifyRunPersistentSnapshot(root),
  };
  return {
    schemaVersion: 2, scope: 'offline-static-only',
    versions: { node: version(process.versions.node), dshLocked: version(locked?.version), dshInstalled: installedVersion },
    configuration: {
      explicitDshEntryPresent: present(env.DSH_JS),
      postgresConfigured: ['PT_PG_DSN','PT_PG_HOST','PT_PG_DATABASE','PT_PG_DB','PT_PG_USER','PT_PG_USERNAME'].some(k=>present(env[k])),
      googleConfigurationContractPresent: googleContractPresent,
      googleLoginIntegrationEvidencePresent: googleIntegrationEvidencePresent,
      googleExternalOAuthVerified: false,
      secureCookieEnabled: env.PT_COOKIE_SECURE === '1',
    }, checks,
    observations: { legacyMigrationSnapshotMatches: sourcesAgree },
    ready: Object.values(checks).every(Boolean),
    limitations: ['No DB, network, service, credential validity or runtime execution checked.',
      'Only explicit or repository-local DSH entry inspected; global discovery not performed.',
      'Google source and local integration evidence are inspected statically; no Google service, credential or callback registration is checked.',
      'Migration checks inspect expected literal defaults only, not executed control flow or database state.',
      'Legacy migration directory is a retained snapshot; differing content is informational.',
      'run-persistent snapshot is source-generated candidate metadata; it does not prove deployed configuration or loaded bundles match.'],
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectPreflight();
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({schemaVersion:2,ready:false,error:'PREFLIGHT_READ_FAILED'})+'\n');
    process.exitCode = 1;
  }
}

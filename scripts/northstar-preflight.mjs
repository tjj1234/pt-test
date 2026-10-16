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
  const profile = path.join(root,'docs/dsh-profile-snapshot');
  const profilePkg = readJson(path.join(profile,'package.json'));
  const profileName = profilePkg?.dsh?.profile?.name;
  const checks = {
    mockDisabled: env.PT_MOCK_DSH !== '1' && env.PT_CHAT_DRYRUN !== '1',
    vendorPresent: !!vendor && exists(vendor),
    vendorIntegrityMatches: integrityMatches,
    vendorLockMatchesManifest: !!vendorRelative && locked?.resolved === spec,
    installedEntryPresent: exists(entry),
    installedVersionMatchesLock: !!installedVersion && installedVersion === version(locked?.version),
    migrationDefaultMetadataAligned,
    productionProfileSnapshotMetadataPresent: profileName === 'run-persistent' && exists(path.join(profile,'cordis.patch.yml')),
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
      'Profile snapshot presence cannot prove deployed configuration matches.'],
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

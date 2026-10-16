import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectPreflight } from '../../scripts/northstar-preflight.mjs';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-preflight-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(n,v)=>{const p=path.join(root,n);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='object'?JSON.stringify(v):v);};
 const bytes='fixture archive, not an executable';
 const spec='file:vendor/dsh.tgz';
 write('shell/vendor/dsh.tgz',bytes);
 write('shell/package.json',{dependencies:{'@deepseek-ai/dsh':spec}});
 write('shell/package-lock.json',{packages:{'node_modules/@deepseek-ai/dsh':{version:'0.1.1-rc.2',resolved:spec,integrity:'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')}}});
 write('shell/node_modules/@deepseek-ai/dsh/package.json',{name:'@deepseek-ai/dsh',version:'0.1.1-rc.2'});
 write('shell/node_modules/@deepseek-ai/dsh/lib/bin.js','');
 for(const d of ['db-migrations','storage/migrations'])write(`shell/${d}/001_init.sql`,'select 1;');
 write('shell/auth.cjs','const migrationsDir = opts.migrationsDir || path.join(__dirname, "db-migrations");');
 write('shell/auth-google.cjs','GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI');
 write('shell/auth-google-routes.cjs','/api/auth/google/start /api/auth/google/callback');
 write('shell/server.cjs','createGoogleAuthRoutes');
 write('shell/public/google-login.js','');
 write('tests/regression/google-login-server-test.mjs','');
 write('shell/storage/index.cjs','const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "db-migrations"); const migrationsDir = opts.migrationsDir || DEFAULT_MIGRATIONS_DIR; initAuth({ migrationsDir, });');
 write('docs/dsh-profile-snapshot/package.json',{dsh:{profile:{name:'run-persistent'}}});
 write('docs/dsh-profile-snapshot/cordis.patch.yml','[]');
 return {root,write};
}
test('known offline checks pass without loading services',t=>{
 const {root}=fixture(t); const r=inspectPreflight({root,env:{}});
 assert.equal(r.ready,true); assert.equal(r.scope,'offline-static-only'); assert.equal(r.schemaVersion,2);
 assert.equal(r.configuration.googleConfigurationContractPresent,true); assert.equal(r.configuration.googleLoginIntegrationEvidencePresent,true); assert.equal(r.configuration.googleExternalOAuthVerified,false);
});
test('tampering and mock flags fail closed while snapshot mismatch is informational',t=>{
 const {root,write}=fixture(t);write('shell/vendor/dsh.tgz','tampered');write('shell/storage/migrations/001_init.sql','select 2;');
 const r=inspectPreflight({root,env:{PT_MOCK_DSH:'1'}});
 assert.equal(r.ready,false);assert.equal(r.checks.vendorIntegrityMatches,false);assert.equal(r.checks.mockDisabled,false);assert.equal(r.observations.legacyMigrationSnapshotMatches,false);
});
test('explicit entry version mismatch and web snapshot are detected',t=>{
 const {root,write}=fixture(t);write('custom/package.json',{name:'@deepseek-ai/dsh',version:'9.0.0'});write('custom/lib/bin.js','');
 write('docs/dsh-profile-snapshot/package.json',{dsh:{profile:{name:'web'}}});
 const r=inspectPreflight({root,env:{DSH_JS:'custom/lib/bin.js'}});
 assert.equal(r.versions.dshInstalled,'9.0.0');assert.equal(r.checks.installedVersionMatchesLock,false);assert.equal(r.checks.productionProfileSnapshotMetadataPresent,false);
});
test('secrets, paths and malicious version strings never enter output',t=>{
 const {root,write}=fixture(t);const secret='SENSITIVE-'+Math.random();write('shell/node_modules/@deepseek-ai/dsh/package.json',{name:'@deepseek-ai/dsh',version:secret});
 const r=inspectPreflight({root,env:{GOOGLE_CLIENT_ID:secret,GOOGLE_CLIENT_SECRET:secret,GOOGLE_REDIRECT_URI:secret,PT_PG_DSN:secret,POWERTOKENS_API_KEY:secret}});
 const out=JSON.stringify(r);assert.equal(out.includes(secret),false);assert.equal(out.includes(root),false);assert.equal(r.configuration.googleConfigurationContractPresent,true);assert.equal(r.configuration.googleExternalOAuthVerified,false);assert.equal(r.versions.dshInstalled,null);
});
test('missing fixtures produce bounded failure without exposing read errors',t=>{
 const {root}=fixture(t);const r=inspectPreflight({root:path.join(root,'missing'),env:{}});
 assert.equal(r.ready,false);assert.equal(r.checks.vendorPresent,false);assert.equal(r.checks.migrationDefaultMetadataAligned,false);
});

test('legacy snapshot divergence does not block unified default metadata',t=>{
 const {root,write}=fixture(t);write('shell/storage/migrations/001_init.sql','historical snapshot');
 const r=inspectPreflight({root,env:{}});assert.equal(r.ready,true);assert.equal(r.observations.legacyMigrationSnapshotMatches,false);assert.equal(r.checks.migrationDefaultMetadataAligned,true);
});
test('default entry drift is blocked even when migration directory copies match',t=>{
 const {root,write}=fixture(t);write('shell/storage/index.cjs','const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");');
 const r=inspectPreflight({root,env:{}});assert.equal(r.observations.legacyMigrationSnapshotMatches,true);assert.equal(r.checks.migrationDefaultMetadataAligned,false);assert.equal(r.ready,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const dbmod=require('../../shell/db.cjs');
const pg=require('../../shell/db-pg.cjs');

test('all supported PG selectors are explicit and whitespace alone does not select a backend',()=>{
 for(const key of ['PT_PG_DSN','PT_PG_HOST','PT_PG_DATABASE','PT_PG_DB','PT_PG_USER','PT_PG_USERNAME']) {
  assert.equal(dbmod.pgConfigured({[key]:'configured'}),true);
  assert.equal(pg.pgConfigured({[key]:'configured'}),true);
  assert.equal(dbmod.pgConfigured({[key]:'  '}),false);
 }
 assert.equal(dbmod.pgConfigured({}),false);
});
test('configured PG with a missing adapter fails before creating a fallback database',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-db-missing-'));
 try {
  fs.copyFileSync(new URL('../../shell/db.cjs',import.meta.url),path.join(dir,'db.cjs'));
  const probe=spawnSync(process.execPath,['-e',`require('./db.cjs').open({dataDir:'./must-not-exist'}).then(()=>process.exit(7)).catch(e=>{console.log(e.code);process.exit(e.code==='PG_ADAPTER_UNAVAILABLE'?0:8)})`],{cwd:dir,env:{PATH:process.env.PATH,PT_PG_HOST:'configured'},encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  assert.match(probe.stdout,/PG_ADAPTER_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(dir,'must-not-exist')),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('migration SQL and applied marker roll back atomically and repaired file can retry',async()=>{
 const {PGlite}=require('../../shell/node_modules/@electric-sql/pglite');
 const db=new PGlite();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-migration-'));
 try {
  const file=path.join(dir,'001_atomic.sql');
  fs.writeFileSync(file,'CREATE TABLE atomic_probe (id integer); INSERT INTO absent_probe VALUES (1);');
  await assert.rejects(dbmod.migrate(db,dir));
  assert.equal((await db.query("SELECT to_regclass('atomic_probe') AS t")).rows[0].t,null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,0);
  fs.writeFileSync(file,'CREATE TABLE atomic_probe (id integer); INSERT INTO atomic_probe VALUES (42);');
  await dbmod.migrate(db,dir);await dbmod.migrate(db,dir);
  assert.deepEqual((await db.query('SELECT id FROM atomic_probe')).rows,[{id:42}]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,1);
 } finally {await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

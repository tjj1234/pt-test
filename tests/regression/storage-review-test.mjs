import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const dbmod=require('../../shell/db.cjs');
const root=fileURLToPath(new URL('../..',import.meta.url));
const synthetic='SYNTHETIC_REVIEW_CREDENTIAL';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'storage-independent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function child(dir,mode){
 const driver=path.join(dir,'fake-pg.cjs');
 fs.writeFileSync(driver,`exports.Pool=class {on(name,cb){this.error=cb;} async query(){if(process.env.REVIEW_MODE==='idle'){this.error(new Error('${synthetic}'));return {rows:[]};}throw new Error('${synthetic}');}async end(){if(process.env.REVIEW_MODE==='cleanup')throw new Error('${synthetic}');}};`);
 const body=`const fs=require('fs'); const d=require(${JSON.stringify(path.join(root,'shell/db.cjs'))});d.open({dataDir:${JSON.stringify(path.join(dir,'must-not-create'))}}).then(async x=>{await x.close();console.log(JSON.stringify({ok:true}));}).catch(e=>console.log(JSON.stringify({ok:false,code:e.code,message:e.message})));`;
 return spawnSync(process.execPath,['-e',body],{env:{PATH:process.env.PATH,PT_PG_HOST:'isolated-fake',PT_PG_LIB:driver,REVIEW_MODE:mode},encoding:'utf8'});
}
test('independent: applied-marker failure rolls back DDL and data, repaired marker can retry',async t=>{
 const dir=fixture(t);const {PGlite}=require('../../shell/node_modules/@electric-sql/pglite');const db=new PGlite();t.after(()=>db.close());
 await db.exec("CREATE TABLE schema_migrations(id SERIAL PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),CONSTRAINT reject_marker CHECK(name <> '001_marker.sql')); CREATE TABLE retained(id integer); INSERT INTO retained VALUES(7);");
 fs.writeFileSync(path.join(dir,'001_marker.sql'),'CREATE TABLE marker_probe(id integer); INSERT INTO retained VALUES(8);');
 await assert.rejects(dbmod.migrate(db,dir));
 assert.equal((await db.query("SELECT to_regclass('marker_probe') AS t")).rows[0].t,null);
 assert.deepEqual((await db.query('SELECT id FROM retained')).rows,[{id:7}]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,0);
 await db.exec('ALTER TABLE schema_migrations DROP CONSTRAINT reject_marker');
 await dbmod.migrate(db,dir);await dbmod.migrate(db,dir);
 assert.deepEqual((await db.query('SELECT id FROM retained ORDER BY id')).rows,[{id:7},{id:8}]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,1);
});
test('independent: explicit PG open failure never creates fallback or leaks driver error',t=>{
 const dir=fixture(t);const p=child(dir,'open');assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout.trim());assert.equal(result.code,'PG_CONNECTION_FAILED');
 assert.equal((p.stdout+p.stderr).includes(synthetic),false);assert.equal(fs.existsSync(path.join(dir,'must-not-create')),false);
});
test('independent: PG cleanup failure must not replace sanitized connection error',t=>{
 const dir=fixture(t);const p=child(dir,'cleanup');assert.equal(p.status,0);
 assert.equal((p.stdout+p.stderr).includes(synthetic),false,'cleanup driver error escaped');
 assert.equal(JSON.parse(p.stdout.trim()).code,'PG_CONNECTION_FAILED');assert.equal(fs.existsSync(path.join(dir,'must-not-create')),false);
});
test('independent: idle pool errors must be logged without raw credential-bearing message',t=>{
 const dir=fixture(t);const p=child(dir,'idle');assert.equal(p.status,0);
 assert.equal((p.stdout+p.stderr).includes(synthetic),false,'raw idle error leaked');
});

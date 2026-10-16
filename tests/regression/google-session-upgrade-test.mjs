import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'shell/package.json'));
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync(path.join(root,'shell/db-migrations/012_google_identities.sql'),'utf8');

test('Google-only upgrade revokes password-only sessions while preserving users and bound sessions',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  await db.exec('CREATE TABLE users(id UUID PRIMARY KEY); CREATE TABLE sessions(user_id UUID NOT NULL REFERENCES users(id),token_hash TEXT PRIMARY KEY);');
  const [legacy,bound]=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  await db.query('INSERT INTO users(id) VALUES ($1),($2)',[legacy,bound]);
  await db.query('INSERT INTO sessions(user_id,token_hash) VALUES ($1,$2),($3,$4)',[legacy,'legacy-token-hash',bound,'bound-token-hash']);
  await db.exec(migration);
  assert.equal((await db.query('SELECT count(*)::int n FROM users')).rows[0].n,2,'the migration keeps user identities and assets');
  assert.equal((await db.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0,'unbound password sessions must sign out');
  await db.query("INSERT INTO google_identities(issuer,subject,user_id,email) VALUES ('https://accounts.google.com','subject-2',$1,'bound@example.com')",[bound]);
  await db.query('INSERT INTO sessions(user_id,token_hash) VALUES ($1,$2)',[bound,'new-google-session']);
  await db.exec(migration);
  assert.deepEqual((await db.query('SELECT token_hash FROM sessions')).rows,[{token_hash:'new-google-session'}]);
 }finally{await db.close();}
});

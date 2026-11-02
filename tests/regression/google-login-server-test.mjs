import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
async function freePort(){const s=createServer();await new Promise((resolve,reject)=>s.listen(0,'127.0.0.1',resolve).once('error',reject));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
test('real product server exposes only Google login and does not seed default credentials', {timeout:30000}, async (t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northstar-google-server-'));
 const port=await freePort(),shutdown='test-shutdown-'+Math.random().toString(36).slice(2);
 const env={PATH:process.env.PATH||'/usr/bin:/bin',HOME:dir,PT_DB_DIR:path.join(dir,'db'),PT_MASTER_KEY_FILE:path.join(dir,'master.key'),PT_LOG_DIR:path.join(dir,'logs'),PT_SHELL_PORT:String(port),PT_LISTEN_HOST:'127.0.0.1',PT_TEST_SHUTDOWN_TOKEN:shutdown,PT_DASH_PORT:'19095'};
 const child=spawn(process.execPath,['shell/server.cjs','--port',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);}fs.rmSync(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+port;let ready=false;
 for(let i=0;i<250;i++){if(child.exitCode!==null)break;try{const r=await fetch(origin+'/healthz');if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,80));}
 assert.equal(ready,true,'server failed to become ready: '+output.slice(-3000));
 const status=await fetch(origin+'/api/auth/google/status');assert.deepEqual(await status.json(),{ok:true,configured:false});
 const login=await fetch(origin+'/login');const html=await login.text();assert.equal(login.status,200);assert.match(html,/google-login\.js/);assert.doesNotMatch(html,/northstar|admin|forgot-password|reset-password|password/);
 for(const route of ['/api/login','/api/auth/login','/api/auth/register','/api/auth/forgot-password','/api/auth/reset-password','/api/auth/change-password']){
  const retired=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(retired.status,410,route);assert.equal((await retired.json()).code,'GOOGLE_LOGIN_REQUIRED',route);
 }
 const oldForgot=await fetch(origin+'/forgot',{redirect:'manual'});assert.equal(oldForgot.status,302);assert.equal(oldForgot.headers.get('location'),'/login');
 const settings=fs.readFileSync(path.join(root,'shell/public/settings.html'),'utf8');assert.doesNotMatch(settings,/修改登录密码|pwWrap|change-password/);
 const stop=await fetch(origin+'/__test_shutdown',{method:'POST',headers:{'x-shutdown-token':shutdown}});assert.equal(stop.status,200);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server did not shut down')),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
 const logText=fs.readdirSync(path.join(dir,'logs')).filter(name=>name.startsWith('app-')).map(name=>fs.readFileSync(path.join(dir,'logs',name),'utf8')).join('\n');
 assert.match(logText,/"event":"provider_reconciliation_started","status":"configured"/,'legacy scalar reconciliation worker starts');
 assert.match(logText,/"event":"external_operations_worker_started","status":"configured"/,'multi-operation reconciliation worker starts');
 assert.match(logText,/"event":"shutdown_complete"/,'shutdown completes after both workers drain');
 const dbmod=require('../../shell/db.cjs');const reopened=await dbmod.open({dataDir:path.join(dir,'db')});
 try{assert.equal((await reopened.db.query('SELECT count(*)::int AS count FROM users')).rows[0].count,0,'Google-only startup must not seed a local password user');}
 finally{await reopened.close();}
});

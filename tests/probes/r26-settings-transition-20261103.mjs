import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve('.'),old=path.join(root,'release-artifacts/.validation-r14-rollback'),{makeProfile}=require(path.join(old,'shell/runtime/dsh-adapter.cjs')),{run}=require('../../scripts/northstar-r26-settings-transition.cjs');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r26-transition-'));
try{
 const home=path.join(temp,'home'),oldTemplate=path.join(old,'shell/dsh-settings.yaml');makeProfile(home,oldTemplate,path.join(old,'shell/persistent-runner.mjs'));
 const args={home,oldTemplate,newRelease:root},settings=path.join(home,'settings.yaml'),before=fs.readFileSync(settings);
 assert.equal(run(args).status,'READY_FOR_REVIEW');assert.deepEqual(fs.readFileSync(settings),before);
 assert.throws(()=>run({...args,apply:true,offlineAndBackupConfirmed:true,isServiceStopped:()=>false}),{code:'TRANSITION_OFFLINE_BACKUP_REQUIRED'});assert.deepEqual(fs.readFileSync(settings),before);
 fs.appendFileSync(settings,'\n# operator change\n');assert.throws(()=>run(args),{code:'TRANSITION_SETTINGS_DRIFT'});fs.writeFileSync(settings,before);
 const result=run({...args,apply:true,offlineAndBackupConfirmed:true,isServiceStopped:()=>true});assert.equal(result.status,'TRANSITION_COMPLETE');assert.ok(result.transaction);assert.ok(result.profileBackup);
 assert.deepEqual(fs.readFileSync(path.join(home,result.transaction,'old-settings.yaml')),before);assert.ok(fs.existsSync(path.join(result.profileBackup,'northstar-profile-manifest.json')));
 assert.throws(()=>run(args),{code:'TRANSITION_SETTINGS_DRIFT'});console.log(JSON.stringify({status:'R26_SETTINGS_TRANSITION_LOCAL_PASS',checks:['exact reported baseline','read-only inspect','active service denied','operator drift denied','offline upgrade','preserved backups','repeat denied'],providerCalls:0}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}

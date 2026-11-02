// Exact frozen r14 lifecycle proof, no service/model/network activity.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const archive=path.resolve('release-artifacts/northstar-controlled-trial-20261030-candidate-34-r14.tar.gz');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),'f0001e9bef26293443561c0519948258687769b374a5231a06aadffd17a0b993');
const tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'r14-profile-upgrade-'));
try{
 execFileSync('tar',['-xzf',archive,'-C',tmp]);
 const require=createRequire(path.join(tmp,'shell/package.json'));const api=require('./runtime/dsh-adapter.cjs');
 const home=path.join(tmp,'home'),template=path.join(tmp,'shell/dsh-settings.yaml'),runner=path.join(tmp,'shell/persistent-runner.mjs');
 const profile=api.makeProfile(home,template,runner),manifestFile=path.join(profile.dir,'northstar-profile-manifest.json');
 const old=Buffer.from('self-consistent prior runner fixture');fs.writeFileSync(path.join(profile.dir,'persistent-runner.mjs'),old);
 const manifest=JSON.parse(fs.readFileSync(manifestFile));manifest.files['persistent-runner.mjs']=crypto.createHash('sha256').update(old).digest('hex');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 assert.throws(()=>api.makeProfile(home,template,runner),{code:'PROFILE_STALE'});
 const upgraded=api.rebuildProfile(home,template,runner);assert.ok(upgraded.backupDir);
 assert.deepEqual(fs.readFileSync(path.join(upgraded.backupDir,'persistent-runner.mjs')),old);
 assert.equal(api.makeProfile(home,template,runner).dir,profile.dir);
 console.log(JSON.stringify({result:'PASS',archive:'r14-exact-frozen',staleReproduced:true,backupRetained:true,rebuildVerified:true,paidPosts:0}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}

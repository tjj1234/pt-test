import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {profileFiles}=require('./runtime/dsh-adapter.cjs');
const {createSkillReleaseSnapshot}=require('./skills/release-snapshot.cjs');
test('published provider uses native registry and filesystem parser with exact Run scope, immutable hash and cancellation',{timeout:15000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skill-native-provider-'));let ctx,provider,active;
 try{
  for(const [name,bytes] of Object.entries(profileFiles(path.resolve('shell/persistent-runner.mjs'))))if(/\.(mjs|cjs)$/.test(name))fs.writeFileSync(path.join(dir,name),bytes);
  fs.symlinkSync(path.resolve('shell/node_modules'),path.join(dir,'node_modules'),'dir');
  const [{Context},{default:Skills},{installPublishedSkillProvider}]=await Promise.all([import(pathToFileURL(require.resolve('@deepseek-ai/cordis'))),import(pathToFileURL(require.resolve('@deepseek-ai/dsh-skill'))),import(pathToFileURL(path.join(dir,'published-skill-provider.mjs')))]);
  ctx=new Context();await ctx.plugin(Skills);
  const files=[{path:'SKILL.md',content:'---\nname: review-fixture\ndescription: Review owned fixture\n---\nPinned version one.'},{path:'references/rules.md',content:'Supporting version one.'}];
  const snapshot=createSkillReleaseSnapshot({skillId:'review-fixture',version:'1',files});
  const pin={releaseId:'11111111-1111-4111-8111-111111111111',skillId:'review-fixture',version:'1',contentHash:snapshot.contentHash};
  const agent={},foreign={};active={agent,runId:'run-one',pinnedSkills:{skills:[pin]}};let blocked=false,pending;
  provider=installPublishedSkillProvider(ctx,{getActiveTurn:scope=>scope===agent?active:null,readRelease:async()=>{if(pending)await pending;if(blocked)throw Error('disabled');return {...pin,files,description:'Review owned fixture',body:'Pinned version one.'};}});
  assert.deepEqual(await ctx.skills.list({scope:foreign}),[]);
  const list=await ctx.skills.list({scope:agent});assert.equal(list.length,1);assert.equal(list[0].name,'review-fixture');
  const loaded=await ctx.skills.get('review-fixture',{scope:agent});assert.equal(loaded.content,'Pinned version one.');assert.equal(loaded.resourceBase.kind,'opaque');assert.equal(loaded.path,undefined);
  const entry=active.skillEntries.get(pin.releaseId);fs.chmodSync(path.join(entry.dir,'SKILL.md'),0o600);fs.appendFileSync(path.join(entry.dir,'SKILL.md'),' tampered');provider.invalidate();
  assert.equal(await ctx.skills.get('review-fixture',{scope:agent}),undefined);
  await provider.disposeTurn(active);assert.equal(fs.existsSync(entry.dir),false);
  active={agent,runId:'run-two',pinnedSkills:{skills:[pin]}};blocked=true;provider.invalidate();assert.deepEqual(await ctx.skills.list({scope:agent}),[]);
  blocked=false;let release;pending=new Promise(resolve=>release=resolve);provider.invalidate();const operation=ctx.skills.list({scope:agent});await new Promise(resolve=>setImmediate(resolve));active.cancelRequested=true;release();assert.deepEqual(await operation,[]);assert.equal(active.skillEntries,undefined);
 }finally{if(active)await provider?.disposeTurn(active);fs.rmSync(dir,{recursive:true,force:true});}
});

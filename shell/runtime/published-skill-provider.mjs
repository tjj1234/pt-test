import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem';
const require=createRequire(import.meta.url),{createSkillReleaseSnapshot}=require('./skill-release-snapshot.cjs');
const fail=()=>Object.assign(Error('Published skill is unavailable or changed'),{code:'SKILL_SNAPSHOT_CHANGED'});
export function installPublishedSkillProvider(ctx,{getActiveTurn,readRelease}){
 const registry=ctx.get('skills');let invalidate=()=>{};
 if(!registry)return {invalidate,async disposeTurn(){}};
 const activeFor=options=>{const active=getActiveTurn(options?.scope);return active&&!active.cancelRequested&&!active.expired?active:null;};
 async function entry(active,id){
  const pin=active.pinnedSkills?.skills?.find(pin=>pin.releaseId===id);if(!pin)throw fail();
  const data=await readRelease(active,id);if(active.cancelRequested||active.expired||getActiveTurn(active.agent)!==active)throw fail();const snapshot=createSkillReleaseSnapshot({skillId:data.skillId,version:data.version,files:data.files});
  if(data.contentHash!==pin.contentHash||snapshot.contentHash!==pin.contentHash||data.skillId!==pin.skillId||data.version!==pin.version)throw fail();
  active.skillEntries ||= new Map();let result=active.skillEntries.get(id);
  if(!result){
   const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'northstar-skill-pin-')));fs.chmodSync(dir,0o700);
   try{for(const file of data.files){const target=path.join(dir,file.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,file.content,{flag:'wx',mode:0o400});}
   const controller=new AbortController();result={dir,controller,provider:new FileSystemSkillProvider(ctx,{signal:controller.signal,invalidate:()=>{}},{includeDefaultRoots:false,customSkillDirs:[],bundledSkillDir:dir,watch:false,providerName:'northstar-published'})};active.skillEntries.set(id,result);}catch(error){fs.rmSync(dir,{recursive:true,force:true});throw error;}
  }
  const current=[];for(const file of data.files){const target=path.join(result.dir,file.path),stat=fs.lstatSync(target);if(stat.isSymbolicLink()||!stat.isFile()||fs.realpathSync(target)!==target)throw fail();current.push({path:file.path,content:fs.readFileSync(target)});}
  if(createSkillReleaseSnapshot({skillId:pin.skillId,version:pin.version,files:current}).contentHash!==pin.contentHash)throw fail();
  return {...result,data};
 }
 registry.registerProvider(control=>{invalidate=control.invalidate;return {
  name:'northstar-published',
  async list(options){const active=activeFor(options);if(!active)return [];const out=[];for(const pin of active.pinnedSkills?.skills||[]){const value=await entry(active,pin.releaseId);const observation=await value.provider.list(options);if(!Array.isArray(observation)&&!observation.complete)throw fail();for(const candidate of (Array.isArray(observation)?observation:observation.candidates)){if(candidate.name!==pin.skillId)throw fail();out.push({...candidate,locator:{native:candidate,releaseId:pin.releaseId,runId:active.runId},resourceBase:{kind:'opaque',description:'Pinned published release '+pin.skillId+'@'+pin.version+'; releaseId='+pin.releaseId+'; use skill_resource for supporting text files.'}});}}return out;},
  async get(candidate,options){const active=activeFor(options);if(!active||candidate.locator.runId!==active.runId)throw fail();const value=await entry(active,candidate.locator.releaseId),definition=await value.provider.get(candidate.locator.native,options);if(!definition||definition.name!==value.data.skillId||definition.content!==value.data.body||definition.description!==value.data.description)throw fail();const {path:_path,...safe}=definition;return {...safe,resourceBase:candidate.resourceBase};},
 };});
 return {invalidate:()=>invalidate(),async disposeTurn(active){for(const value of active.skillEntries?.values()||[]){value.controller.abort();await value.provider.dispose();fs.rmSync(value.dir,{recursive:true,force:true});}active.skillEntries?.clear();invalidate();}};
}

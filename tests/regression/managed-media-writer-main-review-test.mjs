import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {writeManagedMediaArtifact,verifyMagicBytes,KNOWN_MP4_BRANDS}=require('../../shell/runtime/managed-media-writer-candidate.cjs');
const id='11111111-2222-4333-8444-555555555555',token='22222222-3333-4444-8555-666666666666';
const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
const fixture=()=>{const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'writer-main-'));return {root,options:{workspaceRoot:root,tenantId:id,runId:id,buffer:bytes,kind:'image',mime:'image/png'}};};
test('exported brand collection cannot authorize arbitrary ftyp brands',()=>{
 assert.equal(Object.isFrozen(KNOWN_MP4_BRANDS),true);assert.throws(()=>KNOWN_MP4_BRANDS.push('xxxx'),TypeError);
 const buf=Buffer.alloc(16);buf.writeUInt32BE(16);buf.write('ftypxxxx',4);assert.equal(verifyMagicBytes(buf,'video/mp4'),false);
});
test('compatible brands must be inside a real bounded ftyp box, not following payload',()=>{
 const buf=Buffer.alloc(32);buf.writeUInt32BE(16);buf.write('ftypxxxx',4);buf.write('mp41',24);assert.equal(verifyMagicBytes(buf,'video/mp4'),false);
 for(const size of [0,1,12,17,64]){buf.writeUInt32BE(size);assert.equal(verifyMagicBytes(buf,'video/mp4'),false);}
});
test('a failed exclusive open never deletes another owners pending file',()=>{
 const {root,options}=fixture(),original=crypto.randomUUID,dir=path.join(root,id,'media-results',id);fs.mkdirSync(dir,{recursive:true});
 const pending=path.join(dir,'.pending-'+token);fs.writeFileSync(pending,'existing owner data');crypto.randomUUID=()=>token;
 try{assert.throws(()=>writeManagedMediaArtifact(options),{code:'MANAGED_MEDIA_WRITER_WRITE_FAILED'});assert.equal(fs.readFileSync(pending,'utf8'),'existing owner data');}
 finally{crypto.randomUUID=original;fs.rmSync(root,{recursive:true,force:true});}
});
test('existing final file or symlink stays untouched and only this attempts pending file is removed',()=>{
 for(const symlink of [false,true]){
  const {root,options}=fixture(),original=crypto.randomUUID,dir=path.join(root,id,'media-results',id);fs.mkdirSync(dir,{recursive:true});
  const final=path.join(dir,token+'.png'),outside=path.join(root,'outside');fs.writeFileSync(outside,'existing owner data');if(symlink)fs.symlinkSync(outside,final);else fs.writeFileSync(final,'existing owner data');crypto.randomUUID=()=>token;
  try{assert.throws(()=>writeManagedMediaArtifact(options),{code:'MANAGED_MEDIA_WRITER_WRITE_FAILED'});assert.equal(fs.readFileSync(final,'utf8'),'existing owner data');assert.equal(fs.existsSync(path.join(dir,'.pending-'+token)),false);}
  finally{crypto.randomUUID=original;fs.rmSync(root,{recursive:true,force:true});}
 }
});
test('short writes finish fully; zero-write or fsync errors clean only the newly created temporary artifact',()=>{
 for(const mode of ['short','zero','fsync']){
  const {root,options}=fixture(),write=fs.writeSync,sync=fs.fsyncSync;
  if(mode==='fsync')fs.fsyncSync=()=>{throw Error('PRIVATE_SENTINEL');};
  else fs.writeSync=(fd,buffer,offset,length,position)=>mode==='zero'?0:write(fd,buffer,offset,Math.min(length,3),position);
  try{
   if(mode==='short'){const receipt=writeManagedMediaArtifact(options);assert.deepEqual(fs.readFileSync(path.join(root,id,receipt.rel)),bytes);}
   else{assert.throws(()=>writeManagedMediaArtifact(options),error=>{assert.equal(error.code,'MANAGED_MEDIA_WRITER_WRITE_FAILED');assert.equal(error.message.includes('PRIVATE_SENTINEL'),false);return true;});assert.equal(fs.readdirSync(path.join(root,id,'media-results',id)).length,0);}
  }finally{fs.writeSync=write;fs.fsyncSync=sync;fs.rmSync(root,{recursive:true,force:true});}
 }
});
test('proxy, revoked proxy, getter and custom Buffer length reject without executing accessors',()=>{
 const {root,options}=fixture();let traps=0;
 try{
  const proxied=new Proxy(options,{ownKeys(){traps++;return [];},get(){traps++;throw Error('PRIVATE_SENTINEL');}}),revoked=Proxy.revocable(options,{});revoked.revoke();
  for(const value of [proxied,revoked.proxy])assert.throws(()=>writeManagedMediaArtifact(value),{code:'MANAGED_MEDIA_WRITER_ARGUMENT_INVALID'});
  const getter={...options};Object.defineProperty(getter,'mime',{enumerable:true,get(){traps++;return 'image/png';}});assert.throws(()=>writeManagedMediaArtifact(getter),{code:'MANAGED_MEDIA_WRITER_ARGUMENT_INVALID'});
  const altered=Buffer.from(bytes);Object.defineProperty(altered,'length',{get(){traps++;return 12;}});assert.throws(()=>writeManagedMediaArtifact({...options,buffer:altered}),{code:'MANAGED_MEDIA_WRITER_ARGUMENT_INVALID'});assert.equal(traps,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('media-results and Run directory symlinks reject without writing outside',()=>{
 for(const level of ['media-results','run']){
  const {root,options}=fixture(),outside=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'writer-outside-'));fs.mkdirSync(path.join(root,id),{recursive:true});
  if(level==='media-results')fs.symlinkSync(outside,path.join(root,id,'media-results'));
  else{fs.mkdirSync(path.join(root,id,'media-results'));fs.symlinkSync(outside,path.join(root,id,'media-results',id));}
  try{assert.throws(()=>writeManagedMediaArtifact(options),{code:'MANAGED_MEDIA_WRITER_WRITE_FAILED'});assert.equal(fs.readdirSync(outside).length,0);}
  finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
 }
});
test('root pinning failure has only the static writer error, never original path/cause',()=>{
 const {root,options}=fixture(),file=path.join(root,'PRIVATE_SENTINEL');fs.writeFileSync(file,'not a directory');
 try{assert.throws(()=>writeManagedMediaArtifact({...options,workspaceRoot:file}),error=>{assert.equal(error.code,'MANAGED_MEDIA_WRITER_WRITE_FAILED');assert.equal(error.message.includes('PRIVATE_SENTINEL'),false);assert.equal(error.cause,undefined);return true;});}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});

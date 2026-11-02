import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {nativeImageMessage} from '../../shell/runtime/native-image-message.mjs';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {Context}=await import(require.resolve('@deepseek-ai/cordis'));
const {LocalAttachmentStore}=await import(require.resolve('@deepseek-ai/dsh-attachment-local'));
const sharp=require('sharp');

test('native DSH image admission produces durable ImageBlock and reopens bytes',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'native-image-message-'));
 try{
  const bytes=await sharp({create:{width:16,height:12,channels:3,background:'#123456'}}).png().toBuffer();
  const store=new LocalAttachmentStore(new Context(),{dshHome:home});
  const message=await nativeImageMessage({attachments:store,text:'Describe the image',images:[{data:bytes.toString('base64'),mediaType:'image/png',name:'fixture.png'}]});
  assert.equal(message.content[1].type,'image');
  const ref=message.content[1].attachment;
  assert.equal(ref.width,16);assert.equal(ref.height,12);
  assert.match(ref.attachmentId,/^sha256:/);
  const reopened=new LocalAttachmentStore(new Context(),{dshHome:home});
  const read=await reopened.readImage(ref);
  assert.deepEqual(Buffer.from(read.data),bytes);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('native validation rejects malformed and false MIME input before publishing',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'native-image-invalid-'));
 try{
  const store=new LocalAttachmentStore(new Context(),{dshHome:home});
  const png=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
  for(const image of [{data:'not base64',mediaType:'image/png'},{data:Buffer.from('not an image').toString('base64'),mediaType:'image/png'}]){
   await assert.rejects(nativeImageMessage({attachments:store,text:'test',images:[image]}));
  }
  await assert.rejects(nativeImageMessage({attachments:store,text:'test',images:[{data:png.toString('base64'),mediaType:'image/jpeg'}]}));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('transport refuses external references and cancellation before native storage',async()=>{
 let calls=0;const attachments={saveImages:async()=>{calls++;return []}};
 await assert.rejects(nativeImageMessage({attachments,text:'test',images:[{url:'http://169.254.169.254',mediaType:'image/png'}]}));
 const controller=new AbortController();controller.abort();
 await assert.rejects(nativeImageMessage({attachments,text:'test',images:[],signal:controller.signal}));
 assert.equal(calls,0);
});

test('host transport bounds count and encoded bytes before native allocation',async()=>{
 let calls=0;const attachments={saveImages:async()=>{calls++;return []}};
 const image={mediaType:'image/png',data:'AAAA'};
 await assert.rejects(nativeImageMessage({attachments,text:'test',images:Array(5).fill(image)}));
 await assert.rejects(nativeImageMessage({attachments,text:'test',images:[{...image,data:'A'.repeat(4*Math.ceil((10*1024*1024+3)/3))}]}));
 assert.equal(calls,0);
});

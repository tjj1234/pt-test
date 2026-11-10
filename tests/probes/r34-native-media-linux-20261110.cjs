'use strict';
// Run in Linux/x64 with the frozen runtime mounted read-only and no network.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {processMedia,recognizeImage,run}=require('../../shell/media/local-content-runtime.cjs');
(async()=>{
 const root=process.env.R34_MEDIA_PROOF_ROOT;if(!root)throw Error('R34_MEDIA_PROOF_ROOT is required');
 const audio=fs.readFileSync(path.join(root,'whisper.cpp-1.7.6/samples/jfk.wav'));
 const result=await processMedia({bytes:audio,mimeType:'audio/wav'});
 assert.match(result.segments.map(s=>s.text).join(' '),/ask not what your country/i);assert.equal(result.durationMs,11000);assert(result.segments[0].endMs>10000);
 console.log('REAL_AUDIO_TRANSCRIPTION_PASS');
 const ocr=await recognizeImage(fs.readFileSync(path.join(root,'ocr-proof.png')));assert.match(ocr,/12345/);assert.match(ocr,/中文/);console.log('REAL_CHINESE_OCR_PASS');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r34-media-proof-'));
 try{
  const file=path.join(dir,'test.mp4');await run('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=10','-t','3','-c:v','mpeg4',file],{cwd:dir});
  const video=await processMedia({bytes:fs.readFileSync(file),mimeType:'video/mp4'});
  assert.equal(video.durationMs,3000);assert.equal(video.frames.length,3);assert.deepEqual(video.frames.map(f=>f.timestampMs),[0,1500,2000]);assert(video.frames.every(f=>f.frameBase64.length>1000));console.log('REAL_VIDEO_FRAMES_PASS');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 const controller=new AbortController();controller.abort();await assert.rejects(processMedia({bytes:audio,mimeType:'audio/wav',signal:controller.signal}),e=>e.code==='RUN_CANCELLED');
 const running=new AbortController();const pending=processMedia({bytes:audio,mimeType:'audio/wav',signal:running.signal});setTimeout(()=>running.abort(),100);
 await assert.rejects(pending,e=>e.code==='RUN_CANCELLED');console.log('MEDIA_PRE_AND_INFLIGHT_CANCEL_PASS');
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});

'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const fail=code=>Object.assign(new Error('Local media content processing failed'),{code});
let cached=null,active=0;
function runtime(){
 const root=path.resolve(process.env.PT_NATIVE_MEDIA_RUNTIME||path.join(__dirname,'vendor-runtime'));
 if(process.platform!=='linux'||process.arch!=='x64')throw fail('MEDIA_BACKEND_UNAVAILABLE');
 const manifestFile=path.join(root,'manifest.json'),stat=fs.lstatSync(manifestFile);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw fail('MEDIA_RUNTIME_UNTRUSTED');
 const bytes=fs.readFileSync(manifestFile),signature=createHash('sha256').update(bytes).digest('hex');
 if(cached?.root===root&&cached.signature===signature)return root;
 const m=JSON.parse(bytes);if(m.platform!=='linux'||m.arch!=='x64'||m.schemaVersion!==1||!m.files||Object.keys(m.files).length>2000)throw fail('MEDIA_RUNTIME_UNTRUSTED');
 for(const [relative,record]of Object.entries(m.files)){
  if(!relative||relative.includes('\\')||path.isAbsolute(relative)||relative.split('/').some(s=>s==='..'||s==='.')||!/^[a-f0-9]{64}$/.test(record.sha256))throw fail('MEDIA_RUNTIME_UNTRUSTED');
  const file=path.join(root,relative),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==record.size||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==record.sha256)throw fail('MEDIA_RUNTIME_UNTRUSTED');
 }
 for(const required of ['bin/ffmpeg','bin/ffprobe','bin/tesseract','bin/whisper-cli','lib/ld-linux-x86-64.so.2','ggml-tiny.bin'])if(!m.files[required])throw fail('MEDIA_RUNTIME_UNTRUSTED');
 cached={root,signature};return root;
}
async function run(program,args,{input,signal,timeoutMs=30000,maxBytes=1024*1024,cwd}={}){
 if(signal?.aborted)throw fail('RUN_CANCELLED');
 if(!['ffmpeg','ffprobe','tesseract','whisper-cli'].includes(program)||!Array.isArray(args)||args.length<1||args.length>128||args.some(value=>typeof value!=='string'||value.length>8192||value.includes('\0'))||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>150000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>20*1024*1024)throw fail('MEDIA_LIMIT_INVALID');
 // FFmpeg defaults to host CPU count. Bound decoder, filter and encoder
 // threads explicitly so the same non-root NPROC limit works on large hosts.
 if(program==='ffmpeg')args=['-threads','2','-filter_threads','2','-filter_complex_threads','2',...args.slice(0,-1),'-threads','2',args.at(-1)];
 const root=runtime();if(!fs.existsSync('/usr/bin/prlimit'))throw fail('MEDIA_RESOURCE_BACKEND_UNAVAILABLE');
 return new Promise((resolve,reject)=>{
  let failure,stdout=[],stderr=[],outBytes=0,errBytes=0,killTimer;
  const child=spawn('/usr/bin/prlimit',['--as=1073741824','--cpu=150','--nofile=64','--nproc=64','--',path.join(root,'lib/ld-linux-x86-64.so.2'),'--library-path',path.join(root,'lib'),'--inhibit-cache',path.join(root,'bin',program),...args],{cwd,detached:true,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:cwd||'/nonexistent',TESSDATA_PREFIX:path.join(root,'tessdata'),OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const stop=code=>{if(failure)return;failure=fail(code);if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(kill,300);};
  const abort=()=>stop('RUN_CANCELLED'),timer=setTimeout(()=>stop('MEDIA_TIMEOUT'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  child.on('error',()=>stop('MEDIA_PROCESS_FAILED'));child.stdout.on('data',b=>{outBytes+=b.length;if(outBytes>maxBytes)return stop('MEDIA_OUTPUT_LIMIT');if(!failure)stdout.push(b);});
  child.stderr.on('data',b=>{errBytes+=b.length;if(errBytes>256*1024)return stop('MEDIA_OUTPUT_LIMIT');if(!failure)stderr.push(b);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);if(failure)return reject(failure);if(code!==0)return reject(fail('MEDIA_DECODE_FAILED'));resolve({stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr).toString('utf8')});});
  if(signal?.aborted)abort();
 });
}
async function processMedia({bytes,mimeType,signal}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>50*1024*1024)throw fail('MEDIA_INPUT_LIMIT');
 if(!['audio/wav','audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','video/mp4','video/webm','video/quicktime'].includes(mimeType))throw fail('MEDIA_FORMAT_UNSUPPORTED');
 if(active>=1)throw fail('MEDIA_PROCESSOR_BUSY');if(signal?.aborted)throw fail('RUN_CANCELLED');
 const root=runtime(),parent=process.env.PT_MEDIA_PROCESSING_DIR||path.join(os.tmpdir(),'northstar-media-processing');fs.mkdirSync(parent,{recursive:true,mode:0o700});
 const dir=fs.mkdtempSync(path.join(parent,'job-'));active++;
 try{
  const file=path.join(dir,'input.media');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
  const probed=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,width,height,duration','-of','json',file],{signal,cwd:dir,maxBytes:65536});
  let metadata;try{metadata=JSON.parse(probed.stdout);}catch{throw fail('MEDIA_METADATA_INVALID');}
  const durationMs=Math.round(Number(metadata.format?.duration)*1000),streams=metadata.streams;
  if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>300000||!Array.isArray(streams)||streams.length>32)throw fail('MEDIA_DURATION_INVALID');
  const segments=[],frames=[];
  if(streams.some(s=>s.codec_type==='audio')){
   const audio=path.join(dir,'audio.wav');await run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',file,'-vn','-map','0:a:0','-ac','1','-ar','16000','-t','300','-c:a','pcm_s16le',audio],{signal,cwd:dir,maxBytes:1024});
   const output=path.join(dir,'transcript');await run('whisper-cli',['--no-gpu','-m',path.join(root,'ggml-tiny.bin'),'-f',audio,'-oj','-of',output,'-t','2','-l','auto'],{signal,cwd:dir,timeoutMs:150000,maxBytes:1024*1024});
   if(signal?.aborted)throw fail('RUN_CANCELLED');const jsonFile=output+'.json';if(fs.statSync(jsonFile).size>1024*1024)throw fail('MEDIA_OUTPUT_LIMIT');
   const data=JSON.parse(fs.readFileSync(jsonFile,'utf8'));if(!Array.isArray(data.transcription)||data.transcription.length>5000)throw fail('MEDIA_TRANSCRIPT_INVALID');
   let previous=0;for(const item of data.transcription){const startMs=item.offsets?.from,endMs=item.offsets?.to,text=item.text;
    if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<previous||endMs<startMs||endMs>durationMs+2000||typeof text!=='string'||text.length>10000)throw fail('MEDIA_TRANSCRIPT_INVALID');
    previous=endMs;segments.push({startMs,endMs,text});
   }
  }
  if(mimeType.startsWith('video/')&&streams.some(s=>s.codec_type==='video')){
   for(const timestamp of [...new Set([0,Math.floor(durationMs/2),Math.max(0,durationMs-1000)])]){
    const result=await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','info','-copyts','-ss',String(timestamp/1000),'-protocol_whitelist','file,pipe','-i',file,'-an','-vf','scale=min(640\\,iw):-2,showinfo','-frames:v','1','-vsync','0','-f','image2pipe','-c:v','mjpeg','pipe:1'],{signal,cwd:dir,maxBytes:1024*1024});
    const info=/pts_time:([0-9.]+).*?s:(\d+)x(\d+)/.exec(result.stderr);if(!info||!result.stdout.length)throw fail('MEDIA_FRAME_INVALID');
    const actualMs=Math.round(Number(info[1])*1000);if(!Number.isSafeInteger(actualMs)||actualMs<0||actualMs>durationMs+1000)throw fail('MEDIA_FRAME_INVALID');
    frames.push({timestampMs:actualMs,width:Number(info[2]),height:Number(info[3]),frameBase64:result.stdout.toString('base64'),sha256:createHash('sha256').update(result.stdout).digest('hex')});
   }
  }
  if(signal?.aborted)throw fail('RUN_CANCELLED');return {durationMs,segments,frames,inputSha256:createHash('sha256').update(bytes).digest('hex'),limitations:'Machine transcription and sampled frames; may omit or misrecognize speech and visual events.'};
 }finally{active--;fs.rmSync(dir,{recursive:true,force:true});}
}
async function recognizeImage(bytes,{signal}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>10*1024*1024)throw fail('MEDIA_INPUT_LIMIT');
 const result=await run('tesseract',['stdin','stdout','-l','chi_sim+eng','--psm','3'],{input:bytes,signal,maxBytes:1024*1024,timeoutMs:30000});return result.stdout.toString('utf8').trim();
}
module.exports={processMedia,recognizeImage,run,verifyRuntime:runtime};

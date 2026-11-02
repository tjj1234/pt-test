import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../shell/package.json',import.meta.url));
const {createDshRuntime}=require('./runtime/dsh-adapter.cjs');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dsh-native-image-'));
let runtime;const posts=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);posts.push(body);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'image-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
 res.write(frame({role:'assistant',content:'IMAGE_FIXTURE_OK'}));res.write(frame({},'stop'));res.end('data: [DONE]\n\n');
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const settings=path.join(temp,'settings.yaml');
 fs.writeFileSync(settings,`llm-pi-ai:\n  providers:\n    powertokens:\n      apiKeyEnv: POWERTOKENS_API_KEY\n      api: openai-completions\n      baseURL: http://127.0.0.1:${server.address().port}/v1\n      defaultInput: [text, image]\n      retryPolicy:\n        mode: normal\n        maxRetries: 0\n      models:\n        - id: fixture-vision\nagent-default-model:\n  provider: powertokens\n  model: fixture-vision\n`);
 fs.writeFileSync(settings,fs.readFileSync(settings,'utf8').replace('        - id: fixture-vision\n','        - id: fixture-vision\n        - id: fixture-text\n          input: [text]\n'));
 runtime=createDshRuntime({dshHome:path.join(temp,'home'),settingsTemplate:settings,persistentRunner:path.resolve('shell/persistent-runner.mjs'),tmpDir:path.join(temp,'logs'),taskTimeoutMs:20000,idleMs:60000});
 const bytes=await require('sharp')({create:{width:16,height:12,channels:3,background:'#123456'}}).png().toBuffer();
 const base={sessionKey:'image-session',tenantId:'fixture',userId:'fixture',workspace:temp,apiKey:'offline-fixture-not-key',model:'fixture-vision'};
 const first=await runtime.run({...base,question:'Describe image',inputImages:[{data:bytes.toString('base64'),mediaType:'image/png'}]});
 assert.equal(first.ok,true,JSON.stringify({code:first.code,error:first.error}));
 assert.deepEqual(first.imageInput,{kind:'dsh-native-images-v1',newImageCount:1,capabilityChecked:true});
 const second=await runtime.run({...base,question:'Recall the same image'});
 assert.equal(second.ok,true,JSON.stringify({code:second.code,error:second.error}));
 assert.deepEqual(second.imageInput,{kind:'dsh-native-images-v1',newImageCount:0,capabilityChecked:true});
 // A hot vision session switching to an explicitly text-only native model
 // must fail before HTTP instead of silently projecting image placeholders.
 const rejected=await runtime.run({...base,model:'fixture-text',question:'Recall image using this text-only route'});
 assert.equal(rejected.ok,false);assert.equal(rejected.code,'NATIVE_IMAGE_MODEL_UNSUPPORTED');
 assert.equal(posts.length,2);
 for(const post of posts){
  const images=post.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image_url');
  assert.equal(images.length,1);assert.match(images[0].image_url.url,/^data:image\//);
 }
 console.log(JSON.stringify({result:'PASS',scope:'locked-native-CLI-pi-ai-loopback',requests:posts.length,firstFresh:first.fresh,secondFresh:second.fresh,imagePresentInBoth:true,textOnlySwitchRejected:true,noPaidCalls:true}));
}catch(error){console.error(error);console.error('diagnosticTemp='+temp);throw error;}
finally{runtime?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

// Native launcher/pi-ai adapter against loopback fixture; no live Key or provider calls.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createDshRuntime}=require('../../shell/runtime/dsh-adapter.cjs');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'northstar-native-switch-offline-'));
const posts=[],intents=[];let runtime;
const server=http.createServer(async(req,res)=>{
 let data='';for await(const part of req)data+=part;const body=JSON.parse(data);posts.push({model:body.model,maxTokens:body.max_tokens??body.max_completion_tokens});
 if(body.messages.some(m=>JSON.stringify(m).includes('UPSTREAM_REJECT_FIXTURE'))){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'upstream-secret-marker',type:'invalid_request_error'}}));return;}
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'offline-chat',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
 res.write(frame({role:'assistant',content:'OFFLINE_NATIVE_OK'}));res.write(frame({},'stop'));res.end('data: [DONE]\n\n');
});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const settings=path.join(temp,'settings.yaml');fs.writeFileSync(settings,fs.readFileSync('shell/dsh-settings.yaml','utf8').replace('https://api.powertokens.ai/v1','http://127.0.0.1:'+server.address().port+'/v1'));
 runtime=createDshRuntime({dshHome:path.join(temp,'home'),settingsTemplate:settings,persistentRunner:path.resolve('shell/persistent-runner.mjs'),tmpDir:path.join(temp,'logs'),taskTimeoutMs:15000,idleMs:60000});
 const results=[];
 for(const model of ['unconfigured-fixture-model','deepseek-flash','deepseek-v4-1-flash-260910']){
  const result=await runtime.run({sessionKey:'same-session',tenantId:'fixture',userId:'fixture',workspace:temp,apiKey:'offline-placeholder-not-credential',model,question:'Reply OFFLINE_NATIVE_OK',recordModelIntents:true,onToolRequest:async request=>{
   intents.push({expected:model,actual:request.args.model});
   if(request.args.model!==model)throw Object.assign(new Error('intent mismatch'),{code:'MODEL_INTENT_INVALID'});
   return {recorded:true};
  }});
  results.push({model,...result});
 }
 assert.equal(results[0].ok,false);assert.equal(results[0].code,'UNKNOWN_MODEL');
 assert.equal(posts.length,2);assert.deepEqual(posts.map(x=>x.model),['deepseek-flash','deepseek-v4-1-flash-260910']);
 assert.ok(results.slice(1).every(x=>x.ok));assert.equal(JSON.stringify(results).includes('upstream-secret-marker'),false);
 const rejected=await runtime.run({sessionKey:'reject-session',tenantId:'fixture',userId:'fixture',workspace:temp,apiKey:'offline-placeholder-not-credential',model:'deepseek-flash',question:'UPSTREAM_REJECT_FIXTURE'});
 assert.equal(rejected.ok,false);assert.equal(rejected.code,'INVALID_REQUEST');assert.equal(JSON.stringify(rejected).includes('upstream-secret-marker'),false);
 console.log(JSON.stringify({temp,posts,intents,results:results.map(x=>({model:x.model,ok:x.ok,code:x.code,text:x.text}))},null,2));
}finally{runtime?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

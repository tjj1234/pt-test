import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('native pinned launcher records the final selected model before both warm-session requests',{timeout:25000},async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['tests/probes/northstar-native-model-switch-offline-20261029.mjs'],{cwd:path.resolve('.'),timeout:20000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout);
 try{
  const models=['qwen3.5-flash','seed-2-0-lite-260228'];
  assert.deepEqual(result.posts.map(x=>x.model),models);
  assert.deepEqual(result.posts.map(x=>x.maxTokens),[128,128]);
  assert.deepEqual(result.intents,models.map(model=>({expected:model,actual:model})));
  assert.deepEqual(result.results.map(x=>x.ok),[true,true]);
  assert.deepEqual(result.results.map(x=>x.text),['OFFLINE_NATIVE_OK','OFFLINE_NATIVE_OK']);
 }finally{
  assert.match(path.basename(result.temp),/^northstar-native-switch-offline-/);
  fs.rmSync(result.temp,{recursive:true,force:true});
 }
});

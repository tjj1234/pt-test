import test from 'node:test';
import assert from 'node:assert/strict';
import {bootApp,flush} from '../helpers/app-harness.mjs';
const runId='11111111-2222-4333-8444-555555555555';
const walk=(node,predicate)=>[node,...(node.children||[]).flatMap(child=>walk(child,()=>true))].filter(predicate);
const text=node=>walk(node,()=>true).map(el=>el.textContent||'').join(' ');

test('media consent never posts on render; only explicit selection and click submit the owned Run/model',async()=>{
 const app=await bootApp();
 app.run(`globalThis.__authorizationCalls=[]; modelCaps.set('fixture-video',{}); fetch=async(url,options)=>{__authorizationCalls.push({url,...options});return {ok:true,json:async()=>({ok:true,authorized:true})};}; globalThis.__authorizationPanel=createMediaAuthorizationPanel({runId:'${runId}'}); document.querySelector('#chat').appendChild(__authorizationPanel);`);
 const panel=app.run('__authorizationPanel');
 assert.equal(app.run('__authorizationCalls.length'),0);
 assert.match(text(panel),/没有金额硬上限/);
 const select=walk(panel,el=>el.tagName==='select')[0],button=walk(panel,el=>el.tagName==='button')[0];
 button.dispatch('click');await flush();assert.equal(app.run('__authorizationCalls.length'),0);
 select.value='fixture-video';button.dispatch('click');await flush();
 const call=app.run('__authorizationCalls[0]');
 assert.equal(call.url,`/api/runs/${runId}/media-authorization`);
 assert.equal(call.credentials,'same-origin');assert.equal(call.method,'POST');
 assert.deepEqual(JSON.parse(call.body),{confirmed:true,modelId:'fixture-video'});
 assert.equal(button.disabled,true);assert.match(text(panel),/已确认/);
});

test('pending authorization follows its conversation across repaint and cannot render in another conversation',async()=>{
 const app=await bootApp({conversations:{A:{id:'A',title:'A',messages:[],msgCount:0},B:{id:'B',title:'B',messages:[],msgCount:0}}});
 app.el('chat').contains=node=>walk(app.el('chat'),()=>true).includes(node);
 await app.awaitRun("openConversation('B')");
 app.run(`chatRunsByConversation.set('A',{runId:'${runId}',mediaAuthorization:{runId:'${runId}'}}); restoreMediaAuthorization('A');`);
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,0);
 await app.awaitRun("openConversation('A')");
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,1);
 app.run("restoreMediaAuthorization('A')");
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,1);
 await app.awaitRun("openConversation('B')");
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,0);
 await app.awaitRun("openConversation('A')");
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,1);
});

test('failed confirmation stays visible and never renders untrusted server errors',async()=>{
 const app=await bootApp();
 app.run(`fetch=async()=>({ok:false,json:async()=>({code:'PRIVATE_SENTINEL<script>'})}); globalThis.__authorizationPanel=createMediaAuthorizationPanel({runId:'${runId}'}); document.querySelector('#chat').appendChild(__authorizationPanel);`);
 const panel=app.run('__authorizationPanel'),select=walk(panel,el=>el.tagName==='select')[0],button=walk(panel,el=>el.tagName==='button')[0];
 select.value='fixture-video';button.dispatch('click');await flush();
 assert.equal(button.disabled,false);assert.equal(select.disabled,false);assert.match(text(panel),/本次确认未完成/);assert.equal(text(panel).includes('PRIVATE_SENTINEL'),false);
});

test('refresh replay restores pending consent without submitting or calling a model',async()=>{
 const app=await bootApp({conversations:{A:{id:'A',title:'A',messages:[],msgCount:0}},setTimeout:fn=>{queueMicrotask(fn);return 0;}});
 app.el('chat').contains=node=>walk(app.el('chat'),()=>true).includes(node);
 await app.awaitRun("openConversation('A')");
 app.run(`const priorFetch=fetch; globalThis.__approvalPosts=0; globalThis.__pages=0;
 globalThis.__replayFinish=new Promise(resolve=>globalThis.__releaseReplay=resolve);
 fetch=async(url,options)=>{
  if(url.includes('/media-authorization')){__approvalPosts++;throw Error('unexpected automatic consent');}
  if(url.startsWith('/api/runs/${runId}/events?')){
   __pages++;
   if(__pages===1)return {ok:true,json:async()=>({events:[{seq:1,runId:'${runId}',type:'state',payload:{action:'media_authorization_required',taskType:'text2video',expiresAt:'2099-01-01T00:00:00.000Z'}}]})};
   await __replayFinish;return {ok:true,json:async()=>({events:[{seq:2,runId:'${runId}',type:'done',payload:{state:'cancelled'}}]})};
  }
  return priorFetch(url,options);
 };
 globalThis.__run=runChat({conversationId:'A',resumeRunId:'${runId}'});`);
 await flush();
 assert.equal(walk(app.el('chat'),el=>el.className==='media-authorization').length,1);
 assert.equal(app.run('__approvalPosts'),0);
 app.run('__releaseReplay()');await app.awaitRun('__run');
 assert.equal(app.run('__approvalPosts'),0);
});

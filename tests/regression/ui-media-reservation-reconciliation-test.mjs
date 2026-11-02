import test from 'node:test';
import assert from 'node:assert/strict';
import {bootApp,flush} from '../helpers/app-harness.mjs';
const runId='11111111-2222-4333-8444-555555555555',reservationId='22222222-3333-4444-8555-666666666666';
const walk=(node,predicate)=>[node,...(node.children||[]).flatMap(child=>walk(child,()=>true))].filter(predicate);
const text=node=>walk(node,()=>true).map(el=>el.textContent||'').join(' ');
test('history only reconciles an owned reservation after explicit click and preserves unknown outcome',async()=>{
 const app=await bootApp();
 app.run(`globalThis.__reservationCalls=[];globalThis.__decision='keep_reserved';fetch=async(url,options)=>{
  __reservationCalls.push({url,...options});
  return {ok:true,json:async()=>options?.method==='POST'?{ok:true,reservationId:'${reservationId}',decision:__decision,grantRemainsConsumed:true,mayResubmit:false}:{ok:true,view:{items:[{runId:'${runId}',reservationId:'${reservationId}',modelId:'fixture-video',taskLabel:'文生视频',statusLabel:'占位保留',detail:'核对后判断',canRequestReconciliation:true}],hasMore:true}}};
 };addMediaReservationControls(document.querySelector('#chat'),'${runId}');`);
 assert.equal(app.run('__reservationCalls.length'),0);
 walk(app.el('chat'),el=>el.tagName==='button'&&el.textContent==='查看媒体占位')[0].dispatch('click');await flush();
 assert.equal(app.run('__reservationCalls.length'),1);assert.match(text(app.el('chat')),/前100条/);
 const reconcile=walk(app.el('chat'),el=>el.tagName==='button'&&el.textContent==='核对并更新占位')[0];
 reconcile.dispatch('click');await flush();
 const request=app.run('__reservationCalls[1]');assert.equal(request.url,'/api/media-reservations/reconcile');assert.equal(request.credentials,'same-origin');
 assert.deepEqual(JSON.parse(request.body),{reservationId});assert.match(text(app.el('chat')),/占位继续保留.*请勿重复提交/);assert.equal(reconcile.disabled,false);
 app.run("__decision='release_allowed'");reconcile.dispatch('click');await flush();
 assert.equal(reconcile.disabled,true);assert.match(text(app.el('chat')),/原授权仍已消费/);
});
test('foreign Run rows and unconfirmed decisions never show a successful release',async()=>{
 const app=await bootApp();
 app.run(`fetch=async()=>({ok:true,json:async()=>({ok:true,view:{items:[{runId:'99999999-2222-4333-8444-555555555555',reservationId:'${reservationId}',modelId:'PRIVATE_SENTINEL',taskLabel:'文生视频',statusLabel:'占位保留',detail:'核对后判断',canRequestReconciliation:true}],hasMore:false}})});addMediaReservationControls(document.querySelector('#chat'),'${runId}');`);
 walk(app.el('chat'),el=>el.tagName==='button'&&el.textContent==='查看媒体占位')[0].dispatch('click');await flush();
 assert.match(text(app.el('chat')),/暂时无法读取/);assert.equal(text(app.el('chat')).includes('PRIVATE_SENTINEL'),false);
 assert.equal(walk(app.el('chat'),el=>el.tagName==='button'&&el.textContent==='核对并更新占位').length,0);
});

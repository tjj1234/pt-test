import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, flush } from '../helpers/app-harness.mjs';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

function walk(node, fn) {
  if (!node) return [];
  return [node, ...(node.children || []).flatMap((child) => walk(child, fn))].filter(fn);
}
function visibleText(node) { return walk(node, () => true).map((el) => el.textContent || '').join(' '); }

test('reopened assistant message links only its exact persisted Run and shows bounded, owned status', async () => {
  const app = await bootApp({ conversations: { A: { id: 'A', title: 'media', msgCount: 2, archived: false, messages: [
    { role: 'assistant', text: '处理未完成', runId: RUN_ID },
    { role: 'assistant', text: '旧消息没有 Run 关联' },
  ] } } });
  await app.awaitRun("openConversation('A')");
  const buttons = walk(app.el('chat'), (el) => el.tagName === 'button' && el.textContent === '查看本次运行');
  assert.equal(buttons.length, 1, 'a message without a server-persisted Run ID must not guess one');
  app.run(`globalThis.__runReviewRequests=[]; fetch=async (url, options) => {
    __runReviewRequests.push({url, credentials:options?.credentials});
    return {ok:true,json:async()=>({ok:true,run:{runId:'${RUN_ID}',state:'failed',request:{prompt:'PRIVATE_PROMPT'}},externalOperations:{operations:[{status:'manual_check',taskId:null,lastQuery:{response:'PRIVATE_PROVIDER_BODY'}}]}})};
  }`);
  buttons[0].dispatch('click');
  await flush();
  const requests = app.run('__runReviewRequests');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/runs/${RUN_ID}`);
  assert.equal(requests[0].credentials, 'same-origin');
  const rendered = visibleText(app.el('chat'));
  assert.match(rendered, /本地状态：失败/);
  assert.match(rendered, /待人工核对/);
  assert.ok(!rendered.includes('PRIVATE_PROMPT'));
  assert.ok(!rendered.includes('PRIVATE_PROVIDER_BODY'));
});

test('malformed or unowned Run details fail closed in the UI', async () => {
  const app = await bootApp({ conversations: { A: { id: 'A', title: 'media', msgCount: 2, archived: false, messages: [
    { role: 'assistant', text: '无效关联', runId: '../../other' },
    { role: 'assistant', text: '有标识但无权读取', runId: RUN_ID },
  ] } } });
  await app.awaitRun("openConversation('A')");
  const buttons = walk(app.el('chat'), (el) => el.tagName === 'button' && el.textContent === '查看本次运行');
  assert.equal(buttons.length, 1);
  app.run('fetch=async()=>({ok:false,status:404})');
  buttons[0].dispatch('click');
  await flush();
  assert.match(visibleText(app.el('chat')), /运行记录暂时无法读取/);
  assert.ok(!visibleText(app.el('chat')).includes('../../other'));
});

test('Run review opens only same-Run managed media links and never guesses a provider URL',async()=>{
 const app=await bootApp({conversations:{A:{id:'A',title:'media',msgCount:1,messages:[{role:'assistant',text:'local storage outcome',runId:RUN_ID}]}}});
 await app.awaitRun("openConversation('A')");
 const local=`/api/run-media/${RUN_ID}/22222222-3333-4444-8555-666666666666.mp4`;
 app.run(`fetch=async()=>({ok:true,json:async()=>({ok:true,run:{runId:'${RUN_ID}',state:'failed'},externalOperations:{operations:[]},managedMedia:{media:[{type:'video',url:'${local}'},{type:'image',url:'https://cdn.example.test/PRIVATE_SENTINEL'},{type:'image',url:'/api/run-media/99999999-2222-4333-8444-555555555555/22222222-3333-4444-8555-666666666666.png'}]}})});`);
 walk(app.el('chat'),el=>el.tagName==='button'&&el.textContent==='查看本次运行')[0].dispatch('click');await flush();
 const links=walk(app.el('chat'),el=>el.tagName==='a'&&el.textContent==='打开已托管视频');assert.equal(links.length,1);assert.equal(links[0].href,local);assert.equal(links[0].rel,'noopener');
 assert.equal(visibleText(app.el('chat')).includes('PRIVATE_SENTINEL'),false);
});

test('Run usage shows paged estimates, unknowns and an owned CSV link', async () => {
  const app = await bootApp({ conversations: { A: { id: 'A', title: 'usage', msgCount: 1, archived: false,
    messages: [{ role: 'assistant', text: '完成', runId: RUN_ID }] } } });
  await app.awaitRun("openConversation('A')");
  app.run(`globalThis.__usageUrls=[]; fetch=async url => {
    __usageUrls.push(url);
    if(!url.includes('/usage?'))return {ok:true,json:async()=>({ok:true,run:{runId:'${RUN_ID}',state:'completed'},externalOperations:{operations:[]}})};
    const first=url.includes('after=-1');
    return {ok:true,json:async()=>({ok:true,runId:'${RUN_ID}',hasMore:first,nextCursor:first?4:9,responses:[first?
      {responseSeq:4,selectedModel:'fixture-model',providerReportedModel:null,modelIdentityEvidence:'unknown',inputTokens:10,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,costCoverage:'estimated',costBasis:'requested_model',costCurrency:'USD',cost:0.00014,priceVersion:'fixture-v1'}:
      {responseSeq:9,selectedModel:'fixture-model',providerReportedModel:null,modelIdentityEvidence:'unknown',inputTokens:null,outputTokens:null,costCoverage:'unknown',cost:null}]})};
  }`);
  walk(app.el('chat'), el => el.tagName === 'button' && el.textContent === '查看本次运行')[0].dispatch('click');
  await flush();
  const usageButton = walk(app.el('chat'), el => el.tagName === 'button' && el.textContent === '查看本次用量')[0];
  assert.ok(usageButton);
  usageButton.dispatch('click'); await flush();
  let rendered = visibleText(app.el('chat'));
  assert.match(rendered, /USD 0\.00014/);
  assert.match(rendered, /fixture-v1/);
  assert.match(rendered, /非 PT 官方账单/);
  assert.match(rendered, /按请求模型官方价格估算；上游身份未知/);
  assert.equal(usageButton.textContent, '加载更多用量');
  usageButton.dispatch('click'); await flush();
  rendered = visibleText(app.el('chat'));
  assert.match(rendered, /已显示 2 条/);
  assert.match(rendered, /未知/);
  assert.equal(app.run('__usageUrls[2]'), '/api/runs/' + RUN_ID + '/usage?after=4&limit=100');
  assert.equal(walk(app.el('chat'), el => el.tagName === 'a' && el.href === '/api/runs/' + RUN_ID + '/usage-all.csv').length, 1);
});

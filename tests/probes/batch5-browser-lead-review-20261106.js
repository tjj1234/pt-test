async (page) => {
  const root = page.reviewRoot;
  if (!root) throw new Error('reviewRoot must identify the candidate public directory');
  const results = [], chatBodies = [], memoryBodies = [], errors = [], alerts = [];
  let response = {ok:false,code:'SKILL_NOT_AVAILABLE',error:'所选技能版本已禁用或无法验证'}, status = 409;
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => {alerts.push(d.message()); await d.dismiss();});
  await page.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url()), p=u.pathname;
    if (u.hostname !== 'batch5.test') return route.abort();
    if (p === '/') return route.fulfill({path:root+'/index.html',contentType:'text/html'});
    if (p.startsWith('/assets/')) return route.fulfill({path:root+'/'+p.slice(8)});
    let data = {ok:true};
    if (p === '/api/chat') {chatBodies.push(request.postDataJSON());return route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)});}
    if (p === '/api/conversations') data={ok:true,conversations:[]};
    if (p === '/api/models') data={ok:true,models:[],current:'AUTO',auto:'AUTO'};
    if (p === '/api/skills') data={ok:true,skills:[]};
    if (p === '/api/sources') data={ok:true,sources:[]};
    if (p === '/api/memory') {if(request.method()==='POST') memoryBodies.push(request.postDataJSON());data={ok:true,memories:[]};}
    if (p === '/api/auth/key') data={ok:true,key:{key_last4:'TEST'}};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://batch5.test/');
  page.setDefaultTimeout(10000);
  await page.waitForFunction(() => typeof runChat === 'function');
  const check=(name,pass,detail)=>results.push({name,status:pass?'PASS':'FAIL',detail});
  await page.evaluate(`state.activeId=null; document.querySelector('#memScope').value='conversation'; switchView('memory');`);
  await page.waitForFunction(() => document.querySelector('#memScope option[value=conversation]').disabled);
  const memory=await page.evaluate(`({value:document.querySelector('#memScope').value,disabled:document.querySelector('#memScope option[value=conversation]').disabled})`);
  check('memory preserves conversation scope while unavailable',memory.value==='conversation'&&memory.disabled,memory);
  await page.locator('#memKey').fill('scope-test'); await page.locator('#memVal').fill('private content'); await page.locator('#memAdd').click();
  check('no-conversation memory POST blocked',memoryBodies.length===0&&alerts.some(x=>x.includes('先')), {posts:memoryBodies.length,alerts:[...alerts]});
  await page.evaluate(`state.activeId='A'; loadMemory();`);
  await page.waitForFunction(() => !document.querySelector('#memScope option[value=conversation]').disabled);
  await page.locator('#memAdd').click();
  await page.waitForTimeout(50);
  check('selected conversation memory uses conversation scope',memoryBodies.length===1&&memoryBodies[0].scope==='conversation'&&memoryBodies[0].conversationId==='A',memoryBodies);
  const prepare=async()=>page.evaluate(`state.activeId='A';state.busy=false;state.composerLocked=false;modelContextReady=true;modelSelect.value='AUTO';state.skillSelection={releaseId:'release-A',skillId:'skill-A',version:1};state.skillSelectionOverride=true;renderSelectedSkill();switchView('chat');`);
  await prepare();
  await page.evaluate(`runChat({conversationId:'A',message:'test'})`);
  let skill=await page.evaluate(`({selection:state.skillSelection,text:document.querySelector('#selectedSkillChip').textContent})`);
  check('exact unavailable error retains selection and displays warning',skill.selection?.releaseId==='release-A'&&skill.selection?.unavailable===true&&skill.text.includes('已失效'),skill);
  await page.locator('#selectedSkillChip button').click();
  check('manual remove clears selection',await page.evaluate(`state.skillSelection===null`));
  response={ok:false,code:'CHAT_SUBMISSION_FAILED',error:'技能服务暂时繁忙，请稍后再试'};status=400;
  await prepare(); await page.evaluate(`runChat({conversationId:'A',message:'test'})`);
  skill=await page.evaluate(`({selection:state.skillSelection,text:document.querySelector('#selectedSkillChip').textContent})`);
  check('ordinary skill-related error must not declare version unavailable',skill.selection?.unavailable!==true,skill);
  await page.evaluate(`switchView('usage')`);
  await page.locator('#usageRanges [data-range=week]').click();
  const styles=await page.evaluate(`Array.from(document.querySelectorAll('#usageRanges button')).map(b=>({range:b.dataset.range,pressed:b.getAttribute('aria-pressed'),border:getComputedStyle(b).borderColor,shadow:getComputedStyle(b).boxShadow}))`);
  check('usage range click highlights only selected button',styles.find(b=>b.range==='week')?.pressed==='true'&&styles.filter(b=>b.pressed==='true').length===1&&styles.find(b=>b.range==='week')?.shadow!=='none',styles);
  await page.screenshot({path:page.reviewScreenshot});
  return {candidate:'e208343',results,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,pageErrors:errors,chatPosts:chatBodies.length};
}

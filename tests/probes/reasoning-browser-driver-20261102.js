async (page, config) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const diagnostics=[]; let phase="boot";
  try {
  page.on('request',request=>{if(request.url().includes('/api/chat'))diagnostics.push({request:request.url(),method:request.method()});});
  page.on('pageerror',error=>diagnostics.push({pageError:error.message}));
  page.on('response',async response=>{if(response.url().includes('/api/models')){try{const data=await response.json();diagnostics.push({path:response.url().split('?')[0],status:response.status(),ok:data.ok,code:data.code,current:data.current,reasoningEffort:data.reasoningEffort,efforts:data.efforts});}catch{}}});
  await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(config.baseURL);
  await page.locator('.conv-title').first().click();
  const select = page.locator('#reasoningSelect');
  try{await select.waitFor({state:'visible',timeout:8000});}catch{await page.screenshot({path:config.screenshot,fullPage:true});throw Error(JSON.stringify({phase:'initial-reasoning-control',url:page.url(),title:await page.locator('#title').textContent(),model:await page.locator('#modelSelect').inputValue(),diagnostics}));}
  check(await select.inputValue()==='low','reopen persisted low effort');
  phase='save-high';
  const saving=page.waitForResponse(response=>response.url().includes('/api/models/select')&&response.request().method()==='POST',{timeout:7000});
  await select.selectOption('high'); check((await saving).ok(),'save high effort');
  await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled&&!document.querySelector('#reasoningSelect').disabled);
  await page.locator('#ta').fill('Browser reasoning probe');
  phase='send-chat';
  const chat=page.waitForResponse(response=>response.url().endsWith('/api/chat')&&response.request().method()==='POST',{timeout:7000});
  await page.locator('#send').click();
  const response=await chat; await response.finished(); check(response.ok(),'chat request');
  await page.locator('#ta:not([disabled])').waitFor();
  check((await page.locator('#chat').textContent()).includes('REASONING_CHAIN_OK'),'visible assistant result');
  phase='reload'; await page.reload(); await page.locator('.conv-title').first().click(); await select.waitFor({state:'visible'});
  check(await select.inputValue()==='high','reload preserves high effort');
  await page.locator('#msBtn').click();
  phase='switch-plain';
  const switched=page.waitForResponse(response=>response.url().includes('/api/models/select')&&response.request().method()==='POST',{timeout:7000});
  await page.locator('.model-menu-item').filter({hasText:'fixture-plain'}).click();
  check((await switched).ok(),'switch plain model');
  await page.waitForFunction(()=>document.querySelector('#reasoningControl').hidden);
  check(!(await page.locator('#composerNotice').isVisible()),'cleared notice stays hidden');
  await page.screenshot({path:config.screenshot,fullPage:true});
  return {status:'BROWSER_LOCAL_CHAIN_PASS',checks:['restore-low','save-high','send-visible-result','reload-high','plain-clears-effort'],provider:'controlled-adapter',paidProviderCalls:0};
  } catch(error) { await page.screenshot({path:config.screenshot,fullPage:true}); const client=await page.evaluate(()=>({activeId:state.activeId,ready:modelContextReady,busy:state.busy,runs:[...chatRunsByConversation.keys()],notice:document.querySelector('#composerNotice')?.textContent}));throw Error(JSON.stringify({phase,message:error.message,diagnostics,client})); }
}

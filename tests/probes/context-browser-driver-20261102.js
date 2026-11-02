async(page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);await page.goto(config.baseURL);await page.locator('.conv-title').first().click();
 await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);await page.locator('.conv-menu').first().click();
 const response=page.waitForResponse(response=>response.url().endsWith('/api/chat')&&response.request().method()==='POST');await page.getByRole('button',{name:'压缩上下文',exact:true}).click();await(await response).finished();
 await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('上下文已压缩，摘要已保存'));
 await page.reload();await page.locator('.conv-title').first().click();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('上下文已压缩，摘要已保存'));
 await page.screenshot({path:config.screenshot,fullPage:true});return {status:'CONTEXT_BROWSER_CHAIN_PASS',checks:['visible-compaction-entry','durable-Run','native-compaction','saved-checkpoint','history-reload'],paidProviderCalls:0};
}

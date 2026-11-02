async(page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.baseURL);await page.locator('.conv-title').first().click();await page.locator('[data-v="memory"]').click();
 await page.locator('#memKey').fill('browser-scoped');await page.locator('#memVal').fill('UI_MEMORY_MARKER');await page.locator('#memScope').selectOption('conversation');await page.locator('#memMode').selectOption('proposal');await page.locator('#memAdd').click();
 const row=page.locator('.mem-row').filter({hasText:'browser-scoped'});await row.getByText(/待确认/).waitFor();await row.getByRole('button',{name:'确认',exact:true}).click();await row.getByText(/已确认/).waitFor();
 await page.locator('.conv-title').first().click();await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);await page.locator('#ta').fill('Use confirmed memory');
 const chat=page.waitForResponse(response=>response.url().endsWith('/api/chat')&&response.request().method()==='POST');await page.locator('#send').click();await(await chat).finished();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('SOURCE_CHAIN_OK'));
 await page.locator('[data-v="memory"]').click();await row.getByRole('button',{name:'删除',exact:true}).click();await row.waitFor({state:'detached'});await page.reload();await page.locator('[data-v="memory"]').click();await page.locator('#memKey').waitFor();
 if(await page.locator('.mem-row').filter({hasText:'browser-scoped'}).count())throw Error('Deleted memory returned');
 await page.screenshot({path:config.screenshot,fullPage:true});return {status:'MEMORY_BROWSER_CHAIN_PASS',checks:['proposal','host-confirm','conversation-scope','chat','delete','reload'],paidProviderCalls:0};
}

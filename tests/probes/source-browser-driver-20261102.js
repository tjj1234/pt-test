async (page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.baseURL);await page.locator('.conv-title').first().click();await page.locator('#sourceBtn').click();
 await page.locator('#sourceList').getByText('beta.txt',{exact:false}).waitFor({state:'visible'});
 await page.locator('#sourceQuery').fill('project');await page.locator('#sourceSearch').click();
 const result=page.locator('#sourceResults>div').filter({hasText:'beta.txt'});await result.getByRole('button',{name:'引用此处'}).click();
 await page.locator('#sourceCitationChips button').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);await page.locator('#ta').fill('Use selected beta citation');
 const response=page.waitForResponse(response=>response.url().endsWith('/api/chat')&&response.request().method()==='POST');await page.locator('#send').click();await(await response).finished();
 await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('SOURCE_CHAIN_OK'));
 await page.locator('#sourceList>div').filter({hasText:'beta.txt'}).getByRole('button',{name:'删除',exact:true}).click();
}

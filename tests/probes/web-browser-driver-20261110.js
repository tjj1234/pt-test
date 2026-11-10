async (page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.baseURL);await page.locator('#newConv').click();
 await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);await page.locator('#msBtn').click();await page.locator('.model-menu-item').filter({hasText:'fixture-web'}).click();await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);
 await page.locator('#allowWeb').check();await page.locator('#ta').fill('Research and fetch the official source');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/chat')&&r.request().method()==='POST');await page.locator('#send').click();const received=await response;await received.finished();const wire=await received.text();if(!wire.includes('WEB_CHAIN_OK'))throw Error('Browser chat did not complete: '+wire.slice(-1800));
 await page.getByText('WEB_CHAIN_OK',{exact:true}).waitFor();
 if(await page.locator('.web-sources').count()!==2)throw Error('Streaming web source cards missing');
 await page.reload();await page.getByText('WEB_CHAIN_OK',{exact:true}).waitFor();
 await page.getByRole('button',{name:'查看本次运行',exact:true}).last().click();await page.getByRole('button',{name:'查看联网来源',exact:true}).last().click();
 const history=page.locator('.web-sources').last();await history.waitFor();await history.locator('summary').click();
 if(!(await history.textContent()).includes('VERIFIED_WEB_BODY'))throw Error('Saved web evidence was not restored');
 if((await history.locator('a').count())!==2)throw Error('Source link count mismatch');
 const source=history.locator('a').last();if(await source.getAttribute('rel')!=='noopener noreferrer')throw Error('External source opener boundary missing');
 await page.screenshot({path:config.screenshot,fullPage:true});return {status:'WEB_BROWSER_CHAIN_PASS'};
}

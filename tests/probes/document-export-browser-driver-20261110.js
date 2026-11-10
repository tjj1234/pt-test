async(page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.baseURL);await page.locator('#newConv').click();
 await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);await page.locator('#msBtn').click();await page.locator('.model-menu-item').filter({hasText:'fixture-documents'}).click();
 await page.locator('#allowDocuments').check();await page.locator('#ta').fill('EXPORT_FORMAT_docx EXPORT_TEST_ID_browser 请生成中文报告文件');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/chat')&&r.request().method()==='POST');await page.locator('#send').click();const received=await response;await received.finished();
 if(!(await received.text()).includes('DOCUMENT_CHAIN_OK'))throw Error('Document browser request failed');
 const link=page.getByRole('link',{name:'下载 Word 文件',exact:true});await link.waitFor();
 const pending=page.waitForEvent('download');await link.click();const download=await pending;
 if(!download.suggestedFilename().endsWith('.docx'))throw Error('Word download filename missing');await download.path();if(await download.failure())throw Error('Word download failed');
 await page.reload();await page.getByText('DOCUMENT_CHAIN_OK',{exact:true}).waitFor();await page.getByRole('link',{name:'下载 Word 文件',exact:true}).waitFor();
 await page.screenshot({path:config.screenshot,fullPage:true});return {status:'DOCUMENT_BROWSER_CHAIN_PASS'};
}

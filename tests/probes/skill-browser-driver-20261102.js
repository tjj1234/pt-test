async(page,config)=>{
 await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.baseURL);await page.locator('.conv-title').first().click();await page.locator('[data-v="skills"]').click();
 await page.locator('#publishSkillId').fill('review-fixture');await page.locator('#publishSkillVersion').fill('3');await page.locator('#publishSkillMain').fill('---\nname: review-fixture\ndescription: Browser owned review\n---\nPinned publication version 3.');
 await page.locator('#publishSkillFiles').setInputFiles(config.resourceFile);
 // The browser fixture uses a top-level rules.md; the native adapter checks the exact host-pinned path.
 const publishing=page.waitForResponse(r=>r.url().endsWith('/api/published-skills')&&r.request().method()==='POST');await page.locator('#publishSkillSubmit').click();if(!(await publishing).ok())throw Error('UI publish failed');
 await page.locator('#publishSkillStatus').filter({hasText:'已发布'}).waitFor();await page.locator('#publishedSkillList').getByRole('button',{name:'在对话中使用'}).click();
 await page.locator('#selectedSkillChip').filter({hasText:'review-fixture @ 3'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#modelSelect').disabled);
 await page.locator('#ta').fill('Use selected browser skill');const chat=page.waitForResponse(r=>r.url().endsWith('/api/chat')&&r.request().method()==='POST');await page.locator('#send').click();await(await chat).finished();await page.waitForFunction(()=>document.querySelector('#chat').textContent.includes('SKILL_CHAIN_OK'));
 await page.reload();await page.locator('.conv-title').first().click();await page.locator('#selectedSkillChip').filter({hasText:'review-fixture @ 3'}).waitFor();
 await page.locator('[data-v="skills"]').click();await page.locator('#publishedSkillList').getByRole('button',{name:'停用',exact:true}).click();await page.locator('#publishedSkillList').getByText('已停用',{exact:true}).waitFor();await page.reload();await page.locator('[data-v="skills"]').click();await page.locator('#publishedSkillList').getByText('已停用',{exact:true}).waitFor();
 await page.screenshot({path:config.screenshot,fullPage:true});return {status:'SKILL_BROWSER_CHAIN_PASS',checks:['publish-fixed-version','select','native-tool-result','reload-pin','disable','reload-disabled'],paidProviderCalls:0};
}

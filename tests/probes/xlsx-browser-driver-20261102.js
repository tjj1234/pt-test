async (page, config) => {
  await page.context().addCookies([{name:'pt_session',value:config.cookie,url:config.baseURL,httpOnly:true,sameSite:'Lax'}]);
  await page.goto(config.baseURL); await page.locator('.conv-title').first().click();
  const link=page.getByRole('link',{name:'下载 Excel 文件'});await link.waitFor({state:'visible',timeout:8000});
  const waiting=page.waitForEvent('download');await link.click();const download=await waiting;
  if(!(download.suggestedFilename().endsWith('.xlsx')))throw Error('Expected XLSX download');
  await page.reload();await link.waitFor({state:'visible',timeout:8000});
  await page.screenshot({path:config.screenshot,fullPage:true});
  return {status:'XLSX_BROWSER_CHAIN_PASS',checks:['history-shows-artifact','owned-browser-download','reload-keeps-artifact'],providerCalls:0};
}

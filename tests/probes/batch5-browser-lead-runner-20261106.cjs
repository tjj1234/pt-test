const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
(async () => {
  let browser;
  try {
    browser = await chromium.launch({headless:true,channel:'chrome'});
    const page = await browser.newPage();
    const publicRoot=process.env.CANDIDATE_PUBLIC_ROOT || process.argv[2] || path.resolve(__dirname,'../../shell/public');
    const screenshot=path.resolve(__dirname,'../../docs/refactor/evidence/R31-BATCH5-BROWSER-20261106.png');
    page.reviewScreenshot=screenshot;
    if (publicRoot) page.reviewRoot=publicRoot;
    const run = new Function('return ('+fs.readFileSync(path.join(__dirname,'batch5-browser-lead-review-20261106.js'),'utf8')+')')();
    const result = await run(page);
    result.sourceRoot=publicRoot;
    result.candidate='R31 batch5 integration';
    result.sourceSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(result.sourceRoot,'app.js'))).digest('hex');
    const label=process.argv[3] || (publicRoot?'WITH-PATCH':'');
    if (!/^[A-Z0-9-]*$/.test(label)) throw Error('Invalid report label');
    fs.writeFileSync(path.join(__dirname,'../../docs/refactor/evidence/BATCH5-E208343-BROWSER-LEAD'+(label?'-'+label:'')+'-20261106.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.failed?1:0;
  } finally { await browser?.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});

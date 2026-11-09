'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'playwright-core');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const source=fs.readFileSync(path.resolve('shell/public/app.js'),'utf8');const start=source.indexOf('function bizTable('),end=source.indexOf('\nlet bizFlowsRequest',start);assert(start>=0&&end>start);
for(const width of [1280,375]){const page=await browser.newPage({viewport:{width,height:850}});await page.setContent('<style>body{margin:16px;font:14px Arial}main{max-width:900px;width:100%;min-width:0}td,th{box-sizing:border-box}</style><main><div id="table"></div></main>');
await page.addScriptTag({content:'function bizNode(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}\n'+source.slice(start,end)});
await page.evaluate(()=>bizTable(document.querySelector('#table'),['时间','类型','工具','模型','输入摘要','输出摘要','耗时','状态'],[['2026-11-09 12:00:00','Skill','get_current_time','deepseek-v4-pro','中文摘要 '.repeat(30),'x'.repeat(800),'123ms','completed'],['2026-11-09','Workflow','attribution_query','glm-4.7','简短输入','中文长输出'.repeat(40),'3s','completed']]));
const result=await page.evaluate(()=>{const host=document.querySelector('#table'),cells=[...host.querySelectorAll('tbody tr:first-child td')];return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,hostWidth:host.clientWidth,scrollWidth:host.scrollWidth,cells:cells.map(td=>{const range=document.createRange();range.selectNodeContents(td);return {text:td.textContent,width:td.getBoundingClientRect().width,whiteSpace:getComputedStyle(td).whiteSpace,lineRects:range.getClientRects().length};})};});
for(const i of [0,1,2,3,6,7]){assert(result.cells[i].width>=72);assert.equal(result.cells[i].whiteSpace,'nowrap');assert.equal(result.cells[i].lineRects,1);}
assert(result.scrollWidth>result.hostWidth,'table scrolls inside its own host');assert(result.pageWidth<=width,'no viewport-wide overflow');console.log(JSON.stringify({width,hostWidth:result.hostWidth,scrollWidth:result.scrollWidth,compactWidths:[0,1,2,3,6,7].map(i=>result.cells[i].width)}));
await page.screenshot({path:path.resolve('docs/refactor/evidence/R34-USAGE-TABLE-'+width+'-20261109.png'),fullPage:true});await page.close();}
console.log('PASS desktop/mobile short column minimums, unbroken identifiers and contained horizontal scrolling; actual production bizTable');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});

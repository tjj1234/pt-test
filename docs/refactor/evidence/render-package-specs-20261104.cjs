// Documentation-only Mermaid renderer. See PACKAGE-SPEC-VALIDATION-20261104.md for setup.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const puppeteer=require(process.env.PUPPETEER_MODULE || 'puppeteer');
(async()=>{
 const root=path.resolve(__dirname,'../../..');
 const dir=root+'/docs/refactor';
 const out=root+'/docs/refactor/evidence/package-spec-mermaid-20261104';
 fs.mkdirSync(out,{recursive:true});
 const files=process.argv.slice(2).length?process.argv.slice(2):[...new Set([...fs.readFileSync(dir+'/PACKAGE-SPEC-INDEX-20261104.md','utf8').matchAll(/\]\(([^)#]*PACKAGE-20261103\.md)(?:#[^)]*)?\)/g)].map(x=>'docs/refactor/'+x[1]))].concat(['docs/refactor/REFACTOR-FILEEDIT-PACKAGE-20261103.md','docs/refactor/REFACTOR-SEEDANCE-PACKAGE-20261103.md','docs/refactor/ENGINEERING-DELIVERY-WORKFLOW.md']);
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 const toolVersions={mermaid:process.env.MERMAID_VERSION || 'not specified',puppeteer:require((process.env.PUPPETEER_MODULE || 'puppeteer')+'/package.json').version,chrome:await browser.version()};
 const page=await browser.newPage(); await page.setViewport({width:1600,height:1200});
 await page.setContent('<html><head><meta charset="utf-8"></head><body></body></html>');
 await page.addScriptTag({path:process.env.MERMAID_JS || require.resolve('mermaid/dist/mermaid.min.js')});
 await page.evaluate(()=>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',fontFamily:'Arial, sans-serif'}));
 const results=[];let count=0;
 try{
 for(const rel of files){const source=fs.readFileSync(path.join(root,rel),'utf8');let index=0;
 for(const match of source.matchAll(/(?:```|~~~)mermaid\s*\n([\s\S]*?)(?:```|~~~)/g)){
  index++;count++;const code=match[1],id='diagram'+count;
  try{
   const svg=await page.evaluate(async({code,id})=>(await mermaid.render(id,code)).svg,{code,id});
   if(!svg.includes('<svg'))throw Error('No SVG rendered');
   const name=path.basename(rel,'.md')+'-'+index+'.svg'; fs.writeFileSync(path.join(out,name),svg);
   results.push({source:rel,diagram:index,status:'PASS',source_sha256:crypto.createHash('sha256').update(source).digest('hex'),diagram_sha256:crypto.createHash('sha256').update(code).digest('hex'),svg:'docs/refactor/evidence/package-spec-mermaid-20261104/'+name,bytes:Buffer.byteLength(svg)});
  }catch(e){results.push({source:rel,diagram:index,status:'FAIL',error:String(e)});}
 }
 }
 }finally{await browser.close();}
 const report={generated_utc:new Date().toISOString(),renderer:'Mermaid via Puppeteer + headless Chrome',toolVersions,renderer_sha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),scope:'Documentation syntax/render verification only; no product implementation or acceptance test',total:count,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
 fs.writeFileSync(out+'/render-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,failures:results.filter(x=>x.status==='FAIL')}));if(report.failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});

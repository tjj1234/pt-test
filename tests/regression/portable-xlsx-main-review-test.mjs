import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{generatePortableXlsx}=require('../../shell/exports/portable-xlsx-candidate.cjs');
const valid={sheets:[{name:'Sheet',cells:[['literal']]}]};
test('XLSX rejects invalid resource limits and XML-invalid sheet names',()=>{
 for(const limits of [{maxBytes:NaN},{maxCells:Infinity},{unknown:1}])assert.throws(()=>generatePortableXlsx(valid,limits));
 for(const name of ['bad\0name','bad\ud800'])assert.throws(()=>generatePortableXlsx({sheets:[{name,cells:[['x']]}]}));
});
test('XLSX enforces aggregate text budget before reading following cells',()=>{
 let visited=0;const row=['x'.repeat(65)];Object.defineProperty(row,1,{enumerable:true,get(){visited++;return 'must not read';}});
 assert.throws(()=>generatePortableXlsx({sheets:[{name:'Sheet',cells:[row]}]},{maxTextBytes:64}));assert.equal(visited,0);
});
test('XLSX cannot load a same-name dependency from hostile cwd or NODE_PATH',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'xlsx-review-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const candidate=path.join(temp,'profile','candidate.cjs');fs.mkdirSync(path.dirname(candidate),{recursive:true});
 fs.copyFileSync(new URL('../../shell/exports/portable-xlsx-candidate.cjs',import.meta.url),candidate);
 const stub=path.join(temp,'hostile','shell','node_modules','fflate');fs.mkdirSync(stub,{recursive:true});
 fs.writeFileSync(path.join(stub,'package.json'),JSON.stringify({name:'fflate',version:'999.0.0',main:'index.js'}));
 fs.writeFileSync(path.join(stub,'index.js'),"module.exports={strToU8:s=>Buffer.from(s),zipSync:()=>Buffer.from('UNVERIFIED_CWD_STUB')};");
 const code=`try{require(${JSON.stringify(candidate)}).generatePortableXlsx(${JSON.stringify(valid)});process.stdout.write('UNVERIFIED_DEPENDENCY_ACCEPTED');}catch(error){process.stdout.write(error.code||'ERROR');}`;
 const result=spawnSync(process.execPath,['-e',code],{cwd:path.join(temp,'hostile'),env:{PATH:process.env.PATH,NODE_PATH:path.dirname(stub)},encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(result.stdout,'DEPENDENCY_MISSING');
});

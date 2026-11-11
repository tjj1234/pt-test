import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import {offlineAnalysisArguments} from './offline-analysis.mjs';
let runtime;
const fail=code=>Object.assign(new Error('Read-only document backend unavailable'),{code});
async function service(){if(!runtime)runtime=(async()=>{const ctx=new Context();await ctx.plugin(Subprocess);return ctx.get('subprocess');})();return runtime;}
// Only trusted prepared job files may be invoked; the model never chooses argv.
export async function runLegacyProcess({root,program,args,signal,maxBytes=1024*1024}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024)throw fail('OFFICE_LIMIT_INVALID');
 if(!['ole-safety','catdoc','xls2csv','catppt'].includes(program)||!Array.isArray(args)||args.some(x=>typeof x!=='string'||x.length>1024||x.includes('\0')))throw fail('OFFICE_INPUT_INVALID');
 const isolated=offlineAnalysisArguments({workspaceRoot:root,code:'pass'}),separator=isolated.argv.indexOf('--');
 const argv=[...isolated.argv.slice(0,separator+2),path.join(root,'bin',program),...args];
 const timeout=AbortSignal.timeout(5500),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 if(combined.aborted)throw fail('OFFICE_CANCELLED');
 const handle=(await service()).spawn({argv,cwd:root,signal:combined,graceMs:100,env:{},stdio:{stdin:'ignore',stdout:{maxBytes},stderr:{maxBytes:32768}}});
 let overflow=false;const timer=setInterval(()=>{if(handle.collected.stdout.readFrom(0).nextOffset>maxBytes||handle.collected.stderr.readFrom(0).nextOffset>32768){overflow=true;handle.terminate();}},15);
 try{const result=await handle.done;await handle.waitForExit();if(signal?.aborted)throw fail('OFFICE_CANCELLED');if(timeout.aborted)throw fail('OFFICE_TIMEOUT');if(overflow)throw fail('OFFICE_TEXT_LIMIT');const stdout=handle.collected.stdout.readFrom(0),stderr=handle.collected.stderr.readFrom(0);if(stdout.lossy||stderr.lossy)throw fail('OFFICE_TEXT_LIMIT');return {exitCode:result.exitCode,signal:result.signal,stdout:stdout.text,stderr:stderr.text};}
 finally{clearInterval(timer);handle.terminate();await handle.waitForExit();}
}

// Mechanical checks only. Product acceptance remains a separate main-agent decision.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const args=process.argv.slice(2), option=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
if(option('--verify-report')){
 const report=JSON.parse(fs.readFileSync(option('--verify-report'),'utf8'));
 if(report.status!=='MECHANICAL_PASS'||!report.checks.length||report.checks.some(check=>check.exitCode!==0)||Object.entries(report.sources).some(([file,sha])=>digest(file)!==sha))throw Error('Chain evidence failed or source binding drifted');
 console.log(JSON.stringify({status:'SOURCE_BOUND_EVIDENCE_VERIFIED',chain:report.chain,checks:report.checks.length,files:Object.keys(report.sources).length}));
}else{
 const chain=option('--chain');
 const reasoningTests=['dsh-model-info-rpc','dsh-adapter-error-frame','dsh-parent-rpc','reasoning-native-runner','reasoning-run-snapshot','conversation-model-preference','chat-request-attachments','storage-upgrade','native-tool-run-gate-sdk','f1-dsh-model-switch-identity'].map(name=>'tests/regression/'+name+'-test.mjs');
 const candidate=(name,stem)=>({sources:[name],checks:[{id:'unit',args:['--test','tests/regression/'+stem+'-test.mjs']},{id:'probe',args:['tests/probes/'+stem+'-probe.mjs']}]});
 const plans={
  reasoning:{sources:['shell/runtime/dsh-adapter.cjs','shell/persistent-runner.mjs','shell/server.cjs','shell/tenant.cjs','shell/conversations.cjs','shell/tasks/chat-request.cjs','shell/public/app.js','shell/public/index.html','shell/public/styles.css','shell/db-migrations/024_conversation_reasoning_preference.sql','shell/package-lock.json','shell/runtime/dsh-release-manifest.json',...reasoningTests,'tests/regression/ui-model-switch-test.mjs','tests/regression/reasoning-http-sdk-integration-test.mjs','tests/probes/reasoning-browser-driver-20261102.js'],checks:[{id:'boundaries',args:['--test',...reasoningTests]},{id:'ui',args:['tests/regression/ui-model-switch-test.mjs']},{id:'http-sdk',args:['--test','tests/regression/reasoning-http-sdk-integration-test.mjs'],browser:args.includes('--browser')}]},
  context:{...candidate('shell/runtime/dsh-native-context-r4-candidate.mjs','dsh-native-context-r4'),checks:[...candidate('shell/runtime/dsh-native-context-r4-candidate.mjs','dsh-native-context-r4').checks,{id:'main-regressions',args:['tests/probes/context-admission-main-review-20261102.mjs']}]},
  xlsx:{sources:['shell/exports/portable-xlsx-candidate.cjs','shell/exports/conversation-docx.cjs','shell/exports/document-export-worker.cjs','shell/tasks/csv-run-handler.cjs','shell/tasks/csv-tool-definition.cjs','shell/runtime/csv-run-artifact.cjs','shell/runtime/artifacts.cjs','shell/persistent-runner.mjs','shell/server.cjs','shell/public/app.js','tests/probes/xlsx-browser-driver-20261102.js','tests/regression/f2-csv-http-sdk-integration-test.mjs'],checks:[
    {id:'unit-review',args:['--test',...['portable-xlsx-candidate','portable-xlsx-main-review','csv-xlsx-export','conversation-docx-export','f2-csv-run-handler','f2-csv-run-artifact','artifacts','ui-artifact-preview'].map(name=>'tests/regression/'+name+'-test.mjs')]},
    {id:'probe',args:['tests/probes/portable-xlsx-candidate-probe.mjs']},
    {id:'http-sdk',args:['--test','tests/regression/xlsx-http-sdk-integration-test.mjs','tests/regression/f2-csv-http-sdk-integration-test.mjs','tests/regression/office-http-sdk-integration-test.mjs'],browser:args.includes('--browser'),browserEnvironment:'NORTHSTAR_XLSX_BROWSER'},
  ]},
  retrieval:candidate('shell/attachments/source-retrieval-candidate.cjs','source-retrieval-candidate'),
  memory:candidate('shell/memory/provenance-candidate.cjs','memory-provenance-candidate'),
  av:{sources:[],checks:[{id:'audit',args:['tests/probes/av-native-capability-audit-20261101.mjs']}]},
  skill:{sources:[],checks:[{id:'audit',args:['tests/probes/skill-loader-native-audit-20261101.mjs']}]},
 };
 const plan=plans[chain];if(!plan)throw Error('Use --chain reasoning|context|xlsx|retrieval|memory|av|skill [--browser] [--out report.json]');
 const sourcePaths=[...new Set(['scripts/northstar-chain-checks.mjs','shell/package-lock.json',...plan.sources,...plan.checks.flatMap(check=>check.args.filter(arg=>arg.endsWith('.mjs')))])].sort();
 const sources=Object.fromEntries(sourcePaths.map(file=>[file,digest(file)]));
 const out=path.resolve(option('--out')||path.join(root,'docs/refactor/evidence',chain+'-chain-checks-20261102.json'));
 const base=out.replace(/\.json$/,'');fs.mkdirSync(path.dirname(out),{recursive:true});
 const environment={...process.env};for(const key of Object.keys(environment))if(/^(PT_|POWERTOKENS|OPENAI|ANTHROPIC|AWS_)/.test(key))delete environment[key];
 const checks=[];let index=0;
 const worker=async()=>{while(index<plan.checks.length){const check=plan.checks[index++],started=Date.now(),log=base+'-'+check.id+'.txt';
  const output=fs.createWriteStream(log);const child=spawn(process.execPath,check.args,{cwd:root,env:{...environment,...(check.browser?{[check.browserEnvironment||'NORTHSTAR_REASONING_BROWSER']:'1'}:{})},stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},120000);
  const result=await new Promise(resolve=>{child.once('error',error=>resolve({exitCode:-1,error:error.code||'SPAWN_ERROR'}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  clearTimeout(timer);await new Promise(resolve=>output.end(resolve));
  checks.push({id:check.id,command:['node',...check.args],browser:check.browser===true,...result,timedOut,durationMs:Date.now()-started,log:path.relative(root,log),logSha256:crypto.createHash('sha256').update(fs.readFileSync(log)).digest('hex')});
  console.log(JSON.stringify({chain,check:check.id,exitCode:result.exitCode,timedOut}));
 }};
 await Promise.all([worker(),worker()]);
 const drift=sourcePaths.filter(file=>digest(file)!==sources[file]);
 const report={schemaVersion:1,chain,status:checks.every(check=>check.exitCode===0)&&!drift.length?'MECHANICAL_PASS':'MECHANICAL_FAIL',acceptanceDecision:'MAIN_AGENT_REQUIRED',scope:'local-controlled-fixtures; no paid provider or target deployment',baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),generatedAt:new Date().toISOString(),sources,sourceDrift:drift,checks};
 fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({chain,status:report.status,report:path.relative(root,out),sourceDrift:drift}));if(report.status!=='MECHANICAL_PASS')process.exitCode=1;
}

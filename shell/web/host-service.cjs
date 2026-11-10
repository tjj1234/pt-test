'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {fingerprint,VERSION,assertContract}=require('../contracts/phase1.cjs');
const {createTrustedHttpTransport,createDshFetchProvider,createDshSearchProvider,validateUrl}=require('../candidates/web-20261103/index.cjs');
const fail=code=>Object.assign(new Error('Trusted web request could not be verified'),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');
function readPolicy(file=process.env.PT_TRUSTED_WEB_CONFIG_FILE||path.join(__dirname,'default-policy.json')){
 try{
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768||(stat.mode&0o022))throw fail('WEB_POLICY_INVALID');
 const bytes=fs.readFileSync(file),policy=JSON.parse(bytes);
 if(policy.schemaVersion!==1||!Array.isArray(policy.trustedDomains)||!policy.trustedDomains.length||policy.trustedDomains.length>100||policy.trustedDomains.some(d=>typeof d!=='string'||!/^([a-z0-9-]+\.)+[a-z]{2,63}$/.test(d))||policy.searchEngine!=='duckduckgo'||!Number.isSafeInteger(policy.maxBytes)||policy.maxBytes<1||policy.maxBytes>131072||!Number.isSafeInteger(policy.timeoutMs)||policy.timeoutMs<1||policy.timeoutMs>15000)throw fail('WEB_POLICY_INVALID');
 return Object.freeze({...policy,trustedDomains:Object.freeze([...policy.trustedDomains]),revision:sha(bytes)});
 }catch{throw fail('WEB_POLICY_INVALID');}
}
function plain(value){return String(value).replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim();}
function parseSearch(html,domains){
 const out=[];for(const match of html.matchAll(/<a\b([^>]{0,8192})>([\s\S]*?)<\/a>/gi)){
  if(!/\bclass\s*=\s*["'][^"']*\bresult__a\b/i.test(match[1]))continue;
  const link=/\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1]);if(!link)continue;
  try{let url=new URL(link[1].replace(/&amp;/gi,'&'),'https://duckduckgo.com');if(url.hostname==='duckduckgo.com'&&url.searchParams.has('uddg'))url=new URL(url.searchParams.get('uddg'));
   if(!validateUrl(url.href,domains).ok||out.some(x=>x.url===url.href))continue;
   out.push({url:url.href,title:plain(match[2]).slice(0,500),snippet:plain(match[2]).slice(0,1000)});if(out.length===5)break;
  }catch{}
 }return out;
}
function createWebHostService({db,getPolicy=readPolicy,transportFactory=createTrustedHttpTransport}={}){
 async function owned(tx,identity,runId,owner){
  const {rows:[run]}=await tx.query('SELECT * FROM agent_runs WHERE run_id=$1 AND user_id=$2 AND tenant_id=$3 FOR UPDATE',[runId,identity.userId,identity.tenantId]);
  if(!run)throw fail('NOT_FOUND');
  if(owner!==undefined){const {rows:[lease]}=await tx.query('SELECT lease_owner,lease_expires_at>clock_timestamp() AS active FROM agent_runs WHERE run_id=$1',[runId]);if(run.state!=='running'||lease.lease_owner!==owner||!lease.active)throw fail('LEASE_LOST');}
  return run;
 }
 async function execute({identity,runId,leaseOwner,args,signal}){
  assertContract('identity',identity);
  if(!args||Object.keys(args).sort().join(',')!=='args,callId,kind,ordinal'||!['search','fetch'].includes(args.kind)||typeof args.callId!=='string'||!args.callId||args.callId.length>128||args.ordinal!==0||!args.args||typeof args.args!=='object'||Array.isArray(args.args)||Buffer.byteLength(JSON.stringify(args))>8192||!leaseOwner)throw fail('WEB_INPUT_INVALID');
  if(args.kind==='fetch'&&(Object.keys(args.args).some(k=>k!=='url')||typeof args.args.url!=='string'||args.args.url.length>4096))throw fail('WEB_INPUT_INVALID');
  if(args.kind==='search'&&(Object.keys(args.args).some(k=>!['query','maxResults'].includes(k))||typeof args.args.query!=='string'||!args.args.query.trim()||args.args.query.length>512||(args.args.maxResults!==undefined&&(!Number.isSafeInteger(args.args.maxResults)||args.args.maxResults<1||args.args.maxResults>5))))throw fail('WEB_INPUT_INVALID');
  if(signal?.aborted)throw fail('RUN_CANCELLED');
  const policy=getPolicy(),signature=fingerprint({kind:args.kind,args:args.args,policy:policy.revision}),key=[runId,args.callId,args.ordinal];
  const prior=await db.transaction(async tx=>{
   await owned(tx,identity,runId,leaseOwner);
   const {rows:[row]}=await tx.query('SELECT * FROM agent_web_calls WHERE run_id=$1 AND call_id=$2 AND ordinal=$3',key);
   if(row){if(row.signature!==signature)throw fail('WEB_CALL_CONFLICT');if(row.state!=='completed')throw fail('WEB_RECOVERY_REQUIRED');return row.result;}
   if(Number((await tx.query('SELECT count(*)::int AS count FROM agent_web_calls WHERE run_id=$1',[runId])).rows[0].count)>=8)throw fail('WEB_CALL_LIMIT');
   await tx.query("INSERT INTO agent_web_calls(run_id,call_id,ordinal,signature,lease_owner,state) VALUES($1,$2,$3,$4,$5,'reserved')",[...key,signature,leaseOwner]);return null;
  });
  if(signal?.aborted)throw fail('RUN_CANCELLED');
  if(prior)return prior.nativeResult;
  try{
   const transport=transportFactory(policy);
   const searchBackend=async({query,signal})=>{
    const sites=policy.trustedDomains.filter(d=>!['bing.com','duckduckgo.com'].includes(d)).map(d=>'site:'+d).join(' OR ');
    const page=await transport('https://duckduckgo.com/html/?q='+encodeURIComponent(query+' ('+sites+')'),{signal});
    const results=parseSearch(page.content,policy.trustedDomains);if(!results.length)throw fail('WEB_SEARCH_EMPTY');return results;
   };
   const options={...policy,provider:'northstar-trusted',transport,searchBackend,resolveContext:()=>({runId,tenantId:identity.tenantId})};
   const nativeResult=args.kind==='fetch'?await createDshFetchProvider(options).fetch(args.args,signal):await createDshSearchProvider(options).search(args.args,signal);
   if(signal?.aborted)throw fail('RUN_CANCELLED');
   if(getPolicy().revision!==policy.revision)throw fail('WEB_POLICY_CHANGED');
   if(args.kind==='fetch'&&nativeResult.statusCode!==200)throw fail('WEB_FETCH_FAILED');
   const at=new Date().toISOString(),sources=args.kind==='search'?nativeResult.sources.map(s=>({url:s.url,title:s.title||'',excerpt:s.snippet||'',evidenceType:'search_snippet',sourceSha256:sha(s.snippet||''),retrievedAt:at})): [{url:nativeResult.url||args.args.url,title:'',excerpt:nativeResult.body.content.slice(0,2000),evidenceType:'page_content',sourceSha256:sha(nativeResult.body.content),retrievedAt:at}];
   if(Buffer.byteLength(JSON.stringify({nativeResult,sources}))>262144)throw fail('WEB_RESULT_LIMIT');
   const result={nativeResult,sources,policyRevision:policy.revision};
   await db.transaction(async tx=>{
    const run=await owned(tx,identity,runId,leaseOwner);if(getPolicy().revision!==policy.revision)throw fail('WEB_POLICY_CHANGED');if(signal?.aborted)throw fail('RUN_CANCELLED');
    const updated=await tx.query("UPDATE agent_web_calls SET state='completed',result=$1::jsonb WHERE run_id=$2 AND call_id=$3 AND ordinal=$4 AND state='reserved' AND lease_owner=$5 RETURNING run_id",[JSON.stringify(result),...key,leaseOwner]);if(updated.rows.length!==1)throw fail('WEB_RECOVERY_REQUIRED');
    const event={version:VERSION,eventId:randomUUID(),runId,conversationId:run.conversation_id,seq:run.next_seq,type:'state',occurredAt:at,payload:{action:'web_sources',callId:args.callId,sources}};assertContract('event',event);
    await tx.query('INSERT INTO agent_run_events(event_id,run_id,seq,event) VALUES($1,$2,$3,$4::jsonb)',[event.eventId,runId,run.next_seq,JSON.stringify(event)]);await tx.query('UPDATE agent_runs SET next_seq=next_seq+1 WHERE run_id=$1',[runId]);
   });return nativeResult;
  }catch(error){
   await db.transaction(async tx=>{await owned(tx,identity,runId,leaseOwner);await tx.query("UPDATE agent_web_calls SET state='failed' WHERE run_id=$1 AND call_id=$2 AND ordinal=$3 AND state='reserved'",key);}).catch(()=>{});
   const code=/^(WEB_[A-Z_]+|RUN_CANCELLED|FETCH_TIMEOUT|CONTENT_TOO_LARGE|DOMAIN_NOT_TRUSTED|PRIVATE_IP_REJECTED)$/.test(error.code||'')?error.code:'WEB_REQUEST_FAILED';throw fail(code);
  }
 }
 async function list(identity,runId){return db.transaction(async tx=>{await owned(tx,identity,runId);const {rows}=await tx.query("SELECT call_id,result FROM agent_web_calls WHERE run_id=$1 AND state='completed' ORDER BY created_at,call_id LIMIT 8",[runId]);return {sources:rows.flatMap(row=>row.result.sources.map(s=>({...s,callId:row.call_id})))};});}
 return Object.freeze({execute,list});
}
module.exports={createWebHostService,readPolicy,parseSearch};

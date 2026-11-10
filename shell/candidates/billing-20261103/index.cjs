'use strict';
// Read-only account protocol adapter. No model calls, retries, exchange-rate
// inference, or automatic attribution of an account record to a local Run.
const crypto=require('node:crypto'),https=require('node:https');
const {normalizePtConsumeRecord}=require('../../usage/pt-consume-record-r2-candidate.cjs');
const sha256=value=>crypto.createHash('sha256').update(value||'').digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const timestamp=x=>typeof x==='string'&&x.length<=64&&Number.isFinite(Date.parse(x));
const boolean=x=>x===true||x==='true'?true:x===false||x==='false'?false:null;
const text=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
function isValidDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
function boundedJsonTransport({url,headers,signal,timeoutMs=10000}){
 return new Promise((resolve,reject)=>{
  let request,response,done=false,size=0;const parts=[];
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);response?.destroy();request?.destroy();error?reject(error):resolve(result);};
  const abort=()=>finish(Object.assign(Error('Cancelled'),{name:'AbortError'}));
  const timer=setTimeout(()=>finish(Object.assign(Error('Timed out'),{code:'BILLING_TIMEOUT'})),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
  try{request=https.request(url,{method:'GET',headers,agent:false},res=>{
   response=res;if(res.statusCode<200||res.statusCode>=300)return finish(null,{status:res.statusCode,data:null});
   res.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>65536)return finish(Error('Response limit'));parts.push(chunk);});
   res.on('error',()=>finish(Error('Response failure')));res.on('aborted',()=>finish(Error('Response interrupted')));
   res.on('end',()=>{try{finish(null,{status:res.statusCode,data:JSON.parse(Buffer.concat(parts).toString('utf8'))});}catch{finish(Error('Invalid JSON'));}});
  });request.on('error',()=>finish(Error('Request failed')));request.end();}catch{finish(Error('Request failed'));}
 });
}
function createBillingClient(config={}){
 const baseUrl=config.baseUrl||'https://powertokens.ai/api',transport=config.httpTransport||boundedJsonTransport;
 let base;try{base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error();}catch{throw Object.assign(Error('Invalid billing endpoint'),{code:'BILLING_CONFIG_INVALID'});}
 const timeoutMs=config.timeoutMs??10000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Object.assign(Error('Invalid billing timeout'),{code:'BILLING_CONFIG_INVALID'});
 const hasScope=runId=>text(runId)||(config.accountRead===true&&text(config.userId));
 const invalid=()=>({ok:false,code:'BILLING_PROTOCOL_INVALID'});
 async function request(endpoint,{signal,query={}}={}){
  if(!text(config.tenantId))return {ok:false,code:'CROSS_TENANT_REJECTED'};
  if(config.credentialKind!==undefined&&config.credentialKind!=='login-token')return {ok:false,code:'CREDENTIAL_KIND_REJECTED'};
  if(typeof config.token!=='string'||!config.token.trim())return {ok:false,code:'TOKEN_REQUIRED'};
  if(config.token.length>8192||/[\x00-\x1f\x7f]/.test(config.token)||/^sk-/i.test(config.token))return {ok:false,code:'CREDENTIAL_KIND_REJECTED'};
  if(signal?.aborted)return {ok:false,code:'BILLING_CANCELLED'};
  const url=new URL(base.href.replace(/\/$/,'')+endpoint);for(const [key,value]of Object.entries(query))if(value!==undefined)url.searchParams.set(key,value);
  try{
   const controller=new AbortController();let timedOut=false;const abort=()=>controller.abort(),timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);signal?.addEventListener('abort',abort,{once:true});
   let response;
   try{
    // Non-cooperative injected transports are bounded too; native transport
    // actively destroys the actual HTTPS request on this same signal.
    const interrupted=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Object.assign(Error('Cancelled'),{name:'AbortError'})),{once:true});if(signal?.aborted)controller.abort();});
    response=await Promise.race([Promise.resolve().then(()=>transport({url:url.href,method:'GET',headers:{Authorization:config.token,Accept:'application/json'},signal:controller.signal,timeoutMs})),interrupted]);
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
   if(signal?.aborted)return {ok:false,code:'BILLING_CANCELLED'};
   if(!Number.isInteger(response?.status))return invalid();
   const codes={401:'AUTH_UNAUTHORIZED',402:'PAYMENT_REQUIRED',403:'AUTH_FORBIDDEN',429:'RATE_LIMIT_EXCEEDED'};
   if(response.status<200||response.status>=300)return {ok:false,code:codes[response.status]||(response.status>=500?'SERVER_ERROR':'HTTP_ERROR'),httpStatus:response.status};
   const body=response.data;if(!object(body)||body.code!==200||!object(body.data))return invalid();
   return {ok:true,data:body.data};
  }catch(error){return {ok:false,code:signal?.aborted?'BILLING_CANCELLED':error.code==='BILLING_TIMEOUT'?'BILLING_TIMEOUT':error.name==='AbortError'?'BILLING_TIMEOUT':'TRANSPORT_ERROR'};}
 }
 async function getAgreementStatus({runId,signal}={}){
  if(!hasScope(runId))return {ok:false,code:'INVALID_INPUT'};const r=await request('/v1/asset/agreement/status',{signal});if(!r.ok)return r;
  const agreementAccepted=boolean(r.data.agreement_accepted),assetLibraryEnabled=boolean(r.data.asset_library_enabled);if(agreementAccepted===null||assetLibraryEnabled===null||!text(r.data.account_id))return invalid();
  return {ok:true,accountId:r.data.account_id,agreementAccepted,assetLibraryEnabled,queryAt:Date.now()};
 }
 async function getBalance({runId,signal}={}){
  if(!hasScope(runId))return {ok:false,code:'INVALID_INPUT'};const r=await request('/v1/billing/balance',{signal});if(!r.ok)return r;
  const d=r.data,isCached=boolean(d.is_cached);if(!integer(d.balance)||d.currency!=='credits'||!text(d.key_id)||isCached===null||!timestamp(d.data_as_of)||(d.cache_ttl_seconds!=null&&!integer(d.cache_ttl_seconds)))return invalid();
  return {ok:true,balance:d.balance,currency:'credits',keyId:d.key_id,isCached,dataAsOf:d.data_as_of,cacheTtlSeconds:d.cache_ttl_seconds??null,updatedAt:timestamp(d.updated_at)?d.updated_at:null,queryAt:Date.now(),forceFreshSupported:false};
 }
 async function getUsageSummary({runId,startDate,endDate,signal}={}){
  if(!hasScope(runId))return {ok:false,code:'INVALID_INPUT'};if((startDate!==undefined&&!isValidDate(startDate))||(endDate!==undefined&&!isValidDate(endDate))||(startDate&&endDate&&startDate>endDate))return {ok:false,code:'DATE_RANGE_INVALID'};
  const r=await request('/v1/billing/usage',{signal,query:{start_date:startDate,end_date:endDate}});if(!r.ok)return r;const d=r.data;
  if(d.currency!=='credits'||!integer(d.total_cost)||!text(d.key_id)||!timestamp(d.data_as_of)||!isValidDate(d.period_start)||!isValidDate(d.period_end)||d.period_start>d.period_end||!Array.isArray(d.items)||d.items.length>1000)return invalid();
  const seen=new Set(),items=[];let sum=0;for(const item of d.items){if(!object(item)||!text(item.model)||!['text','image','video','audio'].includes(item.model_type)||!integer(item.total_cost))return invalid();const key=JSON.stringify([item.model,item.model_type]);if(seen.has(key))return {ok:false,code:'BILLING_DUPLICATE_ITEM'};seen.add(key);sum+=item.total_cost;if(!Number.isSafeInteger(sum))return invalid();items.push({modelId:item.model,modelType:item.model_type,totalQuota:item.total_cost,requestCount:null});}
  return {ok:true,currency:'credits',keyId:d.key_id,dataAsOf:d.data_as_of,periodStart:d.period_start,periodEnd:d.period_end,totalQuota:d.total_cost,items,itemsTotalMatches:sum===d.total_cost,periodMatches:(!startDate||startDate===d.period_start)&&(!endDate||endDate===d.period_end),coverage:'account-period-summary',runCorrelation:'unknown',reconciled:false,exchangeRate:null};
 }
 async function getConsumeLog({runId,consumeId,expectedRequestId,expectedTaskId,signal}={}){
  if(!hasScope(runId))return {ok:false,code:'INVALID_INPUT'};const r=await request('/v1/logs/query',{signal});if(!r.ok)return r;
  let record;try{record=normalizePtConsumeRecord(r.data);}catch{return invalid();}
  if(consumeId&&record.consumeId!==consumeId)return {ok:false,code:'RECORD_NOT_FOUND',status:'unknown'};
  const matched=!!((expectedRequestId&&record.requestId===expectedRequestId)||(expectedTaskId&&record.taskId===expectedTaskId));
  return {ok:true,consumeId:record.consumeId,requestId:record.requestId,modelId:record.reportedModelId,status:record.status,consumeTime:record.consumedAt,quota:record.billing.finalQuota,inputTokens:record.usage.inputTokens,outputTokens:record.usage.outputTokens,formula:record.billing.formula,record,reconciled:matched&&record.status==='success',runCorrelation:matched?'matched':'unknown',exchangeRate:null};
 }
 return Object.freeze({getAgreementStatus,getBalance,getUsageSummary,getConsumeLog,sha256});
}
module.exports={createBillingClient,isValidDate,sha256,boundedJsonTransport};

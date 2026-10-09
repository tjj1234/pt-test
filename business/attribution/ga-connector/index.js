"use strict";
const crypto = require('node:crypto');
const {PERMISSIONS} = require('../../../shell/permissions/index.cjs');
const {createGoogleClient, SCOPE, fail} = require('./client');
const {createGaStore} = require('./store');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const nameSchema = {type:'array',minItems:1,maxItems:10,uniqueItems:true,items:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_:]*$'}};
const inputSchema = {type:'object',additionalProperties:false,required:['metrics','dateRange'],properties:{metrics:nameSchema,dimensions:{...nameSchema,minItems:0,maxItems:9},dateRange:{type:'object',additionalProperties:false,required:['startDate','endDate'],properties:{startDate:{type:'string'},endDate:{type:'string'}}},format:{type:'string',enum:['summary','table']}}};
function gaQueryToolDefinition() {
 return {name:'ga.query',type:'workflow',version:'1.0.0',description:'查询已授权 GA4 property 的真实指标。metrics/dimensions 使用 GA4 API 名称；dateRange 使用 YYYY-MM-DD、today、yesterday 或 NdaysAgo；用户要求整理成表格时设置 format=table。',inputSchema,outputType:'report',riskLevel:'read',requiredPermissions:[PERMISSIONS.TOOL_USE,PERMISSIONS.ATTRIBUTION_READ],requiredCredentials:['google-analytics:readonly']};
}
function validateArgs(a) {
 if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k=>!['metrics','dimensions','dateRange','format'].includes(k))) throw fail('INVALID_QUERY');
 for (const [k,max,min] of [['metrics',10,1],['dimensions',9,0]]) {
  const v=a[k]; if (k==='dimensions' && v===undefined) continue;
  if (!Array.isArray(v)||v.length<min||v.length>max||new Set(v).size!==v.length||v.some(n=>typeof n!=='string'||! /^[A-Za-z][A-Za-z0-9_:]*$/.test(n))) throw fail('INVALID_QUERY');
 }
 const d=a.dateRange;
 const date=x=> typeof x==='string' && (/^(today|yesterday|\d{1,5}daysAgo)$/.test(x)||(/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x));
 if (!d||Object.keys(d).some(k=>!['startDate','endDate'].includes(k))||!date(d.startDate)||!date(d.endDate)|| (a.format!==undefined&&!['summary','table'].includes(a.format))) throw fail('INVALID_QUERY');
 if (/^\d{4}-/.test(d.startDate)&&/^\d{4}-/.test(d.endDate)&&d.startDate>d.endDate) throw fail('INVALID_QUERY');
 return a;
}
function createGaConnector({store,google,now=Date.now}) {
 return {
  async authorize(t,cookie,property) {
   if (typeof property!=='string'||!/^\d+$/.test(property)) throw fail('GA_PROPERTY_REQUIRED');
   if (!cookie) throw fail('LOGIN_SESSION_REQUIRED',401);
   const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url');
   await store.putState(t,{hash:hash(state),session:hash(cookie),property,verifier,expires:new Date(now()+600000).toISOString()});
   return google.authorize(state,crypto.createHash('sha256').update(verifier).digest('base64url'));
  },
  async callback(t,cookie,q) {
   if (!cookie||typeof q.state!=='string'||q.state.length>256) throw fail('INVALID_OAUTH_STATE');
   const s=await store.consumeState(t,hash(q.state),hash(cookie));
   if (!s) throw fail('INVALID_OAUTH_STATE');
   if (q.error) throw fail('OAUTH_DENIED');
   if (typeof q.code!=='string'||!q.code||q.code.length>4096) throw fail('INVALID_OAUTH_CODE');
   const token=await google.exchange(q.code,s.verifier);
   if (!token.refresh_token) throw fail('GOOGLE_REFRESH_TOKEN_REQUIRED',502);
   if (typeof token.scope!=='string'||!token.scope.split(' ').includes(SCOPE)) throw fail('GOOGLE_SCOPE_REQUIRED',502);
   await store.save(t,s.property_id,token.refresh_token);
   return {ok:true,propertyId:s.property_id};
  },
  async query(t,args) {
   const a=validateArgs(args),connection=await store.get(t);
   if (!connection) throw fail('GA_AUTHORIZATION_REQUIRED',409);
   const token=await google.refresh(connection.refreshToken);
   const r=await google.runReport(connection.property,token.access_token,{metrics:a.metrics.map(name=>({name})),dimensions:(a.dimensions||[]).map(name=>({name})),dateRanges:[a.dateRange],limit:'10000'});
   const head=[...(r.dimensionHeaders||[]),...(r.metricHeaders||[])].map(h=>h.name);
   if (head.join('\0')!==[...(a.dimensions||[]),...a.metrics].join('\0')) throw fail('GOOGLE_BAD_RESPONSE',502);
   const rows=(r.rows||[]).map(row=>[...(row.dimensionValues||[]),...(row.metricValues||[])].map(v=>v.value));
   if (rows.some(row=>row.length!==head.length||row.some(v=>typeof v!=='string'))) throw fail('GOOGLE_BAD_RESPONSE',502);
   const report={title:'Google Analytics 4 查询',meta:`property ${connection.property} · ${a.dateRange.startDate} ~ ${a.dateRange.endDate} · 时区 ${r.metadata?.timeZone||'未返回'} · 返回 ${rows.length}/${r.rowCount||0} 行`,stats:[['数据源','Google Analytics Data API'],['结果',rows.length?'有数据':'无数据'],['总行数',r.rowCount||0],['返回行数',rows.length],['截断',(r.rowCount||0)>rows.length?'是（仅前 10000 行）':'否'],['元数据',JSON.stringify(r.metadata||{})]]};
   if (a.format==='table'&&rows.length) report.table={title:'GA4 数据',head,rows};
   if (a.format!=='table') {
    for (const row of rows) report.stats.push([row.slice(0,(a.dimensions||[]).length).join(' / ')||'指标',a.metrics.map((m,i)=>`${m}: ${row[(a.dimensions||[]).length+i]}`).join(' · ')]);
   }
   return report;
  }
 };
}
function connectorFromEnv(pool,env=process.env) {
 if (!env.GA_CLIENT_ID||!env.GA_CLIENT_SECRET||!env.GA_REDIRECT_URI||!env.GA_TOKEN_ENCRYPTION_KEY) throw fail('GA_NOT_CONFIGURED',503);
 const u=new URL(env.GA_REDIRECT_URI);
 if (u.pathname!=='/api/business/ga-connector/oauth/callback'||u.search||u.hash||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))) throw fail('GA_INVALID_REDIRECT_URI',503);
 return createGaConnector({store:createGaStore({pool,key:Buffer.from(env.GA_TOKEN_ENCRYPTION_KEY,'base64')}),google:createGoogleClient({clientId:env.GA_CLIENT_ID,clientSecret:env.GA_CLIENT_SECRET,redirectUri:env.GA_REDIRECT_URI})});
}
module.exports={gaQueryToolDefinition,inputSchema,createGaConnector,connectorFromEnv,validateArgs,...require('./executor')};

"use strict";
const {isUuid} = require('../collect/validate');
const {connectorFromEnv} = require('../../../business/attribution/ga-connector');
const {readGaConnectionStatus,deleteGaConnection} = require('../../../business/attribution/ga-connector/store');
function registerGaConnectorRoutes(app,opts) {
 let connector=opts.gaConnector;
 const getConnector=()=>connector||(connector=connectorFromEnv(opts.pool));
 async function handle(req,reply,fn,needsConnector=true) {
  reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
  try {
   const raw=opts.parseAuthorization(req.headers.authorization);
   if (!raw) return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
   const auth=await opts.verifyAnalyticsToken(raw);
   if (!auth||!auth.scopes?.includes('analytics:read')||!isUuid(auth.tenant_id)) return reply.code(403).send({error:{code:'FORBIDDEN'}});
   if (auth.expires_at!=null&&auth.expires_at<= (opts.now||Date.now)()) return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
   return await fn(needsConnector ? getConnector() : null,auth.tenant_id);
  } catch(e) {
   // Never log OAuth code, URL, tokens, cookies or Google response bodies.
   req.log.warn({code:e.code||'GA_INTERNAL_ERROR'},'ga connector failed');
   return reply.code(e.statusCode||500).send({error:{code:e.code||'GA_INTERNAL_ERROR'}});
  }
 }
 app.get('/api/business/ga-connector/status',(req,reply)=>handle(req,reply,(_,t)=>readGaConnectionStatus(opts.pool,t),false));
 app.delete('/api/business/ga-connector/connection',(req,reply)=>handle(req,reply,(_,t)=>deleteGaConnection(opts.pool,t),false));
 app.get('/api/business/ga-connector/oauth/authorize',{logLevel:'silent'},(req,reply)=>handle(req,reply,async(c,t)=>reply.redirect(await c.authorize(t,req.headers.cookie,req.query.propertyId))));
 app.get('/api/business/ga-connector/oauth/callback',{logLevel:'silent'},(req,reply)=>handle(req,reply,async(c,t)=>{
  const result=await c.callback(t,req.headers.cookie,req.query);
  // Browser OAuth returns to settings; API clients retain the JSON contract.
  return req.headers.accept?.includes('text/html') ? reply.redirect('/settings') : result;
 }));
 app.post('/api/business/ga-connector/query',(req,reply)=>handle(req,reply,async(c,t)=>{
  const result=await c.query(t,req.body);
  req.log.info({tenant_id:t,stats:result.stats.slice(0,5)},'ga runReport succeeded');
  return result;
 }));
}
module.exports={registerGaConnectorRoutes};

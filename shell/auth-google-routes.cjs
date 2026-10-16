'use strict';
/** Isolated Node HTTP adapter. Composition must mount before legacy auth routes and retire
 * password endpoints separately. No trust in Host/X-Forwarded-* or callback identity fields.
 * getClientKey/authFactory are trusted server composition seams, never request parameters.
 */
const crypto=require('node:crypto');
const {createGoogleAuth,readConfig}=require('./auth-google.cjs');
const {createRateLimiter}=require('./ratelimit.cjs');
const START='/api/auth/google/start',CALLBACK='/api/auth/google/callback',STATUS='/api/auth/google/status';
const SESSION_COOKIE='pt_session'; // Existing auth.getSession/server cookie contract.
const FAILURE='/login?error=google_auth';
const safeToken=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(v);
function cookie(req,name){
 const header=req.headers?.cookie;
 if(typeof header!=='string'||header.length>16384)return null;
 const values=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
 if(values.length!==1)return null;
 try{const value=decodeURIComponent(values[0].slice(name.length+1));return safeToken(value)?value:null;}catch{return null;}
}
async function createGoogleAuthRoutes({db,config=process.env,fetchImpl=globalThis.fetch,now=Date.now,authFactory=createGoogleAuth,getClientKey=req=>req.socket?.remoteAddress||'unknown',onAuthenticated=async()=>{},rateLimit=10}={}){
 if(!Number.isInteger(rateLimit)||rateLimit<1||rateLimit>1000)throw new TypeError('Invalid OAuth route rate limit');
 let auth,cfg,configured=false;
 try{
  cfg=readConfig(config);
  const redirect=new URL(cfg.redirectUri);
  if(redirect.pathname!==CALLBACK||redirect.search)throw new Error('callback configuration mismatch');
  auth=await authFactory({db,config,fetchImpl,now});configured=true;
 }catch{/* Missing config/dependencies must never fall back to password/shared credentials. */}
 const secure=!!cfg&&new URL(cfg.redirectUri).protocol==='https:';
 const bindingName=secure?'__Host-pt_google_binding':'pt_google_binding';
 const limiter=createRateLimiter({windowMs:60000,max:rateLimit});
 const attributes='; HttpOnly; SameSite=Lax; Path=/'+(secure?'; Secure':'');
 function headers(res){res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');}
 function json(res,status,code){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({ok:false,code,error:'Google 登录未完成，请重新登录'}));}
 function redirect(res,target){res.statusCode=303;res.setHeader('Location',target);res.end();}
 async function handle(req,res){
  let url;try{if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))return false;url=new URL(req.url,'http://route.invalid');}catch{return false;}
  if(![START,CALLBACK,STATUS].includes(url.pathname))return false;
  headers(res);
  if(url.pathname===STATUS){if(req.method!=='GET'){res.setHeader('Allow','GET');json(res,405,'METHOD_NOT_ALLOWED');return true;}res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({ok:true,configured}));return true;}
  if(req.method!=='GET'){res.setHeader('Allow','GET');json(res,405,'METHOD_NOT_ALLOWED');return true;}
  if(!configured){json(res,503,'GOOGLE_AUTH_UNAVAILABLE');return true;}
  try{
   const clientKey=getClientKey(req);
   if(typeof clientKey!=='string'||clientKey.length>256||!limiter.allow(clientKey+':'+url.pathname)){res.setHeader('Retry-After','60');json(res,429,'RATE_LIMITED');return true;}
   if(url.pathname===START){
    const origin=req.headers?.origin;
    if((origin!==undefined&&origin!==new URL(cfg.redirectUri).origin)||req.headers?.['sec-fetch-site']==='cross-site'){json(res,403,'ORIGIN_REJECTED');return true;}
    const binding=cookie(req,bindingName)||crypto.randomBytes(32).toString('base64url');
    const result=await auth.begin({browserSessionId:binding});
    const destination=new URL(result.authorizationUrl);
    if(destination.origin!=='https://accounts.google.com'||destination.pathname!=='/o/oauth2/v2/auth')throw new Error('Invalid authorization destination');
    res.setHeader('Set-Cookie',bindingName+'='+binding+'; Max-Age=600'+attributes);
    redirect(res,destination.href);return true;
   }
   // Google callback is a cross-site top-level GET. DB state + browser cookie are the CSRF boundary.
   if(req.url.length>16384||['state','code','error'].some(k=>url.searchParams.getAll(k).length>1)){redirect(res,FAILURE);return true;}
   const binding=cookie(req,bindingName);
   if(!binding){redirect(res,FAILURE);return true;}
   const result=await auth.callback({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error'),browserSessionId:binding});
   if(!result?.ok||!safeToken(result.token)){redirect(res,FAILURE);return true;}
   const expiry=Date.parse(result.expiresAt);
   if(!Number.isFinite(expiry)||expiry<=now())throw new Error('Invalid session expiry');
   // Provision the product workspace before revealing the session cookie.
   await onAuthenticated(result);
   res.setHeader('Set-Cookie',SESSION_COOKIE+'='+result.token+'; Expires='+new Date(expiry).toUTCString()+attributes);
   redirect(res,'/');return true;
  }catch{if(url.pathname===CALLBACK)redirect(res,FAILURE);else json(res,503,'GOOGLE_AUTH_UNAVAILABLE');return true;}
 }
 return {handle,configured,paths:Object.freeze({start:START,callback:CALLBACK,status:STATUS}),sessionCookieName:SESSION_COOKIE};
}
module.exports={createGoogleAuthRoutes};

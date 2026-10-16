'use strict';
const crypto = require('node:crypto');
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUER = 'https://accounts.google.com';
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
class GoogleAuthError extends Error { constructor(code) { super('Google 登录未完成，请重新登录'); this.code=code; } }
function readConfig(input = process.env) {
  const clientId=input.GOOGLE_CLIENT_ID,clientSecret=input.GOOGLE_CLIENT_SECRET,redirectUri=input.GOOGLE_REDIRECT_URI;
  let url;try {url=new URL(redirectUri);}catch {throw new GoogleAuthError('GOOGLE_NOT_CONFIGURED');}
  if(!clientId || !clientSecret || !redirectUri || url.username || url.password || url.hash || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new GoogleAuthError('GOOGLE_NOT_CONFIGURED');
  return {clientId,clientSecret,redirectUri};
}
/** Server-only module. HTTP caller owns Secure/HttpOnly browser-binding cookie and CSRF/origin/rate limits.
 * No supplied URL, tenant, role, userId or returnTo is accepted by callback.
 * fetchImpl is a trusted composition seam, never an HTTP request field.
 */
async function createGoogleAuth({db,config=process.env,fetchImpl=globalThis.fetch,now=Date.now,stateTtlMs=300000,sessionTtlMs=604800000}={}) {
  if(!db || typeof db.transaction!=='function')throw new GoogleAuthError('GOOGLE_STORAGE_REQUIRED');
  const cfg=readConfig(config);
  const {jwtVerify,createRemoteJWKSet,customFetch}=await import('jose');
  const jwks=createRemoteJWKSet(new URL(JWKS_URL),{[customFetch]:fetchImpl,timeoutDuration:10000});
  const failure=code=>({ok:false,code,error:'Google 登录未完成，请重新登录'});
  const binding=value=> typeof value==='string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
  async function begin({browserSessionId}={}) {
    if(!binding(browserSessionId))throw new GoogleAuthError('BROWSER_BINDING_REQUIRED');
    const state=random(),nonce=random(),verifier=random(),expiresAt=new Date(now()+stateTtlMs).toISOString();
    await db.query('DELETE FROM google_oauth_states WHERE expires_at <= $1',[new Date(now()).toISOString()]);
    await db.query('INSERT INTO google_oauth_states(state_hash,browser_hash,nonce,code_verifier,expires_at) VALUES ($1,$2,$3,$4,$5)',[sha(state),sha(browserSessionId),nonce,verifier,expiresAt]);
    const u=new URL(AUTHORIZATION_URL);
    for(const [k,v] of Object.entries({client_id:cfg.clientId,redirect_uri:cfg.redirectUri,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))u.searchParams.set(k,v);
    return {authorizationUrl:u.href,state,expiresAt};
  }
  async function createSession(tx,user) {
    const token=random(),expiresAt=new Date(now()+sessionTtlMs).toISOString();
    await tx.query('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,$3)',[user.id,sha(token),expiresAt]);
    const t=await tx.query('SELECT id,name FROM tenants WHERE id=$1',[user.tenant_id]);
    return {ok:true,token,user:{id:user.id,username:user.username,email:user.email,role:user.role,tenant_id:user.tenant_id},tenant:t.rows[0],expiresAt};
  }
  async function resolveIdentity(payload) {
    const issuer=ISSUER,subject=payload.sub,email=payload.email.toLowerCase();
    for(let attempt=0;attempt<2;attempt++) {
      try {return await db.transaction(async tx=>{
        const found=await tx.query('SELECT u.id,u.username,u.email,u.role,u.tenant_id FROM google_identities g JOIN users u ON u.id=g.user_id WHERE g.issuer=$1 AND g.subject=$2',[issuer,subject]);
        if(found.rows.length)return createSession(tx,found.rows[0]);
        const collision=await tx.query('SELECT id FROM users WHERE lower(email)=$1',[email]);
        if(collision.rows.length)throw new GoogleAuthError('IDENTITY_BINDING_REQUIRED');
        const username='google_'+crypto.randomUUID().replaceAll('-','');
        const t=await tx.query('INSERT INTO tenants(name) VALUES ($1) RETURNING id',[email]);
        const u=await tx.query('INSERT INTO users(tenant_id,username,email,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,email,role,tenant_id',[t.rows[0].id,username,email,'!google-only:'+random(),'admin']);
        await tx.query('INSERT INTO google_identities(issuer,subject,user_id,email) VALUES ($1,$2,$3,$4)',[issuer,subject,u.rows[0].id,email]);
        return createSession(tx,u.rows[0]);
      });}catch(e) {if(e.code==='23505' && attempt===0)continue;throw e;}
    }
  }
  async function callback({state,code,error,browserSessionId}={}) {
    if(!binding(browserSessionId)||typeof state!=='string'||state.length>256)return failure('INVALID_OAUTH_STATE');
    let record;
    try {
      const consumed=await db.query('DELETE FROM google_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 RETURNING nonce,code_verifier',[sha(state),sha(browserSessionId),new Date(now()).toISOString()]);
      record=consumed.rows[0];
      if(!record)return failure('INVALID_OAUTH_STATE');
      if(error)return failure('GOOGLE_AUTH_DENIED');
      if(typeof code!=='string'||!code||code.length>8192)return failure('INVALID_AUTHORIZATION_CODE');
      const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:cfg.clientId,client_secret:cfg.clientSecret,redirect_uri:cfg.redirectUri,grant_type:'authorization_code',code_verifier:record.code_verifier}),redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok)return failure('GOOGLE_TOKEN_EXCHANGE_FAILED');
      const body=await response.json();
      if(typeof body.id_token!=='string'||body.id_token.length>32768)return failure('GOOGLE_TOKEN_INVALID');
      const {payload}=await jwtVerify(body.id_token,jwks,{algorithms:['RS256'],issuer:[ISSUER,'accounts.google.com'],audience:cfg.clientId,requiredClaims:['iss','sub','aud','exp','iat','nonce','email','email_verified'],currentDate:new Date(now()),clockTolerance:30});
      if(!equal(payload.nonce,record.nonce)||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255||payload.email_verified!==true||typeof payload.email!=='string'||payload.email.length>254||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)||(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==cfg.clientId)||(payload.azp!=null&&payload.azp!==cfg.clientId))return failure('GOOGLE_TOKEN_INVALID');
      return await resolveIdentity(payload);
    }catch(e) {
      if(e instanceof GoogleAuthError)return failure(e.code);
      if(e.code==='23505')return failure('IDENTITY_BINDING_REQUIRED');
      return failure(record?'GOOGLE_AUTH_FAILED':'GOOGLE_STORAGE_UNAVAILABLE');
    }
  }
  /** TRUSTED server migration capability ONLY. Caller must independently verify ownership and approval.
   * Never expose as a public route or accept userId from callback/request parameters.
   */
  async function bindIdentity({issuer,subject,userId,email,approvedBy}={}) {
    if(![ISSUER,'accounts.google.com'].includes(issuer)||typeof subject!=='string'||!subject||subject.length>255||typeof email!=='string'||!email||typeof approvedBy!=='string'||!approvedBy.trim())throw new GoogleAuthError('INVALID_TRUSTED_BINDING');
    return db.transaction(async tx=>{
      const user=await tx.query('SELECT id FROM users WHERE id=$1',[userId]);
      if(!user.rows.length)throw new GoogleAuthError('BINDING_USER_NOT_FOUND');
      await tx.query('INSERT INTO google_identities(issuer,subject,user_id,email,binding_approved_by) VALUES ($1,$2,$3,$4,$5)',[ISSUER,subject,userId,email.toLowerCase(),approvedBy]);
      // A trusted binding changes the authentication authority for this account.
      // Revoke legacy sessions atomically so a previously issued password cookie
      // cannot continue to authenticate after the account is migrated.
      await tx.query('DELETE FROM sessions WHERE user_id=$1',[userId]);
      return {ok:true,userId};
    });
  }
  return {begin,callback,bindIdentity};
}
module.exports={createGoogleAuth,readConfig,GoogleAuthError,AUTHORIZATION_URL,TOKEN_URL,JWKS_URL,ISSUER};

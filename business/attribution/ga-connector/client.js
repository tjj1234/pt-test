"use strict";
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
function fail(code, statusCode = 400) { return Object.assign(new Error(code), {code,statusCode}); }
function createGoogleClient({clientId,clientSecret,redirectUri,fetchImpl=globalThis.fetch}) {
 async function request(url, options) {
  let response;
  try { response = await fetchImpl(url, {...options, signal:AbortSignal.timeout(20000)}); }
  catch (_) { throw fail('GOOGLE_UNAVAILABLE',502); }
  let body; try { body = await response.json(); } catch (_) { throw fail('GOOGLE_BAD_RESPONSE',502); }
  if (!response.ok) throw fail(body.error === 'invalid_grant' ? 'GA_REAUTHORIZE_REQUIRED' : 'GOOGLE_REQUEST_FAILED', response.status===429 ? 429 : 502);
  return body;
 }
 async function token(params) {
  const body = await request('https://oauth2.googleapis.com/token', {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,...params}).toString()});
  if (!body.access_token) throw fail('GOOGLE_BAD_RESPONSE',502);
  return body;
 }
 return {
  authorize(state,challenge) {
   const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
   u.search = new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString(); return u.href;
  },
  exchange(code,verifier) { return token({code,code_verifier:verifier,redirect_uri:redirectUri,grant_type:'authorization_code'}); },
  refresh(refreshToken) { return token({refresh_token:refreshToken,grant_type:'refresh_token'}); },
  runReport(property,accessToken,body) { return request(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,{method:'POST',headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify(body)}); }
 };
}
module.exports = {createGoogleClient,SCOPE,fail};

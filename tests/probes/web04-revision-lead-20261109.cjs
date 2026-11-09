'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.WEB04_REVIEW_ROOT;if(!root)throw Error('WEB04_REVIEW_ROOT required');
const {createWebResearcher,validateUrl,isPrivateIp,createDshFetchProvider}=require(path.join(root,'shell/candidates/web-20261103/index.cjs'));
(async()=>{
 for(const ip of ['fc01::1','fd12::1','fe90::1','::ffff:7f00:1'])console.log(JSON.stringify({case:'privateAddressClassification',ip,blocked:isPrivateIp(ip)}));
 console.log(JSON.stringify({case:'bracketedIPv6Loopback',result:validateUrl('https://[::1]/',['[::1]'])}));
 const widened=createWebResearcher({trustedDomains:['safe.example'],customFetcher:async()=>({content:'fixture'})});
 console.log(JSON.stringify({case:'NaNMaxBytes',result:await widened.fetchPage({runId:'r',tenantId:'t',url:'https://safe.example',maxBytes:NaN})}));
 const redirected=createWebResearcher({trustedDomains:['safe.example'],ctx:{web:{fetch:async()=>({url:'https://127.0.0.1/private',statusCode:200,body:{content:'private fixture'}})}}});
 console.log(JSON.stringify({case:'ctxFinalPrivateURL',result:await redirected.fetchPage({runId:'r',tenantId:'t',url:'https://safe.example'})}));
 let release;const controller=new AbortController();const wait=createWebResearcher({trustedDomains:['safe.example'],customFetcher:()=>new Promise(r=>release=r)});
 const request=wait.fetchPage({runId:'r',tenantId:'t',url:'https://safe.example',timeoutMs:5,signal:controller.signal});await new Promise(r=>setTimeout(r,5));controller.abort();
 const early=await Promise.race([request.then(()=> 'SETTLED'),new Promise(r=>setTimeout(()=>r('STILL_PENDING_AFTER_ABORT'),40))]);console.log(JSON.stringify({case:'nonCooperativeFetcherCancellation',result:early}));release({content:'fixture'});await request;
 let finish;const search=createWebResearcher({trustedDomains:['safe.example'],searchBackend:()=>new Promise(r=>finish=r)});const pending=search.search('fixture',{runId:'r',tenantId:'t',timeoutMs:5});
 console.log(JSON.stringify({case:'backendTimeout',result:await Promise.race([pending.then(()=> 'SETTLED'),new Promise(r=>setTimeout(()=>r('STILL_PENDING_AFTER_DEADLINE'),40))])}));finish([]);await pending;
 console.log('ZERO_NETWORK_CALLS; synthetic boundary probes against exact author module');
})().catch(e=>{console.error(e);process.exitCode=1});

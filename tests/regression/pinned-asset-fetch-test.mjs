import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPinnedAssetFetch,isPublicAssetIpv4}=require('../../shell/media/pinned-asset-fetch.cjs');
const options=()=>({method:'GET',redirect:'manual',signal:new AbortController().signal});
const url='https://cdn.example.test/asset.png?token=PRIVATE_SENTINEL';
test('conservative public address policy rejects private, special, alternate encodings and IPv6',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.1.2','172.31.255.255','192.168.0.1','169.254.169.254','100.64.0.1','100.127.255.255','192.0.0.9','192.0.2.1','198.18.1.2','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','0.1.2.3','2130706433','0177.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(isPublicAssetIpv4(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','172.15.255.255','172.32.0.0','100.63.255.255','100.128.0.0'])assert.equal(isPublicAssetIpv4(ip),true,ip);
});
test('DNS is resolved once; request connection is pinned while TLS verifies the original hostname',async()=>{
 let resolutions=0,requests=0;
 const fetch=createPinnedAssetFetch({allowedHosts:['cdn.example.test'],lookup:async(hostname,opts)=>{resolutions++;assert.equal(hostname,'cdn.example.test');assert.equal(opts.family,4);return [{address:'8.8.8.8',family:4}];},request:(target,opts,respond)=>{
  requests++;assert.equal(target.hostname,'cdn.example.test');assert.equal(opts.servername,'cdn.example.test');assert.equal(opts.rejectUnauthorized,true);assert.equal(opts.agent,false);assert.equal(opts.headers.Authorization,undefined);assert.equal(opts.headers.Cookie,undefined);
  const req=new EventEmitter();req.end=()=>{opts.lookup(target.hostname,{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'image/png'};respond(response);response.end(Buffer.from('fixture'));});};return req;
 }});
 const response=await fetch(url,options());assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(await new Response(response.body).text(),'fixture');assert.equal(resolutions,1);assert.equal(requests,1);
});
test('mixed public/private DNS results deny before any network request',async()=>{
 let requests=0;
 const fetch=createPinnedAssetFetch({allowedHosts:['cdn.example.test'],lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:()=>{requests++;}});
 await assert.rejects(fetch(url,options()),{code:'MEDIA_ASSET_ADDRESS_DENIED'});assert.equal(requests,0);
});
test('credentials, nonstandard ports, host changes and caller headers reject before DNS',async()=>{
 let calls=0;const fetch=createPinnedAssetFetch({allowedHosts:['cdn.example.test'],lookup:async()=>{calls++;}});
 for(const target of ['https://user:pass@cdn.example.test/a','https://cdn.example.test:8443/a','http://cdn.example.test/a','https://other.example.test/a'])await assert.rejects(fetch(target,options()));
 await assert.rejects(fetch(url,{...options(),headers:{Authorization:'PRIVATE_SENTINEL'}}));assert.equal(calls,0);
});
test('uncooperative DNS is time bounded and all errors omit the original signed URL',async()=>{
 for(const lookup of [async()=>{throw Error('PRIVATE_SENTINEL');},async()=>new Promise(()=>{})]){
  const fetch=createPinnedAssetFetch({allowedHosts:['cdn.example.test'],lookup,dnsTimeoutMs:10});
  await assert.rejects(fetch(url,options()),error=>{assert.ok(['MEDIA_ASSET_DNS_UNAVAILABLE','MEDIA_ASSET_DNS_TIMEOUT'].includes(error.code));assert.equal(error.message.includes('PRIVATE_SENTINEL'),false);assert.equal(error.cause,undefined);return true;});
 }
});
test('cancellation during DNS causes no late connection',async()=>{
 let complete,requests=0;const pending=new Promise(resolve=>complete=resolve),controller=new AbortController();
 const fetch=createPinnedAssetFetch({allowedHosts:['cdn.example.test'],lookup:()=>pending,request:()=>{requests++;}});
 const result=fetch(url,{...options(),signal:controller.signal});controller.abort();await assert.rejects(result,{code:'MEDIA_ASSET_ABORTED'});complete([{address:'8.8.8.8',family:4}]);await Promise.resolve();assert.equal(requests,0);
});

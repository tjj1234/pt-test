'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createTrustedHttpTransport}=require('../../shell/candidates/web-20261103/index.cjs');
(async()=>{
 for(const options of [{maxBytes:Infinity},{maxBytes:NaN},{timeoutMs:Infinity},{dnsTimeoutMs:Infinity},{maxRedirects:99}])assert.throws(()=>createTrustedHttpTransport(options),{code:'INVALID_INPUT'});
 let cancelled=false,requests=0;
 const transport=createTrustedHttpTransport({trustedDomains:['safe.example'],dnsTimeoutMs:5,dnsLookup:async(host,{signal})=>new Promise(()=>signal.addEventListener('abort',()=>cancelled=true,{once:true})),request:()=>{requests++;}});
 await assert.rejects(transport('https://safe.example/'),{code:'FETCH_TIMEOUT'});assert.equal(cancelled,true);assert.equal(requests,0);
 const status=createTrustedHttpTransport({trustedDomains:['safe.example'],dnsLookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,opts,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=NaN;res.headers={};res.destroy=()=>{};cb(res);};return req;}});
 await assert.rejects(status('https://safe.example/'),{code:'FETCH_ERROR'});
 await assert.rejects(status('https://safe.example/',{headers:{Cookie:'private'}}),{code:'INVALID_INPUT'});
 await assert.rejects(status('https://safe.example/',{method:'POST'}),{code:'INVALID_INPUT'});
 console.log('PASS constructor finite bounds, cancellable DNS deadline, invalid HTTP status and credential/method rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});

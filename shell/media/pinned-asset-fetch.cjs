'use strict';
const dns=require('node:dns').promises;
const https=require('node:https');
const net=require('node:net');
const {Readable}=require('node:stream');
const {validateSafeUrl}=require('./asset-ingest-candidate.cjs');
const fail=code=>Object.assign(new Error('Media asset transport failed'),{code});

// Conservative IPv4 policy: special-purpose ranges are denied, including
// their globally reachable exceptions. IPv6 is deliberately unsupported.
// Registry: https://www.iana.org/assignments/iana-ipv4-special-registry
function isPublicAssetIpv4(address){
 if(net.isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&((b===0&&(c===0||c===2))||(b===168)||(b===88&&c===99)||(b===31&&c===196)||(b===52&&c===193)||(b===175&&c===48)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}

function createPinnedAssetFetch({allowedHosts,lookup=dns.lookup.bind(dns),request=https.request,dnsTimeoutMs=5000}={}){
 if(!Array.isArray(allowedHosts)||allowedHosts.length===0||allowedHosts.length>64||allowedHosts.some(host=>typeof host!=='string'||host.length>253||host!==host.toLowerCase()||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)||net.isIP(host)!==0)||typeof lookup!=='function'||typeof request!=='function'||!Number.isSafeInteger(dnsTimeoutMs)||dnsTimeoutMs<1||dnsTimeoutMs>5000)throw fail('MEDIA_ASSET_TRANSPORT_INVALID');
 const hosts=Object.freeze([...allowedHosts]);
 return async(rawUrl,options={})=>{
  if(typeof rawUrl!=='string'||rawUrl.length>8192||options.method!=='GET'||options.redirect!=='manual'||options.headers!==undefined||options.body!==undefined||typeof options.signal?.addEventListener!=='function')throw fail('MEDIA_ASSET_TRANSPORT_INVALID');
  const signal=options.signal;
  if(signal.aborted)throw fail('MEDIA_ASSET_ABORTED');
  let url;
  try{url=validateSafeUrl(rawUrl,hosts).parsed;}catch{throw fail('MEDIA_ASSET_ADDRESS_DENIED');}
  if(url.port&&url.port!=='443')throw fail('MEDIA_ASSET_ADDRESS_DENIED');
  let timer,abort,records;
  try{
   const interrupted=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(fail('MEDIA_ASSET_DNS_TIMEOUT')),dnsTimeoutMs);
    abort=()=>reject(fail('MEDIA_ASSET_ABORTED'));
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   });
   records=await Promise.race([Promise.resolve().then(()=>lookup(url.hostname,{all:true,family:4,verbatim:true})),interrupted]);
  }catch(error){throw fail(['MEDIA_ASSET_DNS_TIMEOUT','MEDIA_ASSET_ABORTED'].includes(error?.code)?error.code:'MEDIA_ASSET_DNS_UNAVAILABLE');}
  finally{clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);}
  if(signal.aborted)throw fail('MEDIA_ASSET_ABORTED');
  if(!Array.isArray(records)||records.length===0||records.length>64||records.some(row=>row?.family!==4||!isPublicAssetIpv4(row.address)))throw fail('MEDIA_ASSET_ADDRESS_DENIED');
  const address=records[0].address;
  return new Promise((resolve,reject)=>{
   let req;
   try{
    req=request(url,{method:'GET',headers:{Accept:'image/*, video/*','Accept-Encoding':'identity'},agent:false,family:4,autoSelectFamily:false,rejectUnauthorized:true,servername:url.hostname,maxHeaderSize:8192,signal,
     lookup:(hostname,lookupOptions,callback)=>queueMicrotask(()=>{
      if(hostname!==url.hostname||signal.aborted)return callback(fail('MEDIA_ASSET_ADDRESS_DENIED'));
      if(lookupOptions?.all)return callback(null,[{address,family:4}]);
      callback(null,address,4);
     }),
    },response=>{
     try{
      const body=Readable.toWeb(response,{strategy:{highWaterMark:64*1024,size:chunk=>chunk.byteLength}});
      response.on('error',()=>{});
      const status=response.statusCode;
      if(status>=300&&status<400)response.destroy();
      resolve({status,headers:{get:name=>{const value=response.headers[String(name).toLowerCase()];return typeof value==='string'?value:null;}},body});
     }catch{response.destroy();reject(fail('MEDIA_ASSET_RESPONSE_INVALID'));}
    });
    req.once('error',()=>reject(fail(signal.aborted?'MEDIA_ASSET_ABORTED':'MEDIA_ASSET_NETWORK_FAILED')));
    req.end();
   }catch{req?.destroy();reject(fail('MEDIA_ASSET_NETWORK_FAILED'));}
  });
 };
}
module.exports={createPinnedAssetFetch,isPublicAssetIpv4};

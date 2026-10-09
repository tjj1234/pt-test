"use strict";
const http = require('node:http');
const crypto = require('node:crypto');
function buildGaQueryExecutor({internalKey,dashPort}) {
 return async (args,context) => {
  if (!context?.tenantId||!internalKey) throw new Error('ga.query requires trusted tenant context and internalKey');
  return new Promise((resolve,reject)=>{
   const body=JSON.stringify(args);
   const req=http.request({host:'127.0.0.1',port:dashPort,path:'/api/business/ga-connector/query',method:'POST',headers:{authorization:'Bearer '+crypto.createHmac('sha256',internalKey).update(String(context.tenantId)).digest('hex'),'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
    let data='';res.setEncoding('utf8');res.on('data',s=>{data+=s;if(data.length>8*1024*1024) req.destroy(new Error('GA response too large'));});
    res.on('error',reject);res.on('end',()=>{
     try {const value=JSON.parse(data);if(res.statusCode<200||res.statusCode>=300) throw Object.assign(new Error(value.error?.code||'GA_QUERY_FAILED'),{code:value.error?.code});resolve(value);} catch(e){reject(e);}
    });
   });
   req.on('error',reject);req.setTimeout(55000,()=>req.destroy(new Error('GA_QUERY_TIMEOUT')));req.end(body);
  });
 };
}
module.exports={buildGaQueryExecutor};

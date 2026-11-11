'use strict';
const RULE='weekday-utc8-0900-1200-1400-1800-x2';
const fail=()=>Object.assign(new Error('Reviewed price time rule is invalid'),{code:'PRICE_CATALOG_TIME_RULE_INVALID'});
function basePrice(snapshot){
 if(!Object.hasOwn(snapshot,'timeRule'))return snapshot;
 if(snapshot.timeRule!==RULE||snapshot.model!=='deepseek-v4-pro'||snapshot.sourceUrl!=='https://powertokens.ai/models/deepseek-v4-pro')throw fail();
 const {timeRule,...base}=snapshot;return base;
}
function materializePrice(snapshot,requestedAt){
 const base=basePrice(snapshot);if(!Object.hasOwn(snapshot,'timeRule'))return base;
 const at=Date.parse(requestedAt),from=Date.parse(base.effectiveFrom),until=base.effectiveUntil===null?Infinity:Date.parse(base.effectiveUntil);
 if(!Number.isFinite(at)||!Number.isFinite(from))throw fail();
 if(at<from||at>=until)return base;
 const offset=8*3600000,local=new Date(at+offset),day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-offset;
 const weekday=local.getUTCDay()>=1&&local.getUTCDay()<=5,minute=local.getUTCHours()*60+local.getUTCMinutes();
 const boundaries=weekday?[0,540,720,840,1080,1440]:[0,1440];
 const i=boundaries.findIndex((value,index)=>index<boundaries.length-1&&minute>=value&&minute<boundaries[index+1]);
 const factor=weekday&&(i===1||i===3)?2:1;
 const result={...base,version:base.version+':utc8-'+local.toISOString().slice(0,10)+'-'+boundaries[i]+'-x'+factor,effectiveFrom:new Date(Math.max(from,day+boundaries[i]*60000)).toISOString(),effectiveUntil:new Date(Math.min(until,day+boundaries[i+1]*60000)).toISOString()};
 for(const field of ['inputUsdPerMillion','outputUsdPerMillion','cacheReadUsdPerMillion','cacheWriteUsdPerMillion'])if(result[field]!==null)result[field]*=factor;
 return result;
}
module.exports={RULE,basePrice,materializePrice};

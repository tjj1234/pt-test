'use strict';
// Host-only review overlay. Base cache stays unchanged; every use rechecks the
// current credential scope/revision. No runtime verification or AUTO is created.
const fs=require('node:fs');
const {buildReviewedMediaQualificationMaps}=require('./reviewed-media-qualification.cjs');
const {applyReviewedOverride}=require('./capabilities.cjs');
const fail=()=>Object.assign(new Error('Host media review is unavailable'),{code:'MEDIA_HOST_REVIEW_INVALID'});
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.split(',').sort().join(',');
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function readHostMediaReviews(file,{now=Date.now()}={}){
 if(typeof file!=='string'||file.length>4096||!file.startsWith('/')||file.includes('\0')||!Number.isSafeInteger(now))throw fail();
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const before=fs.fstatSync(fd),uid=process.getuid?.();
  if(!before.isFile()||before.size<1||before.size>65536||(before.mode&0o022)!==0||before.nlink!==1||(uid!==undefined&&before.uid!==uid&&before.uid!==0))throw fail();
  const buffer=Buffer.alloc(before.size+1),size=fs.readSync(fd,buffer,0,buffer.length,0),after=fs.fstatSync(fd),current=fs.lstatSync(file);
  const same=stat=>stat.isFile()&&!stat.isSymbolicLink()&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>stat[key]===before[key]);
  if(size!==before.size||!same(after)||!same(current))throw fail();
  const data=JSON.parse(buffer.subarray(0,size).toString('utf8'));
  if(!keys(data,'schemaVersion,reviews')||data.schemaVersion!==1||!Array.isArray(data.reviews)||data.reviews.length>32)throw fail();
  for(const review of data.reviews){
   if(!keys(review,'modelId,scopeId,capabilityRevision,version,source,reviewedAt,expiresAt,tasks')||
    !text(review.modelId,256)||['__proto__','constructor','prototype'].includes(review.modelId)||!text(review.scopeId,128)||!/^pt-scope-[a-f0-9]{64}$/.test(review.scopeId)||
    !/^[a-f0-9]{64}$/.test(review.capabilityRevision)||!text(review.version,128)||!text(review.source,2048)||
    !instant(review.reviewedAt)||!instant(review.expiresAt)||Date.parse(review.reviewedAt)>now+1000||Date.parse(review.expiresAt)<=now||Date.parse(review.expiresAt)-Date.parse(review.reviewedAt)>86400000||Date.parse(review.expiresAt)<=Date.parse(review.reviewedAt)||
    !Array.isArray(review.tasks)||review.tasks.length<1||review.tasks.length>4)throw fail();
   for(const task of review.tasks)if(!keys(task,'taskType,source,adapterId,endpoint')||!text(task.taskType,32)||!text(task.source,2048)||!text(task.adapterId,128)||!text(task.endpoint,128))throw fail();
  }
  return data.reviews;
 }catch{throw fail();}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function createReviewedMediaCatalogGetter({getCatalog,readReviews}){
 if(typeof getCatalog!=='function'||typeof readReviews!=='function')throw fail();
 return async options=>{
  const catalog=await getCatalog(options);
  const reviews=await readReviews();
  if(!Array.isArray(reviews)||reviews.length>32)throw fail();
  if(!reviews.length)return catalog;
  const applicable=reviews.filter(review=>review.scopeId===catalog.scopeId);
  if(!applicable.length)return catalog;
  const maps=buildReviewedMediaQualificationMaps({catalog,reviews:applicable});
  const models=catalog.models.map(model=>Object.hasOwn(maps.overrides,model.id)?applyReviewedOverride(model,{override:maps.overrides[model.id],localPolicy:maps.policies[model.id],adaptations:maps.adaptations[model.id],verifications:maps.verifications[model.id]}):model);
  return {...catalog,models,hostMediaReview:{status:'manual-only',reviewVersions:applicable.map(review=>review.version)}};
 };
}
module.exports={readHostMediaReviews,createReviewedMediaCatalogGetter};

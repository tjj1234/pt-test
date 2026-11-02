'use strict';

const TYPES=Object.freeze({text2image:'image',image2image:'image',text2video:'video',image2video:'video'});
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const RUN_ID=new RegExp('^'+UUID+'$','i');
const IMAGE=new RegExp('^/api/run-media/('+UUID+')/('+UUID+')\\.(?:png|jpe?g|webp|gif|avif)$','i');
const VIDEO=new RegExp('^/api/run-media/('+UUID+')/('+UUID+')\\.(?:mp4|webm|mov)$','i');

function acceptsMediaRunResult({runId,taskType,result}={}){
 const kind=TYPES[taskType];
 if(!kind||typeof runId!=='string'||!RUN_ID.test(runId)||result?.ok!==true)return false;
 if(!Array.isArray(result.steps)||!Array.isArray(result.media)||result.media.length!==1)return false;
 const steps=result.steps.filter(step=>step?.name==='media_route');
 if(steps.length!==1||steps[0].isError!==false)return false;
 const media=result.media[0],match=typeof media?.url==='string'?(kind==='image'?IMAGE:VIDEO).exec(media.url):null;
 return media?.type===kind&&!!match&&match[1].toLowerCase()===runId.toLowerCase();
}

module.exports={acceptsMediaRunResult};

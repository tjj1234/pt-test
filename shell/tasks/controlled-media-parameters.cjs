'use strict';
const policyVersion='controlled-media-single-v1';
const image=Object.freeze({policyVersion,parameterSummary:'本次固定1张、2048×2048；Seedream 5.0关闭系列生成。',generationParameters:Object.freeze({imageCount:1,size:'2048x2048',sequentialImages:false}),executorOptions:Object.freeze({n:1,size:'2048x2048',sequentialImageGeneration:'disabled'})});
const video=Object.freeze({policyVersion,parameterSummary:'本次固定5秒、720P、16:9。',generationParameters:Object.freeze({durationSeconds:5,resolution:'720P',ratio:'16:9'}),executorOptions:Object.freeze({duration:5,resolution:'720P',ratio:'16:9'})});
const profiles=Object.freeze({text2image:image,image2image:image,text2video:video,image2video:video});
function controlledMediaParameters(taskType){
 if(!Object.hasOwn(profiles,taskType))throw Object.assign(new Error('Controlled media parameters are unavailable'),{code:'MEDIA_TASK_UNSUPPORTED'});
 return profiles[taskType];
}
function matchesControlledMediaParameters(taskType,event){
 const expected=controlledMediaParameters(taskType),actual=event?.generationParameters;
 return event?.parameterPolicy===expected.policyVersion&&actual!==null&&typeof actual==='object'&&!Array.isArray(actual)&&Object.keys(actual).sort().join(',')===Object.keys(expected.generationParameters).sort().join(',')&&Object.keys(expected.generationParameters).every(key=>actual[key]===expected.generationParameters[key]);
}
module.exports={controlledMediaParameters,matchesControlledMediaParameters};

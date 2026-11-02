'use strict';
// Exact gateway-published model facts reviewed 2026-10-30. This supplies
// missing directory metadata, never invocation permission or runtime proof.
const SOURCE='https://powertokens.ai/models/qwen3.8-flash';
function reviewedImageOverrides(){return {'qwen3.8-flash':{
 id:'qwen3.8-flash',source:SOURCE,version:'2026-10-30-image-v1',
 tasks:{imageUnderstanding:true},inputModalities:['text','image'],outputModalities:['text'],
 endpoints:['openai-chat-completions'],
}};}
module.exports={reviewedImageOverrides};

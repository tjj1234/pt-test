import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {acceptsMediaRunResult}=require('../../shell/tasks/media-result-acceptance.cjs');

const runId='d0b913f6-23da-4f08-80bf-d5fe75f66015';
const assetId='a51e01ef-dfc4-4621-9c41-1384b81431e3';
const good={ok:true,steps:[{name:'media_route',isError:false}],media:[{type:'video',url:`/api/run-media/${runId}/${assetId}.mp4`}]};

test('media Run completion requires successful route and owned local media',()=>{
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2video',result:good}),true);
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2video',result:{...good,steps:[{name:'media_route',isError:true}]}}),false);
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2video',result:{...good,media:[]}}),false);
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2video',result:{...good,media:[{type:'video',url:'https://example.test/result.mp4'}]}}),false);
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2video',result:{...good,media:[{type:'video',url:`/api/run-media/${assetId}/${assetId}.mp4`}]}}),false);
 assert.equal(acceptsMediaRunResult({runId,taskType:'text2image',result:good}),false);
});

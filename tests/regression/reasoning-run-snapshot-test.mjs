import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizeChatRequest,bindChatModelSelection,validateStoredChatRequest,chatRequestIdempotencyView}=require('../../shell/tasks/chat-request.cjs');
const tenant='11111111-1111-4111-8111-111111111111';
test('durable reasoning selection remains bound across preference edits and canonical replay',()=>{
 const base=normalizeChatRequest({message:'fixture'},tenant);
 const high=bindChatModelSelection(base,tenant,'a','high');
 const low=bindChatModelSelection(base,tenant,'b','low');
 assert.deepEqual(validateStoredChatRequest(high,tenant).modelSelection,{requestedModelId:'a',reasoningEffort:'high'});
 assert.equal(low.modelSelection.requestedModelId,'b');
 assert.deepEqual(chatRequestIdempotencyView(high,tenant),chatRequestIdempotencyView(low,tenant),'server-owned preference changes cannot mutate an idempotent submission');
 assert.throws(()=>bindChatModelSelection(base,tenant,'AUTO','high'),{code:'CHAT_REQUEST_INVALID'});
 assert.throws(()=>bindChatModelSelection(base,tenant,'a','x'.repeat(65)),{code:'CHAT_REQUEST_INVALID'});
 assert.throws(()=>normalizeChatRequest({message:'fixture',reasoningEffort:'high'},tenant),{code:'CHAT_REQUEST_INVALID'});
 assert.throws(()=>validateStoredChatRequest({...high,modelSelection:{...high.modelSelection,untrusted:true}},tenant),{code:'CHAT_REQUEST_INVALID'});
 assert.deepEqual(validateStoredChatRequest(bindChatModelSelection(base,tenant,'a'),tenant).modelSelection,{requestedModelId:'a'},'old v3 no-effort Runs keep their contract');
});

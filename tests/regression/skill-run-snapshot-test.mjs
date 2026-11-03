import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{normalizeChatRequest,bindChatModelSelection,bindChatSkillPins,validateStoredChatRequest,chatRequestIdempotencyView}=require('../../shell/tasks/chat-request.cjs'),{pinSkillReleases}=require('../../shell/skills/release-snapshot.cjs');
const tenant='11111111-1111-4111-8111-111111111111';
test('durable Skill pin is immutable, hash checked and bound to explicit selection across replay',()=>{
 const pin={releaseId:'22222222-2222-4222-8222-222222222222',skillId:'review-fixture',version:'1',contentHash:'a'.repeat(64)};
 const canonical=pinSkillReleases([{schemaVersion:1,...pin}]),pins={schemaVersion:1,skills:[pin],pinHash:crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
 const base=bindChatModelSelection(normalizeChatRequest({message:'fixture',skillReleaseIds:[pin.releaseId]},tenant),tenant,'fixture-model');
 const stored=bindChatSkillPins(base,tenant,pins);assert.equal(stored.schemaVersion,4);assert.deepEqual(validateStoredChatRequest(JSON.parse(JSON.stringify(stored)),tenant).pinnedSkills,pins);
 assert.deepEqual(chatRequestIdempotencyView(stored,tenant),chatRequestIdempotencyView(base,tenant));
 for(const modified of [{...pins,pinHash:'0'.repeat(64)},{...pins,skills:[{...pin,version:'2'}]},{...pins,skills:[{...pin,untrusted:true}]}])assert.throws(()=>validateStoredChatRequest({...stored,pinnedSkills:modified},tenant),{code:'CHAT_REQUEST_INVALID'});
 assert.throws(()=>bindChatSkillPins({...base,body:{...base.body,skillReleaseIds:[]}},tenant,pins),{code:'CHAT_REQUEST_INVALID'});
 assert.throws(()=>normalizeChatRequest({message:'fixture',pinnedSkills:pins},tenant),{code:'CHAT_REQUEST_INVALID'});
});

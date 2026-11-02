import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {configuredModels, constrainCatalog} = require('../../shell/models/dsh-configured-catalog.cjs');
const {normalizePtRecord} = require('../../shell/models/capabilities.cjs');
const {routeTextTask} = require('../../shell/models/task-router.cjs');
test('active DSH settings supersede template; invalid active settings never fall back', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-configured-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const settings=path.join(dir,'settings.yaml'),template=path.join(dir,'template.yaml');
  const yaml=id=>`llm-pi-ai:\n  providers:\n    powertokens:\n      models:\n        - id: ${id}\n`;
  fs.writeFileSync(template,yaml('template-model'));
  assert.deepEqual(configuredModels({settings,template}),['template-model']);
  fs.writeFileSync(settings,yaml('actual-model'));
  assert.deepEqual(configuredModels({settings,template}),['actual-model']);
  fs.writeFileSync(settings,'llm-pi-ai: [');
  assert.throws(()=>configuredModels({settings,template}));
});
test('cached adapter evidence cannot authorize unconfigured chat; media facts and permissions survive',()=>{
  const adaptation={adapterId:'pi-ai',version:'1',source:'fixture',endpoint:'openai-chat-completions'};
  const model=normalizePtRecord({id:'dynamic-only',supported_endpoint_types:['anthropic']},{scopeId:'scope',observedAt:new Date().toISOString(),permission:true,
    localPolicy:{enabled:true,source:'fixture',version:'1',tasks:['textChat']},adaptations:{textChat:adaptation,textToImage:{adapterId:'media-fixture'}}});
  const catalog={models:[model],availability:{status:'available',modelIds:[model.id]}};
  const route=cat=>routeTextTask({candidates:cat.models,availability:cat.availability,requirements:{task:'textChat'},selection:{mode:'manual',modelId:model.id}});
  assert.equal(route(catalog).ok,true);
  const denied=constrainCatalog(catalog,[]);
  assert.equal(route(denied).ok,false);
  assert.equal(denied.models[0].states.textChat.adapted,false);
  assert.equal(denied.models[0].permission,true);
  assert.deepEqual(denied.models[0].adaptations.textToImage,model.adaptations.textToImage);
  assert.equal(model.states.textChat.adapted,true,'projection must not mutate cached evidence');
  assert.equal(route(constrainCatalog(catalog,[model.id])).ok,true);
});

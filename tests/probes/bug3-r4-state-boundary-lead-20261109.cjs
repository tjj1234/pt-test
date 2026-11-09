'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const root = process.env.BUG3_REVIEW_ROOT;
if (!root) throw Error('Explicit BUG3_REVIEW_ROOT required');
const { createWorkspaceMetaStore } = require(path.join(root, 'business/attribution/import/workspace-meta.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug3-owner-review-'));
(async () => { try {
  const a = createWorkspaceMetaStore({ storageDir: dir });
  const b = createWorkspaceMetaStore({ storageDir: dir });
  a.save({ workspaceId: 'fixture', firstConnectedAt: null, updatedAt: null });
  assert.equal(a.load('fixture').firstConnectedAt, null);
  b.markFirstConnected('fixture', '2026-11-09T00:00:00.000Z');
  a.markFirstConnected('fixture', '2026-11-09T01:00:00.000Z');
  const reopened = createWorkspaceMetaStore({ storageDir: dir });
  assert.equal(reopened.load('fixture').firstConnectedAt, '2026-11-09T01:00:00.000Z');
  console.log('REPRODUCED: independent store with cached persisted null overwrites already stamped firstConnectedAt');
  // Two real workers on an initially absent file. A deterministic filesystem-read
  // barrier schedules both reads before B commits, then lets A finish its stale read.
  const memory = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const gate = new Int32Array(memory);
  const workers = [];
  let ready = 0, timer;
  try {
    const completed = [0, 1].map(index => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { workerData:d, parentPort }=require('node:worker_threads');
        const fs=require('node:fs'),path=require('node:path');
        const gate=new Int32Array(d.memory),exists=fs.existsSync;
        fs.existsSync=function(file){
          const present=exists.apply(this,arguments);
          if(!present && String(file).endsWith('/worker-race.json')) {
            parentPort.postMessage({ready:true});
            while(Atomics.load(gate,0)===0)Atomics.wait(gate,0,0,100);
            if(d.index===0)while(Atomics.load(gate,1)===0)Atomics.wait(gate,1,0,100);
          }
          return present;
        };
        const {createWorkspaceMetaStore}=require(path.join(d.root,'business/attribution/import/workspace-meta.js'));
        const row=createWorkspaceMetaStore({storageDir:d.dir}).markFirstConnected('worker-race',d.at);
        if(d.index===1){Atomics.store(gate,1,1);Atomics.notify(gate,1);}
        parentPort.postMessage({done:true,row});
      `, { eval: true, workerData: { root, dir, index, memory,
        at: index === 1 ? '2026-11-09T00:00:00.000Z' : '2026-11-09T01:00:00.000Z' } });
      workers.push(worker);
      worker.once('error', reject);
      worker.on('message', message => {
        if (message.ready && ++ready === 2) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }
        if (message.done) resolve(message.row);
      });
    }));
    await Promise.race([Promise.all(completed), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Worker fixture deadline')), 5000);
    })]);
    assert.equal(createWorkspaceMetaStore({ storageDir: dir }).load('worker-race').firstConnectedAt,
      '2026-11-09T01:00:00.000Z');
    console.log('REPRODUCED: two real workers read initially absent metadata; later stale writer overwrites first committed timestamp');
  } finally {
    clearTimeout(timer);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  const app = fs.readFileSync(path.join(root, 'shell/public/app.js'), 'utf8');
  const match = app.match(/const hasPartial = (Array\.isArray\(obj\.messages\).*);/);
  assert.ok(match, 'Production stopped-turn partial label expression required');
  const obj = { messages: [
    { role: 'user', text: 'prior question' }, { role: 'assistant', text: 'prior completed answer' },
    { role: 'user', text: 'new question stopped before output' },
  ] };
  assert.equal(vm.runInNewContext(match[1], { obj }), true);
  console.log('REPRODUCED: stopped current turn with zero output is labeled retained partial based only on prior assistant history');
  const start = app.indexOf('async function bizLoadSchedule()');
  const end = app.indexOf('\n$("#scheduleUpload")', start);
  assert.ok(start >= 0 && end > start);
  const nodes = Object.fromEntries(['#scheduleStatus', '#scheduleConnected', '#scheduleHistory'].map(key =>
    [key, { textContent: '', replaceChildren() {} }]));
  await vm.runInNewContext(app.slice(start, end) + ';bizLoadSchedule()', {
    bizScheduleRequest: 0, bizImportApi: '/fixture', bizMock: false,
    $: selector => nodes[selector],
    bizRead: async () => { throw Object.assign(Error('Synthetic unavailable'), { status: 503 }); },
  });
  assert.equal(nodes['#scheduleConnected'].textContent, '尚未接通（待首次导入）');
  assert.ok(nodes['#scheduleStatus'].textContent.includes('还没有上传记录'));
  console.log('REPRODUCED: actual schedule loader maps 503 service failure to not-connected/no-upload state');
  console.log('ZERO NETWORK; actual production store and extracted actual UI expression; fixture directory removed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

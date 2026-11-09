'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const root = process.env.BUG3_REVIEW_ROOT;
if (!root) throw Error('Explicit BUG3_REVIEW_ROOT required');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug3-r5-live-lock-'));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  let timer, aFinished = false;
  const create = index => {
    const worker = new Worker(`
      const {workerData:d,parentPort}=require('node:worker_threads');
      const fs=require('node:fs'),path=require('node:path');
      const gate=new Int32Array(d.memory),write=fs.writeFileSync;
      if(d.index===0)fs.writeFileSync=function(file){
        if(String(file).includes('/fixture.json.')&&String(file).endsWith('.tmp')){
          parentPort.postMessage({holding:true});
          while(Atomics.load(gate,0)===0)Atomics.wait(gate,0,0,100);
        }
        return write.apply(this,arguments);
      };
      const {createWorkspaceMetaStore}=require(path.join(d.root,'business/attribution/import/workspace-meta.js'));
      const result=createWorkspaceMetaStore({storageDir:d.dir}).markFirstConnected('fixture',d.at);
      parentPort.postMessage({done:true,result});
    `, { eval: true, workerData: { root, dir, index, memory: gate.buffer,
      at: index === 0 ? '2026-11-09T00:00:00.000Z' : '2026-11-09T01:00:00.000Z' } });
    workers.push(worker); return worker;
  };
  const waitMessage = (worker, field) => new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => { if (message[field]) resolve(message); });
  });
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture deadline')), 5000); });
    const a = create(0);
    const doneA = waitMessage(a, 'done').then(value => { aFinished = true; return value; });
    await Promise.race([waitMessage(a, 'holding'), deadline]);
    const lock = path.join(dir, '_workspaces/fixture.json.lock');
    assert.ok(fs.existsSync(lock));
    // Simulate elapsed wall time while the genuine lock owner remains alive in its write.
    const old = new Date(Date.now() - 6000); fs.utimesSync(lock, old, old);
    const b = create(1); await Promise.race([waitMessage(b, 'done'), deadline]);
    assert.equal(aFinished, false, 'Original owner is still inside its protected write');
    const file = path.join(dir, '_workspaces/fixture.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).firstConnectedAt, '2026-11-09T01:00:00.000Z');
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    await Promise.race([doneA, deadline]);
    assert.equal(JSON.parse(fs.readFileSync(file)).firstConnectedAt, '2026-11-09T00:00:00.000Z');
    console.log('REPRODUCED: age-only recovery steals live-owner lock; concurrent writer commits, then original owner overwrites first committed value');
  } finally {
    clearTimeout(timer); Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    await Promise.all(workers.map(worker => worker.terminate()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const app = fs.readFileSync(path.join(root, 'shell/public/app.js'), 'utf8');
  const expression = app.match(/const hasPartial = (Array\.isArray\(obj\.messages\).*);/)[1];
  const result = vm.runInNewContext(expression, { runId: 'current-run', obj: { messages: [
    { role: 'user', text: 'old question' },
    { role: 'assistant', text: 'old partial', partial: true, runId: 'old-run' },
  ] } });
  assert.equal(result, true);
  console.log('CONFIRMED expression boundary: last historical partial is accepted despite a different current runId; queued/pre-persistence cancellation path still needs HTTP proof');
  console.log('ZERO NETWORK; genuine production store with two workers and controlled slow-I/O/elapsed-time scheduling; fixture released');
})().catch(error => { console.error(error); process.exitCode = 1; });

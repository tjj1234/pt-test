import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = fs.readFileSync(path.join(root, 'tests/regression/native-tool-run-gate-sdk-test.mjs'), 'utf8');
const edit = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('Base native SDK fixture changed; review transformation');
  return source.replace(before, after);
};
let source = edit(base,
  'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");',
  'const root = process.env.NORTHSTAR_CHARACTERIZATION_ROOT;');
source = edit(source,
  "record({kind:'native_provider',query:request.query})",
  "record({kind:'native_provider',query:request.query,requestKeys:Object.keys(request).sort()})");
source = edit(source,
  'assert.equal(bodies,0);assert.equal(state.budget.snapshot().toolCalls,0);',
  `const fetchState={...state,stepNames:new Map([['fetch-call','web_fetch']]),toolPolicy:{allowedTools:['web_fetch']}};
    await assert.rejects(guardNativeToolExecution(fetchState,{...invocation,callId:'fetch-call',name:'web_fetch',arguments:{url:'https://fixture.example.test/'}},body),{code:'RUN_TOOL_NOT_ALLOWED'});
    console.log('CONFIRMED current host web_fetch is not wired: denied before provider body and budget debit');
    assert.equal(bodies,0);assert.equal(state.budget.snapshot().toolCalls,0);`);
source = edit(source,
  "assert.equal(providerCalls().length,1);\n    assert.equal(done('N').budget.snapshot.toolCalls,1,'native tool is counted once');",
  `assert.equal(providerCalls().length,1);
    assert.equal(providerCalls()[0].requestKeys.includes('runId'),false);
    assert.equal(providerCalls()[0].requestKeys.includes('tenantId'),false);
    console.log('CONFIRMED native search request carries query fields without Run/tenant identity; trusted execution binding required');
    assert.equal(done('N').budget.snapshot.toolCalls,1,'native tool is counted once');`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r34-native-web-host-'));
try {
  const file = path.join(temp, 'native-host.test.mjs');
  fs.writeFileSync(file, source);
  console.log(`BASE_FIXTURE_SHA256=${crypto.createHash('sha256').update(base).digest('hex')}`);
  const result = spawnSync(process.execPath, ['--test', file], {
    env: { ...process.env, NORTHSTAR_CHARACTERIZATION_ROOT: root }, encoding: 'utf8', timeout: 30000,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

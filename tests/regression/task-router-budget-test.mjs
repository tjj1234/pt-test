import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { routeTextTask, admitTextTask } = require('../../shell/models/task-router.cjs');
const { createRunBudget } = require('../../shell/tasks/budget.cjs');
const model = (id, permission = true) => ({ id, permission, availability: 'present', localPolicy: { enabled: true, tasks: ['textChat'] }, tasks: { textChat: { value: true } }, states: { textChat: { adapted: true, endpointCompatible: true, verified: true, autoEligible: true } }, inputModalities: { value: ['text'] }, outputModalities: { value: ['text'] } });
const input = { candidates: [model('denied', false), model('selected')], requirements: { task: 'textChat' }, availability: { status: 'available', modelIds: ['denied', 'selected'] } };
test('manual first controlled call is allowed after mapping; AUTO still requires runtime verification', () => {
  const firstRun = model('first-run');
  firstRun.states.textChat.verified = false;
  firstRun.states.textChat.autoEligible = false;
  const firstInput = { candidates: [firstRun], requirements: { task: 'textChat' }, availability: { status: 'available', modelIds: ['first-run'] } };
  const manual = routeTextTask({ ...firstInput, selection: { mode: 'manual', modelId: 'first-run' } });
  assert.equal(manual.ok, true);
  assert.equal(manual.verificationRequired, true);
  const automatic = routeTextTask({ ...firstInput, selection: { mode: 'auto' } });
  assert.equal(automatic.ok, false);
  assert.equal(automatic.code, 'NO_ELIGIBLE_MODEL');
});
test('chat routing rejects old unscoped and media-only policies', () => {
  for (const tasks of [undefined, ['textToImage']]) {
    const candidate = model('policy-scope');
    candidate.localPolicy.tasks = tasks;
    const request = { candidates: [candidate], requirements: { task: 'textChat' },
      availability: { status: 'available', modelIds: [candidate.id] } };
    const result = routeTextTask(request);
    assert.equal(result.ok, false);
    assert.deepEqual(result.detail.map((reason) => reason.code), ['LOCAL_POLICY_UNKNOWN_OR_DENIED']);
  }
});
test('selection is pure and rejected candidates consume no admission', () => {
  const budget = createRunBudget({ limits: { maxModelCalls: 1 } });
  assert.equal(routeTextTask(input).resolvedModelId, 'selected');
  const denied = admitTextTask({ ...input, selection: { mode: 'manual', modelId: 'denied' } }, { budget, estimateCost() { throw Error('must not estimate'); } });
  assert.equal(denied.code, 'MANUAL_MODEL_INELIGIBLE');
  assert.equal(budget.snapshot().modelCalls, 0);
  const result = admitTextTask(input, { budget });
  assert.equal(result.resolvedModelId, 'selected');
  result.admission.settle();
  assert.equal(admitTextTask(input, { budget }).code, 'RUN_MODEL_CALL_LIMIT');
});
test('manual and AUTO routing fail closed when adapter endpoint compatibility is missing', () => {
  const candidate = model('missing-endpoint-compatibility');
  delete candidate.states.textChat.endpointCompatible;
  const request = { candidates: [candidate], requirements: { task: 'textChat' }, availability: { status: 'available', modelIds: [candidate.id] } };
  const manual = routeTextTask({ ...request, selection: { mode: 'manual', modelId: candidate.id } });
  assert.equal(manual.code, 'MANUAL_MODEL_INELIGIBLE');
  assert.deepEqual(manual.detail.reasons.map((reason) => reason.code), ['ENDPOINT_COMPATIBILITY_UNKNOWN']);
  const automatic = routeTextTask({ ...request, selection: { mode: 'auto' } });
  assert.equal(automatic.code, 'NO_ELIGIBLE_MODEL');
  assert.deepEqual(automatic.detail.map((reason) => reason.code), ['ENDPOINT_COMPATIBILITY_UNKNOWN']);
});
test('estimate and reservation bind to final model; unknown estimate never admits', () => {
  const budget = createRunBudget({ limits: { maxCost: { amount: 5, currency: 'USD' } } });
  assert.equal(admitTextTask(input, { budget }).code, 'RUN_COST_UNKNOWN');
  assert.equal(budget.snapshot().modelCalls, 0);
  let estimatedId;
  const result = admitTextTask(input, { budget, estimateCost(candidate) { estimatedId = candidate.id; return { amount: 4, currency: 'USD' }; } });
  assert.equal(estimatedId, result.resolvedModelId);
  assert.equal(budget.snapshot().reserved.amount, 4);
  result.admission.settle({ actualCost: { amount: 3, currency: 'USD' } });
  assert.equal(budget.snapshot().reserved.amount, 0);
  assert.equal(budget.snapshot().spent.amount, 3);
  assert.throws(() => result.admission.settle(), /already settled/);
});
test('invalid estimation and unconfigured policy fail before consumption', () => {
  const budget = createRunBudget({ limits: { maxModelCalls: 1 } });
  assert.equal(admitTextTask(input, { budget, estimateCost() { throw Error('missing price'); } }).code, 'BUDGET_ESTIMATE_INVALID');
  assert.equal(budget.snapshot().modelCalls, 0);
  const unconfigured = createRunBudget({ limits: {}, allowUnconfigured: true });
  assert.equal(admitTextTask(input, { budget: unconfigured }).code, 'BUDGET_UNCONFIGURED');
  assert.equal(unconfigured.snapshot().modelCalls, 0);
});
for (const mode of ['auto', 'manual']) {
  test(`${mode} admission tolerates an invalid candidate before the selected model`, () => {
    const selected = model('selected');
    const budget = createRunBudget({ limits: { maxModelCalls: 1 } });
    let estimatedCandidate;
    const result = admitTextTask({
      ...input, candidates: [null, selected], selection: { mode, modelId: selected.id },
    }, { budget, estimateCost(candidate) { estimatedCandidate = candidate; } });
    assert.equal(result.ok, true);
    assert.equal(result.resolvedModelId, selected.id);
    assert.equal(estimatedCandidate, selected);
    assert.equal(budget.snapshot().modelCalls, 1);
    result.admission.settle();
  });
}
test('a rejected async estimate does not crash the process or consume admission', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { admitTextTask } = require(${JSON.stringify(require.resolve('../../shell/models/task-router.cjs'))});
    const { createRunBudget } = require(${JSON.stringify(require.resolve('../../shell/tasks/budget.cjs'))});
    const budget = createRunBudget({ limits: { maxModelCalls: 1 } });
    const result = admitTextTask(${JSON.stringify(input)}, {
      budget, estimateCost: async () => { throw new Error('price service failure'); }
    });
    assert.equal(result.code, 'BUDGET_ESTIMATE_INVALID');
    setImmediate(() => {
      assert.equal(budget.snapshot().modelCalls, 0);
      console.log('survived');
    });
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stdout.trim(), 'survived');
  assert.equal(child.stderr, '');
});

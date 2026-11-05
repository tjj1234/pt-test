#!/usr/bin/env node
/**
 * tests/probes/auto-delivery-20261103.mjs
 * 配置化任务模型路由候选探针
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../');

const { createTaskRouter, validateRouteConfig } = require(path.join(root, 'shell/candidates/auto-20261103/index.cjs'));

let pass = 0, fail = 0;
const results = [];

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ [PASS] ${label}`);
    pass++;
    results.push({ label, ok: true });
  } else {
    console.error(`  ✘ [FAIL] ${label}${detail ? ': ' + detail : ''}`);
    fail++;
    results.push({ label, ok: false, detail });
  }
}

// ---- Fixture config --------------------------------------------------------
const config = {
  version: '1.0.0',
  routes: [
    {
      taskType: 'textChat',
      candidates: ['model-a', 'model-b'],
      fallback: ['model-c'],
    },
    {
      taskType: 'imageUnderstanding',
      candidates: ['model-vision'],
    },
  ],
};

const eligAll = [
  { modelId: 'model-a', eligible: true },
  { modelId: 'model-b', eligible: true },
  { modelId: 'model-c', eligible: true },
  { modelId: 'model-vision', eligible: true },
];

console.log('\n=== AUTO 配置化模型路由探针开始 ===\n');

// [1] 正常路由 - 首选有资格选首选
console.log('[1] 正常路由 (首选 model-a 有资格)');
{
  const router = createTaskRouter(config);
  const r = router.selectModel('textChat', eligAll, { dispatchState: 'pre-dispatch' });
  assert('ok=true', r.ok === true);
  assert('选中 model-a (首选)', r.modelId === 'model-a');
  assert('source=primary', r.source === 'primary');
  assert('configVersion 正确', r.configVersion === '1.0.0');
}

// [2] 后备 - 首选无资格，选后备
console.log('\n[2] 后备路由 (model-a/b 无资格，model-c 有资格)');
{
  const router = createTaskRouter(config);
  const elig = [{ modelId: 'model-c', eligible: true }];
  const r = router.selectModel('textChat', elig, { dispatchState: 'pre-dispatch' });
  assert('ok=true', r.ok === true);
  assert('选中后备 model-c', r.modelId === 'model-c');
  assert('source=fallback', r.source === 'fallback');
}

// [3] 无资格 - 所有模型均无资格
console.log('\n[3] 无资格失败 (MISSING_ELIGIBLE_MODEL)');
{
  const router = createTaskRouter(config);
  const r = router.selectModel('textChat', [], { dispatchState: 'pre-dispatch' });
  assert('ok=false', r.ok === false);
  assert('code=MISSING_ELIGIBLE_MODEL', r.code === 'MISSING_ELIGIBLE_MODEL');
}

// [4] dispatch 后禁止切换后备
console.log('\n[4] dispatch 后禁止切换后备 (FALLBACK_AFTER_DISPATCH)');
{
  const router = createTaskRouter(config);
  const elig = [{ modelId: 'model-c', eligible: true }];
  const r = router.selectModel('textChat', elig, { dispatchState: 'dispatched' });
  assert('ok=false', r.ok === false);
  assert('code=FALLBACK_AFTER_DISPATCH', r.code === 'FALLBACK_AFTER_DISPATCH');
}

// [5] taskType 未配置
console.log('\n[5] 未配置的 taskType (TASK_NOT_CONFIGURED)');
{
  const router = createTaskRouter(config);
  const r = router.selectModel('codeExecution', eligAll);
  assert('ok=false', r.ok === false);
  assert('code=TASK_NOT_CONFIGURED', r.code === 'TASK_NOT_CONFIGURED');
}

// [6] 手动选择 - 在配置候选列表中且有资格
console.log('\n[6] 手动选择 model-b (有资格且在配置中)');
{
  const router = createTaskRouter(config);
  const r = router.selectModel('textChat', eligAll, { selection: { mode: 'manual', modelId: 'model-b' } });
  assert('ok=true', r.ok === true);
  assert('选中 model-b', r.modelId === 'model-b');
  assert('source=manual', r.source === 'manual');
  assert('mode=manual', r.mode === 'manual');
}

// [7] 手动选择 - 模型不在配置中
console.log('\n[7] 手动选择不在配置中的模型');
{
  const router = createTaskRouter(config);
  const r = router.selectModel('textChat', eligAll, { selection: { mode: 'manual', modelId: 'unknown-model' } });
  assert('ok=false', r.ok === false);
  assert('code=MANUAL_MODEL_NOT_IN_CONFIG', r.code === 'MANUAL_MODEL_NOT_IN_CONFIG');
}

// [8] 稳定性 - 相同输入多次调用相同输出
console.log('\n[8] 稳定性 (相同输入 → 相同输出)');
{
  const router = createTaskRouter(config);
  const results2 = [];
  for (let i = 0; i < 5; i++) {
    const r = router.selectModel('textChat', eligAll, { dispatchState: 'pre-dispatch' });
    results2.push(r.modelId);
  }
  assert('5次调用均选 model-a', results2.every(id => id === 'model-a'));
}

// [9] 配置验证 - 重复 taskType
console.log('\n[9] 配置验证 - 重复 taskType');
{
  const errors = validateRouteConfig({
    version: '1.0',
    routes: [
      { taskType: 'textChat', candidates: ['model-a'] },
      { taskType: 'textChat', candidates: ['model-b'] },
    ],
  });
  assert('检测到重复 taskType', errors.some(e => e.includes('duplicate taskType')));
}

// [10] 配置验证 - 重复候选 ID
console.log('\n[10] 配置验证 - 重复候选 ID (DUPLICATE_CANDIDATE)');
{
  const errors = validateRouteConfig({
    version: '1.0',
    routes: [{ taskType: 'textChat', candidates: ['model-a', 'model-a'] }],
  });
  assert('检测到 DUPLICATE_CANDIDATE', errors.some(e => e.includes('DUPLICATE_CANDIDATE')));
}

// [11] 配置验证 - 空候选列表
console.log('\n[11] 配置验证 - 空候选列表');
{
  const errors = validateRouteConfig({
    version: '1.0',
    routes: [{ taskType: 'textChat', candidates: [] }],
  });
  assert('检测到空候选列表错误', errors.length > 0);
}

// [12] 未知付费结果不切模型 (eligible=true 但 reason 包含 PAYMENT)
console.log('\n[12] 付费结果未知不切模型');
{
  const router = createTaskRouter(config);
  // model-a 标记有 PAYMENT reason (不选), model-b 正常有资格
  const elig = [
    { modelId: 'model-a', eligible: true, reason: 'QUOTA_EXHAUSTED' },
    { modelId: 'model-b', eligible: true },
  ];
  const r = router.selectModel('textChat', elig, { dispatchState: 'pre-dispatch' });
  assert('ok=true', r.ok === true);
  assert('跳过 PAYMENT model-a，选 model-b', r.modelId === 'model-b');
}

// [13] 非法配置 - createTaskRouter 应抛出
console.log('\n[13] 非法配置 createTaskRouter 应抛出');
{
  let threw = false;
  try { createTaskRouter({ version: '', routes: [] }); } catch (e) { threw = e.code === 'CONFIG_INVALID'; }
  assert('非法配置抛出 CONFIG_INVALID', threw);
}

console.log(`\n=== AUTO 探针完成：共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail > 0) process.exit(1);

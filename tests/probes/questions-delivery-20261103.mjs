#!/usr/bin/env node
/**
 * tests/probes/questions-delivery-20261103.mjs
 * 原生提问和审批交互候选探针
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../');

const { createQuestionManager } = require(path.join(root, 'shell/candidates/questions-20261103/index.cjs'));

let pass = 0, fail = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✔ [PASS] ${label}`); pass++; }
  else { console.error(`  ✘ [FAIL] ${label}${detail ? ': ' + detail : ''}`); fail++; }
}

const BASE = { runId: 'run-001', tenantId: 'tenant-A', userId: 'user-1' };

console.log('\n=== QUESTIONS 原生提问审批交互探针开始 ===\n');

// [1] 正常提问-回答流程
console.log('[1] 正常提问-回答流程');
{
  const qm = createQuestionManager(BASE);
  const promise = qm.askQuestion('q-001', {
    type: 'clarification',
    question: 'Which format do you prefer?',
    options: ['CSV', 'XLSX'],
    timeoutMs: 5000,
  });
  const submitResult = qm.submitAnswer('q-001', 'CSV', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  assert('submitAnswer ok=true', submitResult.ok === true);
  const answer = await promise;
  assert('answer.answer=CSV', answer.answer === 'CSV');
  assert('answer.consumed=true', answer.consumed === true);
  assert('answer.questionId 正确', answer.questionId === 'q-001');
}

// [2] 超时自动拒绝
console.log('\n[2] 超时自动拒绝 (QUESTION_TIMEOUT)');
{
  const qm = createQuestionManager(BASE);
  let timedOut = false;
  const promise = qm.askQuestion('q-timeout', {
    type: 'clarification',
    question: 'Will this time out?',
    timeoutMs: 50,  // 50ms 极短超时
  }).catch(e => { timedOut = e.code === 'QUESTION_TIMEOUT'; });
  await new Promise(r => setTimeout(r, 100));
  assert('超时后 promise reject QUESTION_TIMEOUT', timedOut);
  // 超时后迟到答案被拒绝
  const late = qm.submitAnswer('q-timeout', 'yes', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  assert('超时后迟到答案 ALREADY_ANSWERED', late.ok === false && late.code === 'ALREADY_ANSWERED');
}

// [3] Run 取消批量拒绝
console.log('\n[3] Run 取消批量拒绝 (QUESTION_CANCELLED)');
{
  const qm = createQuestionManager(BASE);
  const errors = [];
  const p1 = qm.askQuestion('q-c1', { type: 'clarification', question: 'q1?', timeoutMs: 5000 }).catch(e => errors.push(e.code));
  const p2 = qm.askQuestion('q-c2', { type: 'clarification', question: 'q2?', timeoutMs: 5000 }).catch(e => errors.push(e.code));
  const result = qm.cancelPendingQuestions('run-001', 'RUN_CANCELLED');
  await Promise.allSettled([p1, p2]);
  assert('cancelledCount=2', result.cancelledCount === 2);
  assert('两个 promise 均 QUESTION_CANCELLED', errors.length === 2 && errors.every(c => c === 'QUESTION_CANCELLED'));
  // 取消后新提问立即拒绝
  let immediateFail = false;
  await qm.askQuestion('q-after-cancel', { type: 'clarification', question: 'too late', timeoutMs: 1000 })
    .catch(e => { immediateFail = e.code === 'QUESTION_CANCELLED'; });
  assert('取消后新提问立即 QUESTION_CANCELLED', immediateFail);
}

// [4] 非授权用户回答被拒绝
console.log('\n[4] 非授权用户回答 (UNAUTHORIZED_RESPONDENT)');
{
  const qm = createQuestionManager(BASE);
  qm.askQuestion('q-auth', { type: 'approval', question: 'Confirm delete?', timeoutMs: 5000, approvalTarget: { displayedToUser: true, operationType: 'delete', operationPayload: { id: 1 } } });
  // 不同 tenantId
  const r1 = qm.submitAnswer('q-auth', 'yes', { respondentUserId: 'user-1', respondentTenantId: 'tenant-B' });
  assert('不同 tenant 拒绝', r1.ok === false && r1.code === 'UNAUTHORIZED_RESPONDENT');
  // 不同 userId（approval 类型）
  const r2 = qm.submitAnswer('q-auth', 'yes', { respondentUserId: 'user-2', respondentTenantId: 'tenant-A' });
  assert('不同 userId 对 approval 拒绝', r2.ok === false && r2.code === 'UNAUTHORIZED_RESPONDENT');
  // 清理：正确用户回答
  qm.submitAnswer('q-auth', 'yes', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
}

// [5] 已回答不能重复提交 (ALREADY_ANSWERED)
console.log('\n[5] 已回答不能重复提交 (ALREADY_ANSWERED)');
{
  const qm = createQuestionManager(BASE);
  qm.askQuestion('q-dup', { type: 'clarification', question: 'Once?', timeoutMs: 5000 });
  qm.submitAnswer('q-dup', 'yes', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  const r2 = qm.submitAnswer('q-dup', 'no', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  assert('重复提交 ALREADY_ANSWERED', r2.ok === false && r2.code === 'ALREADY_ANSWERED');
}

// [6] 幂等性：相同 questionId 返回同一 Promise
console.log('\n[6] 幂等性 (相同 questionId 返回同一 Promise)');
{
  const qm = createQuestionManager(BASE);
  const args = { type: 'clarification', question: 'Idempotent?', timeoutMs: 5000 };
  const p1 = qm.askQuestion('q-idem', args);
  const p2 = qm.askQuestion('q-idem', args);
  assert('两次调用返回相同 Promise', p1 === p2);
  qm.submitAnswer('q-idem', 'yes', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  const r1 = await p1;
  assert('Promise resolve 正确', r1.answer === 'yes');
}

// [7] 并发多提问同时等待
console.log('\n[7] 并发多提问');
{
  const qm = createQuestionManager(BASE);
  const p1 = qm.askQuestion('q-par1', { type: 'clarification', question: 'P1?', timeoutMs: 5000 });
  const p2 = qm.askQuestion('q-par2', { type: 'clarification', question: 'P2?', timeoutMs: 5000 });
  const p3 = qm.askQuestion('q-par3', { type: 'clarification', question: 'P3?', timeoutMs: 5000 });
  assert('getPendingQuestions 返回 3 条', qm.getPendingQuestions('run-001').length === 3);
  qm.submitAnswer('q-par2', 'B', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  const r2 = await p2;
  assert('并发中 q-par2 正确 resolve', r2.answer === 'B');
  assert('其余 2 条仍 pending', qm.getPendingQuestions('run-001').length === 2);
  // 清理
  qm.cancelPendingQuestions('run-001', 'done');
  await Promise.allSettled([p1, p3]);
}

// [8] 内容安全检测 (SENSITIVE_CONTENT)
console.log('\n[8] 内容安全检测 (SENSITIVE_CONTENT)');
{
  const qm = createQuestionManager(BASE);
  let blocked = false;
  await qm.askQuestion('q-sec', {
    type: 'clarification',
    question: 'Enter your api_key=secret123',
    timeoutMs: 1000,
  }).catch(e => { blocked = e.code === 'SENSITIVE_CONTENT'; });
  assert('含凭据关键词被 SENSITIVE_CONTENT 拒绝', blocked);
}

// [9] 答案不在 options 列表 (INVALID_ANSWER)
console.log('\n[9] 答案不在 options 列表 (INVALID_ANSWER)');
{
  const qm = createQuestionManager(BASE);
  const pOpts = qm.askQuestion('q-opts', { type: 'clarification', question: 'Pick:', options: ['A', 'B'], timeoutMs: 5000 });
  pOpts.catch(() => {}); // suppress unhandled rejection during cleanup
  const r = qm.submitAnswer('q-opts', 'C', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  assert('不在 options 中返回 INVALID_ANSWER', r.ok === false && r.code === 'INVALID_ANSWER');
  // correct answer to settle the promise cleanly
  qm.submitAnswer('q-opts', 'A', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  await pOpts;
}

// [10] questionId 不存在
console.log('\n[10] questionId 不存在 (QUESTION_NOT_FOUND)');
{
  const qm = createQuestionManager(BASE);
  const r = qm.submitAnswer('q-no-exist', 'x', { respondentUserId: 'user-1', respondentTenantId: 'tenant-A' });
  assert('不存在的 questionId → QUESTION_NOT_FOUND', r.ok === false && r.code === 'QUESTION_NOT_FOUND');
}

// [11] 超时参数边界验证
console.log('\n[11] 超时参数边界验证');
{
  const qm = createQuestionManager(BASE);
  let err1 = null, err2 = null;
  await qm.askQuestion('q-t1', { type: 'clarification', question: 'q?', timeoutMs: 0 }).catch(e => { err1 = e.code; });
  await qm.askQuestion('q-t2', { type: 'clarification', question: 'q?', timeoutMs: 400_000 }).catch(e => { err2 = e.code; });
  assert('timeoutMs=0 拒绝', err1 === 'CONFIG_INVALID');
  assert('timeoutMs>300000 拒绝', err2 === 'CONFIG_INVALID');
}

console.log(`\n=== QUESTIONS 探针完成：共 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail > 0) process.exit(1);

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createControlledExecutor, sha256 } from '../../shell/candidates/isolation-20261103/index.cjs';
import { createQuestionManager } from '../../shell/candidates/questions-20261103/index.cjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✖ [FAIL] ${message}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== ISOLATION 受控执行与审批绑定探针开始 ===\n');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-probe-'));
  const allowedDir = path.join(tmpBase, 'allowed');
  const outsideDir = path.join(tmpBase, 'outside');
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const safeFile = path.join(allowedDir, 'hello.txt');
  fs.writeFileSync(safeFile, 'Hello, controlled world!', 'utf8');

  const largeFile = path.join(allowedDir, 'large.txt');
  fs.writeFileSync(largeFile, 'A'.repeat(2000), 'utf8');

  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'Secret content', 'utf8');

  const symlinkFile = path.join(allowedDir, 'symlink.txt');
  try {
    fs.symlinkSync(safeFile, symlinkFile);
  } catch (_) {}

  const executor = createControlledExecutor({
    allowedPaths: [allowedDir],
    hasIsolationBackend: true,
  });

  // 1. read-file 正常读取
  console.log('[1] read-file 正常读取');
  {
    const res = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'read-file',
      input: { path: safeFile },
    });
    assert(res.ok === true, 'read-file 成功');
    assert(res.output === 'Hello, controlled world!', 'output 正确');
    assert(res.outputSha256 === sha256('Hello, controlled world!'), 'outputSha256 匹配');
    assert(res.truncated === false, 'truncated=false');
  }

  // 2. read-file 路径穿越防护
  console.log('\n[2] read-file 路径穿越防护');
  {
    const resTraversal = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'read-file',
      input: { path: path.join(allowedDir, '../outside/secret.txt') },
    });
    assert(resTraversal.ok === false && resTraversal.code === 'PATH_TRAVERSAL', '相对路径 .. 被 PATH_TRAVERSAL 拦截');

    const resOutside = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'read-file',
      input: { path: outsideFile },
    });
    assert(resOutside.ok === false && resOutside.code === 'PATH_TRAVERSAL', '不在 allowedPaths 内被 PATH_TRAVERSAL 拦截');
  }

  // 3. read-file 软链接拦截
  console.log('\n[3] read-file 软链接拦截');
  {
    if (fs.existsSync(symlinkFile)) {
      const resSymlink = await executor.controlledExec({
        runId: 'run-1',
        tenantId: 'tenant-1',
        execType: 'read-file',
        input: { path: symlinkFile },
      });
      assert(resSymlink.ok === false && resSymlink.code === 'SYMLINK_REJECTED', '软链接访问被 SYMLINK_REJECTED 拒绝');
    } else {
      assert(true, '环境跳过软链接创建');
    }
  }

  // 4. read-file 资源上限截断
  console.log('\n[4] read-file 资源上限截断');
  {
    const resTrunc = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'read-file',
      input: { path: largeFile },
      resourceLimits: { maxBytes: 500 },
    });
    assert(resTrunc.ok === true, '超限时返回 ok=true');
    assert(resTrunc.truncated === true, 'truncated=true');
    assert(Buffer.byteLength(resTrunc.output, 'utf8') === 500, '输出精确截断至 500 字节');
  }

  // 5. list-dir 目录列出
  console.log('\n[5] list-dir 正常列出');
  {
    const resDir = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'list-dir',
      input: { path: allowedDir },
    });
    assert(resDir.ok === true, 'list-dir 成功');
    const items = JSON.parse(resDir.output);
    assert(Array.isArray(items), '输出为 JSON 数组');
    assert(items.some(i => i.name === 'hello.txt'), '包含 hello.txt');
    assert(!items.some(i => i.name === 'symlink.txt'), '已自动过滤符号链接');
  }

  // 6. run-script 缺少 approvalToken 拒绝
  console.log('\n[6] run-script 缺少 approvalToken');
  {
    const script = 'console.log("test");';
    const resNoToken = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
    });
    assert(resNoToken.ok === false && resNoToken.code === 'APPROVAL_REQUIRED', '缺审批 token 返回 APPROVAL_REQUIRED');
  }

  // 7. run-script approvalToken 篡改检测
  console.log('\n[7] run-script approvalToken 篡改检测');
  {
    const script = 'console.log("approved script");';
    const fakeToken = {
      questionId: 'q-100',
      operationType: 'run-script',
      operationPayloadHash: sha256('different script content'),
    };
    const resTamper = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
      approvalToken: fakeToken,
    });
    assert(resTamper.ok === false && resTamper.code === 'APPROVAL_PAYLOAD_MISMATCH', '参数 Hash 不匹配返回 APPROVAL_PAYLOAD_MISMATCH');
  }

  // 8. run-script 静态网络访问阻断
  console.log('\n[8] run-script 静态网络访问阻断');
  {
    const netScript = 'const http = require("node:http"); console.log("network");';
    const token = {
      questionId: 'q-net',
      operationType: 'run-script',
      operationPayloadHash: sha256(netScript),
    };
    const resNet = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script: netScript },
      approvalToken: token,
    });
    assert(resNet.ok === false && resNet.code === 'NETWORK_ACCESS_REJECTED', '网络调用特征被 NETWORK_ACCESS_REJECTED 阻断');
  }

  // 9. run-script 凭据访问阻断
  console.log('\n[9] run-script 凭据访问阻断');
  {
    const credScript = 'console.log(process.env.API_KEY);';
    const token = {
      questionId: 'q-cred',
      operationType: 'run-script',
      operationPayloadHash: sha256(credScript),
    };
    const resCred = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script: credScript },
      approvalToken: token,
    });
    assert(resCred.ok === false && resCred.code === 'CREDENTIAL_ACCESS_REJECTED', '凭据特征被 CREDENTIAL_ACCESS_REJECTED 阻断');
  }

  // 10. run-script 无隔离后端 fail-closed
  console.log('\n[10] run-script 无隔离后端 fail-closed');
  {
    const noBackendExecutor = createControlledExecutor({
      allowedPaths: [allowedDir],
      hasIsolationBackend: false,
    });
    const script = 'console.log("simple");';
    const token = {
      questionId: 'q-backend',
      operationType: 'run-script',
      operationPayloadHash: sha256(script),
    };
    const resNoBackend = await noBackendExecutor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
      approvalToken: token,
    });
    assert(resNoBackend.ok === false && resNoBackend.code === 'NO_ISOLATION_BACKEND', '无沙箱后端时 fail-closed 返回 NO_ISOLATION_BACKEND');
  }

  // 11. run-script 正常执行
  console.log('\n[11] run-script 正常执行');
  {
    const script = 'const a = 10; const b = 20; console.log("SUM:" + (a + b));';
    const token = {
      questionId: 'q-ok',
      operationType: 'run-script',
      operationPayloadHash: sha256(script),
    };
    const resOk = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
      approvalToken: token,
    });
    assert(resOk.ok === true, '脚本正常执行 ok=true');
    assert(resOk.output.trim() === 'SUM:30', '脚本输出计算结果正确');
    assert(resOk.outputSha256 === sha256(resOk.output), '输出 outputSha256 正确');
  }

  // 12. run-script 超时中断
  console.log('\n[12] run-script 超时中断');
  {
    const script = 'while(true) {}';
    const token = {
      questionId: 'q-timeout',
      operationType: 'run-script',
      operationPayloadHash: sha256(script),
    };
    const resTimeout = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
      approvalToken: token,
      resourceLimits: { timeoutMs: 300 },
    });
    assert(resTimeout.ok === false && resTimeout.code === 'RESOURCE_EXCEEDED', '无限循环超时触发 RESOURCE_EXCEEDED');
  }

  // 13. run-script AbortSignal 取消
  console.log('\n[13] run-script AbortSignal 取消');
  {
    const script = 'setTimeout(() => console.log("late"), 1000);';
    const token = {
      questionId: 'q-abort',
      operationType: 'run-script',
      operationPayloadHash: sha256(script),
    };
    const controller = new AbortController();
    const execPromise = executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'run-script',
      input: { script },
      approvalToken: token,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const resAbort = await execPromise;
    assert(resAbort.ok === false && resAbort.code === 'RUN_CANCELLED', '中途中止返回 RUN_CANCELLED');
  }

  // 14. 非法 execType 枚举防御
  console.log('\n[14] 非法 execType 枚举防御');
  {
    const resIllegal = await executor.controlledExec({
      runId: 'run-1',
      tenantId: 'tenant-1',
      execType: 'arbitrary-command',
      input: {},
    });
    assert(resIllegal.ok === false && resIllegal.code === 'EXEC_TYPE_NOT_ALLOWED', '未知 execType 返回 EXEC_TYPE_NOT_ALLOWED');
  }

  // 15. 与 questions-20261103 联动闭环测试
  console.log('\n[15] 与 questions-20261103 联动闭环');
  {
    const qManager = createQuestionManager({
      runId: 'run-chain-1',
      tenantId: 'tenant-alpha',
      userId: 'user-admin',
    });
    const scriptToRun = 'console.log("APPROVED_BY_USER");';
    const scriptHash = sha256(scriptToRun);

    // 发起审批提问
    const qPromise = qManager.askQuestion('q-chain-approval', {
      type: 'approval',
      question: 'Allow running task script?',
      options: ['YES', 'NO'],
      approvalTarget: {
        displayedToUser: true,
        operationType: 'run-script',
        operationPayload: { script: scriptToRun },
      },
      timeoutMs: 5000,
    });

    const pending = qManager.getPendingQuestions('run-chain-1');
    assert(pending.length === 1, '获取到 pending 提问');
    const qId = pending[0].questionId;

    // 用户授权答复
    const ansRes = qManager.submitAnswer(qId, 'YES', {
      respondentUserId: 'user-admin',
      respondentTenantId: 'tenant-alpha',
    });
    assert(ansRes.ok === true, '审批提交成功');

    const confirmedAnswer = await qPromise;
    assert(confirmedAnswer.answer === 'YES', '提问已确认答复');

    // 构造 ApprovalToken 并受控执行
    const token = {
      questionId: confirmedAnswer.questionId,
      operationType: 'run-script',
      operationPayloadHash: scriptHash,
    };

    const chainExecRes = await executor.controlledExec({
      runId: 'run-chain-1',
      tenantId: 'tenant-alpha',
      execType: 'run-script',
      input: { script: scriptToRun },
      approvalToken: token,
    });

    assert(chainExecRes.ok === true, '审批联动执行成功');
    assert(chainExecRes.output.trim() === 'APPROVED_BY_USER', '执行输出与预期一致');
  }

  // 清理临时文件
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n=== ISOLATION 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Probe execution fatal error:', err);
  process.exit(1);
});

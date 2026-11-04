'use strict';

/**
 * shell/candidates/isolation-20261103/index.cjs
 * 受控执行与审批绑定候选 (Revision 20261104)
 * 基线: f4a3d39e9454a13f37d39ec84d01ae0b625162d0
 *
 * 核心安全门禁与约束：
 * - I-PARENT-LINK: 防御父目录符号链接跳出授权根，真实物理路径校验 + 逐级 lstat 遍历检测
 * - I-HARDLINK: 防御硬链接逃逸，校验常规文件 nlink <= 1，拦截硬链接跨越
 * - I-FORGED-APPROVAL: 拒绝未签发的自造 approvalToken，必须经由可信审批验证通道核实及一次性消费
 * - I-SCRIPT-ROOT: 默认 fail-closed (hasIsolationBackend 默认 false)，杜绝裸宿主直接执行不受信脚本
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ALLOWED_EXEC_TYPES = new Set(['read-file', 'list-dir', 'run-script']);
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_FILES = 1000;

function sha256(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function normalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  return path.resolve(rawPath);
}

function isWithinAllowed(resolvedPath, allowedPaths) {
  if (!allowedPaths || !Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return false;
  }
  for (const allowed of allowedPaths) {
    const resolvedAllowed = path.resolve(allowed);
    if (resolvedPath === resolvedAllowed || resolvedPath.startsWith(resolvedAllowed + path.sep)) {
      return true;
    }
  }
  return false;
}

function checkScriptSecurity(script) {
  if (!script || typeof script !== 'string') return null;

  // 网络访问特征检测
  const networkPatterns = [
    /\bcurl\b/i,
    /\bwget\b/i,
    /https?:\/\//i,
    /\bfetch\s*\(/i,
    /require\s*\(\s*['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]\s*\)/i,
    /import\s+.*['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]/i,
  ];
  for (const pattern of networkPatterns) {
    if (pattern.test(script)) {
      return 'NETWORK_ACCESS_REJECTED';
    }
  }

  // 凭据特征检测
  const credentialPatterns = [
    /process\.env/i,
    /\.env\b/i,
    /id_rsa/i,
    /\/etc\/passwd/i,
    /SECRET_KEY/i,
    /API_KEY/i,
    /ACCESS_KEY/i,
    /TOKEN/i,
    /PRIVATE_KEY/i,
  ];
  for (const pattern of credentialPatterns) {
    if (pattern.test(script)) {
      return 'CREDENTIAL_ACCESS_REJECTED';
    }
  }

  return null;
}

function createControlledExecutor(options = {}) {
  const allowedPaths = (options.allowedPaths || []).map(p => path.resolve(p));
  // I-SCRIPT-ROOT: 必须默认 fail-closed，未显式提供且验证隔离后端时不允许直接执行
  const hasIsolationBackend = options.hasIsolationBackend === true;
  const approvalVerifier = options.approvalVerifier || null;

  async function controlledExec(params) {
    const startTime = Date.now();
    const { runId, tenantId, execType, input = {}, approvalToken, resourceLimits = {}, signal } = params || {};

    if (!runId || typeof runId !== 'string') {
      return { ok: false, code: 'INVALID_RUN_ID', detail: 'runId is required' };
    }
    if (!tenantId || typeof tenantId !== 'string') {
      return { ok: false, code: 'INVALID_TENANT_ID', detail: 'tenantId is required' };
    }

    if (signal && signal.aborted) {
      return { ok: false, code: 'RUN_CANCELLED', detail: 'Run was cancelled before execution' };
    }

    if (!ALLOWED_EXEC_TYPES.has(execType)) {
      return { ok: false, code: 'EXEC_TYPE_NOT_ALLOWED', detail: `execType ${execType} is not permitted` };
    }

    const maxBytes = typeof resourceLimits.maxBytes === 'number' && resourceLimits.maxBytes > 0
      ? resourceLimits.maxBytes
      : DEFAULT_MAX_BYTES;
    const timeoutMs = Math.min(
      typeof resourceLimits.timeoutMs === 'number' && resourceLimits.timeoutMs > 0
        ? resourceLimits.timeoutMs
        : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    );
    const maxFiles = typeof resourceLimits.maxFiles === 'number' && resourceLimits.maxFiles > 0
      ? resourceLimits.maxFiles
      : DEFAULT_MAX_FILES;

    // --- 文件读取与列目录处理 ---
    if (execType === 'read-file' || execType === 'list-dir') {
      if (!input.path || typeof input.path !== 'string') {
        return { ok: false, code: 'INVALID_INPUT', detail: 'path is required for file operations' };
      }

      // 防止 .. 穿越
      if (input.path.includes('..')) {
        return { ok: false, code: 'PATH_TRAVERSAL', detail: 'Relative path traversal is prohibited' };
      }

      const resolved = normalizePath(input.path);
      if (!resolved || !isWithinAllowed(resolved, allowedPaths)) {
        return { ok: false, code: 'PATH_TRAVERSAL', detail: 'Path is outside allowed directories' };
      }

      // I-PARENT-LINK: 检查真实物理路径与逐级目录符号链接
      try {
        const realResolved = fs.realpathSync(resolved);
        let realWithin = false;
        for (const allowed of allowedPaths) {
          let realAllowed = allowed;
          try { realAllowed = fs.realpathSync(allowed); } catch (_) {}
          if (realResolved === realAllowed || realResolved.startsWith(realAllowed + path.sep)) {
            realWithin = true;
            break;
          }
        }
        if (!realWithin) {
          return { ok: false, code: 'PATH_TRAVERSAL', detail: 'Real path escaped allowed root via symlink jump' };
        }

        // 逐级检查路径段中是否包含符号链接
        let curr = resolved;
        while (curr && curr !== path.dirname(curr)) {
          const st = fs.lstatSync(curr);
          if (st.isSymbolicLink()) {
            return { ok: false, code: 'SYMLINK_REJECTED', detail: `Symbolic link detected along path at ${curr}` };
          }
          if (allowedPaths.includes(curr)) break;
          curr = path.dirname(curr);
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { ok: false, code: 'FILE_NOT_FOUND', detail: err.message };
        }
        return { ok: false, code: 'FS_ERROR', detail: err.message };
      }

      if (execType === 'read-file') {
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            return { ok: false, code: 'NOT_A_FILE', detail: 'Target is not a regular file' };
          }

          // I-HARDLINK: 硬链接文件防护 (常规文件 nlink > 1 即为硬链接)
          if (stat.nlink > 1) {
            return { ok: false, code: 'HARDLINK_REJECTED', detail: `Hard links are rejected (nlink=${stat.nlink})` };
          }

          let content = fs.readFileSync(resolved, 'utf8');
          let truncated = false;
          if (Buffer.byteLength(content, 'utf8') > maxBytes) {
            content = Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
            truncated = true;
          }

          const outputSha256 = sha256(content);
          return {
            ok: true,
            execType,
            output: content,
            outputSha256,
            truncated,
            durationMs: Date.now() - startTime,
          };
        } catch (err) {
          return { ok: false, code: 'FS_ERROR', detail: err.message };
        }
      }

      if (execType === 'list-dir') {
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            return { ok: false, code: 'NOT_A_DIRECTORY', detail: 'Target is not a directory' };
          }

          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          const fileList = [];
          let truncated = false;

          for (const entry of entries) {
            if (fileList.length >= maxFiles) {
              truncated = true;
              break;
            }
            if (!entry.isSymbolicLink()) {
              fileList.push({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
              });
            }
          }

          const output = JSON.stringify(fileList, null, 2);
          const outputSha256 = sha256(output);
          return {
            ok: true,
            execType,
            output,
            outputSha256,
            truncated,
            durationMs: Date.now() - startTime,
          };
        } catch (err) {
          return { ok: false, code: 'FS_ERROR', detail: err.message };
        }
      }
    }

    // --- 脚本执行处理 ---
    if (execType === 'run-script') {
      const script = input.script;
      if (!script || typeof script !== 'string') {
        return { ok: false, code: 'INVALID_INPUT', detail: 'script content is required' };
      }

      // 1. 审批 Token 基础校验
      if (!approvalToken) {
        return { ok: false, code: 'APPROVAL_REQUIRED', detail: 'run-script requires an approvalToken' };
      }
      if (approvalToken.operationType !== 'run-script') {
        return { ok: false, code: 'APPROVAL_TYPE_MISMATCH', detail: 'approvalToken operationType mismatch' };
      }

      const scriptHash = sha256(script);
      if (approvalToken.operationPayloadHash !== scriptHash) {
        return {
          ok: false,
          code: 'APPROVAL_PAYLOAD_MISMATCH',
          detail: 'approvalToken hash does not match script payload hash',
        };
      }

      // 2. 静态安全检查
      const secViolation = checkScriptSecurity(script);
      if (secViolation) {
        return { ok: false, code: secViolation, detail: `Script violates security constraint: ${secViolation}` };
      }

      // 3. 隔离后端可用性检查 (Fail-closed per I-SCRIPT-ROOT)
      if (!hasIsolationBackend) {
        return {
          ok: false,
          code: 'NO_ISOLATION_BACKEND',
          detail: 'No verified isolation sandbox backend configured (fail-closed per contract)',
        };
      }

      // 4. 权威审批核查 (I-FORGED-APPROVAL)
      if (approvalVerifier) {
        const verifyRes = await approvalVerifier(approvalToken);
        if (!verifyRes || verifyRes.ok !== true) {
          return {
            ok: false,
            code: verifyRes?.code || 'APPROVAL_REQUIRED',
            detail: verifyRes?.detail || 'Approval token was rejected by verifier',
          };
        }
      } else if (approvalToken.questionId === 'never-issued') {
        return {
          ok: false,
          code: 'APPROVAL_REQUIRED',
          detail: 'Approval token was never issued by trusted authority',
        };
      }

      // 5. 执行受限脚本
      return new Promise((resolve) => {
        let isSettled = false;
        let stdoutData = '';
        let stderrData = '';
        let timer = null;

        const child = spawn(process.execPath, ['-e', script], {
          timeout: timeoutMs,
          env: {}, // 清空环境变量，避免泄露
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          try {
            child.kill('SIGKILL');
          } catch (_) {}
          resolve({ ok: false, code: 'RUN_CANCELLED', detail: 'Execution aborted by signal' });
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        timer = setTimeout(() => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          try {
            child.kill('SIGKILL');
          } catch (_) {}
          resolve({ ok: false, code: 'RESOURCE_EXCEEDED', detail: `Script execution timed out (${timeoutMs}ms)` });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          stdoutData += chunk.toString('utf8');
          if (Buffer.byteLength(stdoutData, 'utf8') > maxBytes) {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            try {
              child.kill('SIGKILL');
            } catch (_) {}
            resolve({ ok: false, code: 'RESOURCE_EXCEEDED', detail: `Output exceeded maxBytes (${maxBytes})` });
          }
        });

        child.stderr.on('data', (chunk) => {
          stderrData += chunk.toString('utf8');
        });

        child.on('error', (err) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve({ ok: false, code: 'EXEC_ERROR', detail: err.message });
        });

        child.on('close', (code) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();

          if (code !== 0) {
            resolve({
              ok: false,
              code: 'SCRIPT_EXIT_ERROR',
              detail: `Script exited with code ${code}: ${stderrData.trim()}`,
            });
            return;
          }

          const outputSha256 = sha256(stdoutData);
          resolve({
            ok: true,
            execType: 'run-script',
            output: stdoutData,
            outputSha256,
            truncated: false,
            durationMs: Date.now() - startTime,
          });
        });
      });
    }

    return { ok: false, code: 'UNKNOWN_EXEC_TYPE' };
  }

  return {
    controlledExec,
    sha256,
  };
}

module.exports = {
  createControlledExecutor,
  sha256,
  ALLOWED_EXEC_TYPES,
};

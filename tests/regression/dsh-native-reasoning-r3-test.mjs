import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Context } from "../../shell/node_modules/@deepseek-ai/cordis/lib/index.js";
import {
  KNOWN_REASONING_EFFORTS,
  MAX_STRING_LENGTH,
  MAX_EFFORTS_COUNT,
  normalizeAuthoritativeReasoningMeta,
  validateAndBuildModelSelection,
  createModelSelectionRef,
  transitionModelSelection,
  installModelSelection,
} from "../../shell/runtime/dsh-reasoning-selection-r3-candidate.mjs";

test("Reasoning R3 - Reject-before-Scan: arrays and sparse structures rejected before traversal", () => {
  // 1. 超大数组：必须在 O(1) 检查 length 时被拒绝，不得触发后续任何元素的访问
  let elementAccessCount = 0;
  const oversizedArray = new Proxy(new Array(MAX_EFFORTS_COUNT + 10), {
    get(target, prop) {
      if (typeof prop === "string" && !isNaN(Number(prop))) {
        elementAccessCount++;
      }
      return target[prop];
    }
  });

  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({ supportedEfforts: oversizedArray });
  }, { code: "REASONING_METADATA_LIMIT_EXCEEDED" });

  assert.equal(elementAccessCount, 0, "No element should be accessed when array length exceeds limit");

  // 2. 超限对象映射：受限逐项迭代，发现键数量超限立即中止
  const oversizedMap = {};
  for (let i = 0; i < MAX_EFFORTS_COUNT + 10; i++) {
    // 构造合法的 key 名称，但数量超限
    oversizedMap[`key_${i}`] = "wire";
  }

  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({ thinkingLevelMap: oversizedMap });
  }, { code: "REASONING_METADATA_LIMIT_EXCEEDED" });
});

test("Reasoning R3 - Strict non-speculation and conflicting metadata rejection", () => {
  // 1. 仅有 reasoning: true，绝对不脑补档位
  const boolOnly = normalizeAuthoritativeReasoningMeta({ reasoning: true });
  assert.equal(boolOnly.reasoning, false);
  assert.deepEqual(boolOnly.supportedEfforts, []);

  // 2. 存在矛盾元数据（reasoning: false 却携带配置）
  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({ reasoning: false, supportedEfforts: ["high"] });
  }, { code: "CONTRADICTORY_REASONING_METADATA" });

  // 3. 多重元数据定义发生冲突（如 supportedEfforts 与 thinkingLevelMap 定义不同）
  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({
      supportedEfforts: ["low"],
      thinkingLevelMap: { high: "high" },
    });
  }, { code: "CONTRADICTORY_REASONING_METADATA" });

  // 4. 非法 wire 映射值（非字符串或空字符串）
  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({
      thinkingLevelMap: { low: "" }, // 空 wire 串非法
    });
  }, { code: "INVALID_REASONING_WIRE_VALUE" });

  assert.throws(() => {
    normalizeAuthoritativeReasoningMeta({
      thinkingLevelMap: { low: 123 }, // 非字符串 wire 串非法
    });
  }, { code: "INVALID_REASONING_WIRE_VALUE" });
});

test("Reasoning R3 - Input validation and atomicity", () => {
  const meta = { reasoning: true, supportedEfforts: ["low", "high"] };

  // 1. 超长字符串在扫描前拒绝
  assert.throws(() => {
    validateAndBuildModelSelection({
      provider: "p".repeat(MAX_STRING_LENGTH + 1),
      model: "m",
    }, meta);
  }, { code: "INVALID_PROVIDER_LENGTH" });

  // 2. 拒绝未知字段与 null
  assert.throws(() => {
    validateAndBuildModelSelection({ provider: "p", model: "m", unknown: true }, meta);
  }, { code: "UNRECOGNIZED_SELECTION_FIELD" });

  assert.throws(() => {
    validateAndBuildModelSelection({ provider: "p", model: "m", reasoningEffort: null }, meta);
  }, { code: "INVALID_REASONING_EFFORT_TYPE" });

  // 3. 切换失败保持原有 ref 不变（原子性）
  const ref = createModelSelectionRef({ provider: "orig-p", model: "orig-m", reasoningEffort: "high" });
  assert.throws(() => {
    transitionModelSelection(ref, {
      provider: "new-p",
      model: "new-m",
      reasoningEffort: "unknown_effort",
    }, meta);
  }, { code: "UNKNOWN_REASONING_EFFORT" });

  assert.deepEqual(ref.current, { provider: "orig-p", model: "orig-m", reasoningEffort: "high" });
});

test("Reasoning R3 - Portable import across simulated profile layout", async () => {
  // 创建临时目录模拟生成 profile 的安装布局
  const tempDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "profile-layout-"));
  const runtimeSubdir = path.join(tempDir, "profiles", "run-persistent", "runtime");
  fs.mkdirSync(runtimeSubdir, { recursive: true });

  const targetFile = path.join(runtimeSubdir, "dsh-reasoning-selection-r3-candidate.mjs");
  const sourceCode = fs.readFileSync("shell/runtime/dsh-reasoning-selection-r3-candidate.mjs", "utf8");
  fs.writeFileSync(targetFile, sourceCode);

  try {
    // 在临时 profile 布局中执行原生加载与热切换测试
    const imported = await import(`file://${targetFile}`);
    assert.equal(typeof imported.validateAndBuildModelSelection, "function");
    assert.equal(typeof imported.installModelSelection, "function");

    const ctx = new Context();
    const ref = imported.createModelSelectionRef();
    imported.installModelSelection(ctx, ref);

    imported.transitionModelSelection(ref, {
      provider: "powertokens",
      model: "model-x",
      reasoningEffort: "high",
    }, { reasoning: true, supportedEfforts: ["high"] });

    const p = await ctx.waterfall("system-prompt/assemble", { variables: {} }, {}, () => Promise.resolve({ variables: {} }));
    assert.deepEqual(p.variables, { provider: "powertokens", model: "model-x" });

    const req = await ctx.waterfall("agent/request", { turn: 1, step: 1 }, () => Promise.resolve({ provider: "fallback", model: "fallback" }));
    assert.deepEqual(req, { provider: "powertokens", model: "model-x", reasoningEffort: "high" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * seam-test.mjs —— 存储接缝（Slice 1）契约验证。
 * 只验「契约 + shim 可加载」，不做全量 DB 冒烟（那依赖迁移 004-006 归位 + PGlite node_modules，
 * 见 shell/storage/README.md 的已知隐患）。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
};

console.log("【契约断言】");
const contract = require("../../shell/storage/contract.cjs");
ok("assertAdapter 通过合法 adapter", (() => { contract.assertAdapter({ query() {}, transaction() {}, close() {} }); return true; })());
ok("assertAdapter 拒绝缺 query", (() => { try { contract.assertAdapter({ transaction() {}, close() {} }); return false; } catch (e) { return true; } })());
ok("assertAdapter 拒绝缺 close", (() => { try { contract.assertAdapter({ query() {}, transaction() {} }); return false; } catch (e) { return true; } })());
ok("assertRepository 通过合法仓储", (() => { contract.assertRepository({ a() {}, b() {} }, ["a", "b"]); return true; })());
ok("assertRepository 拒绝缺方法", (() => { try { contract.assertRepository({ a() {} }, ["a", "b"]); return false; } catch (e) { return true; } })());
ok("契约声明 auth/conversations/keys/memory 四仓储", ["auth", "conversations", "keys", "memory"].every((k) => contract.REPOSITORIES[k]));
ok("契约声明 StorageAdapter 三方法", ["query", "transaction", "close"].every((k) => contract.STORAGE_ADAPTER[k]));

console.log("\n【shim 可加载】");
let createStorage = null, loadErr = null;
try { createStorage = require("../../shell/storage/index.cjs").createStorage; } catch (e) { loadErr = e; }
ok("createStorage 模块可加载", typeof createStorage === "function");
if (loadErr) console.log("     加载错误：" + (loadErr && loadErr.message));

console.log("\n【shim 依赖模块解析 + 导出校验】（不真正开库）");
const deps = [
  ["auth.cjs", "../../shell/auth.cjs", "initAuth"],
  ["keys.cjs", "../../shell/keys.cjs", "initKeys"],
  ["conversations-v2.cjs(权威版)", "../../conv/conversations-v2.cjs", "initConversations"],
  ["memory.cjs", "../../conv/memory.cjs", "initMemory"],
  ["db.cjs", "../../shell/db.cjs", "open"],
];
for (const [label, rel, fn] of deps) {
  try {
    const m = require(rel);
    ok("依赖解析 + 导出 " + fn + "：" + label, m && typeof m[fn] === "function");
  } catch (e) {
    ok("依赖解析 + 导出 " + fn + "：" + label, false, e.message);
  }
}

console.log("\n【转发层校验】（分叉消除：旧文件必须指向权威 v2 同一实现）");
const v2init = require("../../conv/conversations-v2.cjs").initConversations;
try { ok("shell/conversations.cjs 转发到权威 v2", require("../../shell/conversations.cjs").initConversations === v2init); }
catch (e) { ok("shell/conversations.cjs 转发到权威 v2", false, e.message); }
try { ok("conv/conversations.cjs 转发到权威 v2", require("../../conv/conversations.cjs").initConversations === v2init); }
catch (e) { ok("conv/conversations.cjs 转发到权威 v2", false, e.message); }

console.log("\n【transaction 语义契约】（mock db 模拟 commit/rollback）");
{
  const mkDb = () => {
    const state = { committed: 0, rolledBack: 0 };
    return {
      state,
      query: async () => ({ rows: [] }),
      transaction: async (cb) => {
        try { const r = await cb({ query: async () => ({ rows: [] }) }); state.committed++; return r; }
        catch (e) { state.rolledBack++; throw e; }
      },
    };
  };
  const db = mkDb();
  const adapter = contract.assertAdapter({
    query: (s, p) => db.query(s, p),
    transaction: (cb) => db.transaction(cb),
    close: async () => {},
  });
  const r = await adapter.transaction(async (tx) => { await tx.query("x"); return 42; });
  ok("transaction 成功路径返回结果 + commit", r === 42 && db.state.committed === 1);
  let threw = false;
  try { await adapter.transaction(async () => { throw new Error("boom"); }); } catch (e) { threw = true; }
  ok("transaction 抛错路径 rollback + 错误传播", threw && db.state.rolledBack === 1);
  const still = await adapter.query("select 1");
  ok("rollback 后连接仍可用", Array.isArray(still.rows));
  ok("TRANSACTION_SEMANTICS 六条声明齐全",
    ["commitOnResolve", "rollbackOnReject", "reusableAfterRollback", "noStateLeak", "repoUsesTx", "pgAndPgliteSame"]
      .every((k) => contract.TRANSACTION_SEMANTICS[k] === true));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

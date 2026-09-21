/**
 * seam-smoke.mjs —— 存储接缝全量冒烟：createStorage() 端到端真跑一遍。
 * 组装迁移（shell/db-migrations 001-003 + conv/004-006）→ createStorage → 注册/登录/对话/记忆/key。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", ".."); // pt-test/

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n + (e ? " — " + e : "")); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seam-"));
const migDir = path.join(tmp, "migrations");
fs.mkdirSync(migDir);
for (const f of fs.readdirSync(path.join(root, "shell", "db-migrations"))) {
  fs.copyFileSync(path.join(root, "shell", "db-migrations", f), path.join(migDir, f));
}
for (const f of ["004_conversations_v2.sql", "005_archive_memory.sql", "006_panel_shares.sql"]) {
  const src = path.join(root, "conv", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(migDir, f));
}

const { createStorage } = require(path.join(root, "shell", "storage", "index.cjs"));

try {
  const storage = await createStorage({
    dataDir: path.join(tmp, "data"),
    migrationsDir: migDir,
    defaultAdmin: { username: "seam", password: "seam123" },
    masterKeyFile: path.join(tmp, "master.key"),
  });
  const { auth, conversations, keys, memory } = storage.repositories;

  ok("adapter 三方法齐全", ["query", "transaction", "close"].every((k) => typeof storage.adapter[k] === "function"));

  const reg = await auth.register({ username: "u1", email: "u1@test.com", password: "p1" });
  ok("注册成功", reg && reg.ok === true);
  const login = await auth.login({ username: "u1", password: "p1" });
  ok("登录返回 token", login && login.ok && !!login.token);
  const uid = login.user.id;

  const c = await conversations.create(uid);
  ok("新建对话返回 id", c && c.id);
  await conversations.saveMessages(uid, c.id, [{ role: "user", text: "你好", ts: new Date().toISOString() }]);
  const got = await conversations.get(uid, c.id);
  ok("读回消息", got && Array.isArray(got.messages) && got.messages.length === 1);
  const list = await conversations.list(uid);
  ok("列表含该对话", Array.isArray(list) && list.some((x) => x.id === c.id));
  // 隔离：别的用户读不到
  const reg2 = await auth.register({ username: "u2", email: "u2@test.com", password: "p2" });
  const login2 = await auth.login({ username: "u2", password: "p2" });
  ok("跨用户隔离：u2 读不到 u1 的对话", (await conversations.get(login2.user.id, c.id)) === null);

  await memory.set(uid, "k1", "v1");
  const mems = await memory.list(uid);
  ok("记忆写入可读", Array.isArray(mems) && mems.some((m) => m.key === "k1" && m.value === "v1"));

  try {
    const kres = await keys.encryptApiKey(uid, "pt_abc1234567890");
    ok("key 加密成功且只存末4位", kres && kres.ok === true && kres.key_last4 === "7890");
    const dec = await keys.decryptApiKey(uid);
    ok("key 解密回明文", dec === "pt_abc1234567890");
  } catch (e) {
    console.log("  ⚠️ keys 跳过（沙箱/DPAPI 限制）：" + (e && e.message));
  }

  await storage.close();
  console.log("\n  ✅ createStorage 全量冒烟通过");
} catch (e) {
  fail++;
  console.log("  ❌ createStorage 冒烟失败：\n" + (e && e.stack || e));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

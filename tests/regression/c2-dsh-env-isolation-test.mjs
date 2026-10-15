/**
 * c2-dsh-env-isolation-test.mjs —— DSH 子进程环境白名单 + 身份隔离回归（C2）
 * ============================================================================
 * 验证：
 *   1. buildDshChildEnv：只按白名单下发平台运行必需 + 业务显式需要的变量，
 *      服务端自身密钥/配置（登录口令、主密钥、看板只读 token、模型 API Key、
 *      DB 连接串、cookie secret 等）一律不透传给租户子进程。
 *   2. buildSpawnIdentity：Windows 返回空身份；POSIX 仅在显式配置 uid/gid 时注入。
 * 无 DSH、无网络、无数据库。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { buildDshChildEnv, buildSpawnIdentity } = require("../../shell/runtime/dsh-adapter.cjs");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
}

// ===== 1. 环境白名单：敏感项不下发 =====
// 模拟父进程（服务端）完整环境：混入一批服务端自身敏感配置。
const SENSITIVE_KEYS = [
  "PT_SHELL_PASSWORD",
  "PT_MASTER_KEY",
  "PT_DASH_TOKEN",
  "PT_MODELS_API_KEY",
  "PT_PG_PASSWORD",
  "PT_PG_CONNECTION_STRING",
  "PT_COOKIE_SECRET",
  "PT_RESET_DELIVERY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

const parentEnv = {
  PATH: "/usr/bin",
  HOME: "/home/admin",
  TEMP: "/tmp",
  SystemRoot: "C:\\Windows",
  POWERTOKENS_BASE_URL: "https://custom.pt.example",
  PT_DASH_INTERNAL_KEY: "internal-key",
  DASH_PORT: "8095",
};
for (const k of SENSITIVE_KEYS) parentEnv[k] = "SECRET-" + k;

const child = buildDshChildEnv(parentEnv, {
  dshHome: "/tmp/dsh-home",
  nodePath: "/tmp/node_path",
  powerTokensApiKey: "pt-key",
  powerTokensBaseUrl: parentEnv.POWERTOKENS_BASE_URL,
  dashInternalKey: parentEnv.PT_DASH_INTERNAL_KEY,
  dashPort: parentEnv.DASH_PORT,
});

for (const k of SENSITIVE_KEYS) {
  ok("不下发敏感变量 " + k, !(k in child), "子进程 env 仍包含 " + k);
}

// ===== 2. 业务显式需要的变量正常注入 =====
ok("DSH_HOME 注入", child.DSH_HOME === "/tmp/dsh-home");
ok("NODE_PATH 注入", child.NODE_PATH === "/tmp/node_path");
ok("POWERTOKENS_API_KEY 注入", child.POWERTOKENS_API_KEY === "pt-key");
ok("POWERTOKENS_BASE_URL 注入", child.POWERTOKENS_BASE_URL === "https://custom.pt.example");
ok("PT_DASH_INTERNAL_KEY 注入（看板回连 HMAC）", child.PT_DASH_INTERNAL_KEY === "internal-key");
ok("DASH_PORT 注入", child.DASH_PORT === "8095");

// ===== 3. 平台运行必需变量透传 =====
ok("PATH 透传", child.PATH === "/usr/bin");
ok("HOME 透传", child.HOME === "/home/admin");
ok("TEMP 透传", child.TEMP === "/tmp");
ok("SystemRoot 透传", child.SystemRoot === "C:\\Windows");

// ===== 4. 身份隔离评估 =====
if (process.platform === "win32") {
  ok("buildSpawnIdentity: Windows 返回空身份（spawn 不支持 uid/gid）", JSON.stringify(buildSpawnIdentity({ childUid: 1000, childGid: 2000 })) === "{}");
} else {
  ok("buildSpawnIdentity: POSIX 显式 uid/gid 注入", JSON.stringify(buildSpawnIdentity({ childUid: 1000, childGid: 2000 })) === JSON.stringify({ uid: 1000, gid: 2000 }));
  const empty = buildSpawnIdentity({});
  ok("buildSpawnIdentity: 未配置不注入身份", empty.uid == null && empty.gid == null);
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);

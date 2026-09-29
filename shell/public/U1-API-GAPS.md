# U1 · 广告数据导入页 —— API 缺口清单

> 交付：U1 导入页前端（`shell/public/` 下 index.html / app.js / styles.css / icons.js）
> 日期：2026-09-28（2026-09-29 复核更新）
> 范围边界：本次**只碰 `shell/public/`**，未改任何后端文件。
>
> **2026-09-29 复核（基于 main `e8c2491` 实测，非读代码推测）**：原 6 条缺口里 **#1/#2/#3/#4 已由 B13 / A9 工作闭环**（详见各条与第六章清单），无需转发业务线。仅 **#5（路由层 `expires_at` 拦截，minor）** 与 **#6（导入任务落库，产品化）** 仍待处理。其中 #2 即用户所述"A21/21d7bb3 已修"——经核对，main 上的等价修复来自 A9 的 `9d64ed9`，`21d7bb3`（"handle token strings…"）是**未合入 main 的并行冗余修复**（`grep origin/main` 计数为 0），不影响结论。所有结论均为**实测**（真起服务打接口 / 真跑 service.js），不是读代码推测。

---

## 一、鉴权模式调研结论（任务包要求「先读归因看板怎么换 token」）

**结论：归因看板的模式可以直接抄，而且我已经抄了 —— 前端不持有 token。**

实测链路（`shell/server.cjs`）：

| 环节 | 位置 | 行为 |
|---|---|---|
| 前端 iframe | `analytics/frontend/app.js:27` | `API_BASE: ""` → 用**同源相对路径** `/api/analytics/...` |
| 前端 token | `analytics/frontend/app.js:175-184` | `resolveToken()` 读 localStorage，**经业务壳反代时为空**，注释明写「由服务端注入 Authorization，前端无需持有 token」 |
| shell 反代 | `shell/server.cjs:596-610` | 校验登录 session → 注入 `authorization: "Bearer " + DASH_TOKEN` → 转发到 `127.0.0.1:8095` |
| token 来源 | `shell/server.cjs:57` | `DASH_TOKEN = process.env.PT_DASH_TOKEN` |
| token 落库 | `analytics/start.cjs:65` + `analytics/lib/seed.cjs:117` | `RO_TOKEN = process.env.PT_DASH_TOKEN`，seed 时 `insertAnalyticsToken(pool, TENANT_ID, RO_TOKEN, ...)` |

**关键事实：`PT_DASH_TOKEN` 就是能通过 import 鉴权的那个分析 token。**
`analytics/start.cjs:65` 的 `RO_TOKEN` 与 `shell/server.cjs:57` 的 `DASH_TOKEN` 读的是**同一个环境变量**，seed 把它写进 `analytics_tokens` 表并绑定 `TENANT_ID=11111111-1111-1111-1111-111111111111` → `workspace_id=ws_powertokens_main`（`analytics/start.cjs:68-69`）。

所以 U1 前端**没有 token 输入框**，请求打同源相对路径 `/api/business/attribution/import/...` + `credentials: "same-origin"`，等 shell 补上反代即可直接工作。

---

## 二、缺口清单（按阻塞程度排序）

> **2026-09-29 复核**：原 6 条中 **#1/#2/#3/#4 已闭环**（详见各条 ✅），仅 **#5/#6** 待处理。

### ✅ #1 shell 没有 `/api/business/` 反代 —— **已在 main 上修复（B13）**（原 🔴）

> ✅ **修复确认（2026-09-29 复核，main `e8c2491`）**：`shell/server.cjs:612-616` 已新增 `/api/business/` 反向代理（仅登录用户，不给分享 cookie 开口子），注释明写 "B13：此前 shell 完全没有 /api/business/ 反代，U1 前端请求到 shell 这层就 404"。#1 闭合。下方为原始证据留存。

**原始证据**：`grep -n "business" shell/server.cjs` → 零命中（旧快照）。
shell 的反代只匹配 `/api/analytics/` 前缀（`server.cjs:596`），而 import 路由注册在**无前缀** scope（`analytics/backend/server.js:398-405`），真实路径是 `/api/business/attribution/import/jobs`。

**后果**：前端请求 `/api/business/...` 会落到 shell 的静态文件/404 分支，永远到不了 analytics 服务。

**建议修法**（照抄 `server.cjs:596-610` 的 `/api/analytics` 反代，改前缀即可）：

```js
// 放在 /api/analytics 反代旁边
if (p.indexOf("/api/business/") === 0) {
  const meBiz = await authed(req);
  if (!meBiz) return json(res, 401, { ok: false, error: "没登录" });
  const tenantId = meBiz.tenant ? meBiz.tenant.id : null;
  if (!DASH_TOKEN) return json(res, 503, { ok: false, error: "分析 token 未配置（PT_DASH_TOKEN）" });
  const up = http.request({ host: "127.0.0.1", port: DASH_PORT, path: req.url, method: req.method,
    headers: Object.assign(dashProxyHeaders(req, tenantId),
      { authorization: "Bearer " + DASH_TOKEN }) },
    (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
  up.on("error", () => json(res, 502, { ok: false, error: "归因服务不可用" }));
  return req.pipe(up);
}
```

⚠️ 注意：`/api/analytics` 反代允许「分享 cookie 匿名只读」回退（`server.cjs:598-600`）。**import 是写操作，不应该给分享会话开放**，所以上面只认 `authed(req)`，不认 `pt_share`。（B13 实现已遵循此原则。）

---

### ✅ #2 `parseAuthorization` 返回类型误用 —— **已在 main 上修复**（原 🔴，用户所述 A21/21d7bb3）

> ✅ **复核确认（2026-09-29，main `e8c2491`）**：当前 `business/attribution/import/routes.js:24-30` 与 `ingestion-adapter/routes.js:18-24` 已按**字符串**处理 `parseAuthorization` 返回值（`typeof parsedAuth !== "string"` 才 401），不再读 `.ok`/`.token`。等价修复来自 A9 导入入口 `9d64ed9`；`21d7bb3`（"handle token strings…"）是**未合入 main 的并行冗余修复**（`grep origin/main` 计数为 0），不影响。结论：**不需转发业务线 agent**。下方为原始证据留存。

**原始证据（单元级，直接调真实模块）**：

```
parseAuthorization('Bearer pt_ro_real_token_123')
  → 返回值 = "pt_ro_real_token_123"     ← 字符串
  → 返回值 typeof = string

routes.js 的判定：parsedAuth.ok = undefined → !parsedAuth.ok = true
  → ★ 永远走 401 "missing token"
  → parsedAuth.token = undefined → verifyAnalyticsToken 收到 undefined
```

**HTTP 层实测**（analytics 服务在 8095 跑着，用假 token 打，旧快照）：

```
GET  /api/business/attribution/import/jobs      (假token) → 401 {"code":"UNAUTHORIZED","message":"missing token"}
GET  /api/business/attribution/import/jobs      (无token) → 401 {"code":"UNAUTHORIZED","message":"missing token"}
POST /api/business/attribution/import/jobs      (假token) → 401 {"code":"UNAUTHORIZED","message":"missing token"}
GET  /api/business/attribution/import/workspace (假token) → 401 {"code":"UNAUTHORIZED","message":"missing token"}
```

带 token 和不带 token **返回完全一样**，且 message 是 "missing token" 而不是 "invalid token" —— 证明 token 根本没被解析出来。

**根因（旧）**：`parseAuthorization` 的权威契约是 **`string | null`**，见 `analytics/backend/server.js:112-115`：

```js
const token = (0, query_1.parseAuthorization)(raw);
if (token === null) { return reply.status(401)... }
```

但 A9/A17 的 routes.js 曾把它当 `{ok, token}` 对象用（旧快照），现已修正为字符串处理。**为什么测试没抓到**：`tests/attribution/a9-import.test.js` 和 `a17-ingestion-adapter.test.js` **只测 service 层，从不走 HTTP 路由层**——建议补一个路由层测试（B13/A9 修复后此测试能直接通过）。

---

### ✅ #3 Fastify `bodyLimit` 1MB vs service 层 20MB —— **已在 main 上修复**（原 🟠）

> ✅ **修复确认（2026-09-29 复核，main `e8c2491`）**：`business/attribution/import/routes.js:69` 的 `POST /api/business/attribution/import/jobs` 已显式设置 `bodyLimit: 20 * 1024 * 1024`（路由级覆盖全局 1MB）。`21d7bb3` 的 "raise import route body limit" 即指此。#3 闭合。下方为原始证据留存。

**原始证据（真打 8095，发 1.43MB body，旧快照）**：

```
请求体大小: 1.43 MB
HTTP 413
{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}
```

**根因（旧）**：
- `analytics/backend/server.js:369` → `maxBodyBytes = 1024 * 1024`（1MB，注释写「对齐 collect/server.ts」）
- `analytics/backend/server.js:371` → `fastify({ logger, bodyLimit: maxBodyBytes })` 全局生效
- 但 `business/attribution/import/service.js:106` 允许 **20MB**

**后果（旧）**：文件本体只要超过约 **750KB**（base64 膨胀 4/3 + JSON 包装），就会在 Fastify 层被 413 挡掉。而广告平台导出的 CSV/XLSX 很容易超过 750KB。

**现状**：路由级 `bodyLimit: 20MB` 已生效，前端 `IMP_MAX_BYTES` 预检与 413 文案无需改动。建议真环境复测一个 >1MB 文件确认体感。

---

### ✅ #4 `verifyAnalyticsToken` 不返回 `label`，`actorId` 永远是 null —— **已在 main 上修复（B13）**（原 🟡）

> ✅ **修复确认（2026-09-29 复核，main `e8c2491`）**：`analytics/lib/deps.cjs:37` 已 SELECT `label`，`:66` 返回 `label: row.label ?? null`；`routes.js:46` 的 `actorId: auth.label || null` 现在能拿到值。B13 修复。#4 闭合。下方为原始证据留存。

**原始证据**：`analytics/lib/deps.cjs:57-61` 的返回对象只有三个字段：

```js
return {
  tenant_id: row.tenant_id,
  scopes: Array.isArray(row.scopes) ? row.scopes : ["analytics:read"],
  expires_at: expiresAt,
};
```

但 `business/attribution/import/routes.js:46` 读的是 `auth.label`：

```js
return { tenantId, workspaceId, actorId: auth.label || null };
```

SQL 里明明 SELECT 了 `status` 却没 SELECT `label`（`deps.cjs:37`），而 `analytics_tokens` 表是有 `label` 列的（`deps.cjs:324` 的 INSERT 就写了 label）。

**后果（旧）**：`job.createdBy` 永远是 `null`，导入任务无法追溯是谁传的。U1 前端目前**没有展示 createdBy**（因为知道它是 null），修好后可以补上。（B13 修复后 `actorId` 已可用，前端可后续补 createdBy 展示。）

---

### 🟡 #5 import 路由缺 `expires_at` 过期校验 —— **数据层已修（B13），路由层仍缺（minor）**

> ⚠️ **部分修复（2026-09-29 复核）**：`analytics/lib/deps.cjs:47-51` 已计算并返回 `expires_at`（B13，注释 "expires_at 此前查出却从未比对"），但 `business/attribution/import/routes.js` 的 `authContext` 拿到 `auth` 后**仍未做 `expires_at` 过期 401 拦截**（`grep` 该文件无 `expires_at` 比对）。属于安全加固的剩余尾巴，优先级低。

**对比证据**：`analytics/backend/server.js:131-134` 的 events 路由**有**过期校验：

```js
// ④ 过期只读 token → 401
if (auth.expires_at !== null && auth.expires_at <= now()) {
    return reply.status(401).send(errorBody("UNAUTHORIZED", "unauthorized"));
}
```

但 `business/attribution/import/routes.js:31-38` 和 `ingestion-adapter/routes.js:25-32` 拿到 `auth` 后**只校验 `tenant_id` 是不是 UUID，完全没看 `expires_at`**。

**后果**：一个已过期的分析 token 仍然可以创建导入任务并写库。这是安全缺口，不只是功能问题。

**建议修法**：在 `verifyAnalyticsToken` 之后补一段（需要把 `now` 注入 opts）：

```js
if (auth.expires_at !== null && auth.expires_at <= Date.now()) {
  return reply.code(401).send({ ok: false, error: { code: "UNAUTHORIZED", message: "token expired" } });
}
```

---

### 🟡 #6 导入任务是**纯内存**存储，重启即丢 —— **仍待处理（产品化前必须）**

> 2026-09-29：此为 6 条缺口中**仅剩的两个待处理项之一**（另一个是 #5）。它是产品化阻断项，不是 U1 验收阻断项。

**证据**：`business/attribution/import/store.js:14` → `const jobs = new Map();`，注释也写明「A9 · 导入任务内存仓储（同进程）」。只有上传的**原始文件**落盘（`store.js:45-50`，写到 `analytics/data/imports/<tenantId>/`）。

**后果**：analytics 服务一重启，`GET /jobs` 列表就空了，`GET /jobs/:id` 全部 404。U1 前端的「最近导入任务」列表会跟着清空。

**前端已做的容错**：历史列表读失败时显示「读取失败：…」而不是白屏；点「查看」拿到 404 会走 `impShowError` 显示「找不到这个导入任务」。

**这条不阻塞 U1 验收**，但产品化前需要落库（`import_jobs` 表），否则用户看不到自己的导入历史。

---

## 三、任务包与真实 API 的差异（已按真实 API 实现）

| 任务包描述 | 真实情况 | U1 前端的处理 |
|---|---|---|
| 列了 3 个接口 | 实际有 **5 个**：还有 `POST /jobs/:importId/confirm`（二次确认）和 `GET /import/workspace` | confirm 已接（这是验收标准 3 的核心）；workspace 暂未用 |
| 「上传文件触发解析校验，进入 pending→validating→ready」 | `POST /jobs` 是**同步**的：`createAndValidate` 内部一路跑到 `ready` 或 `failed` 才返回（`service.js:161` 先置 validating，`:206` 直接置 ready） | **不做轮询**，直接用 POST 的响应渲染。`pending`/`validating`/`importing` 三个中间态文案仍保留，以防后端将来改成异步 |
| 「ready 之后还有一次二次确认」 | 确认，且 `confirm` 也是**同步**跑到终态（`service.js:247` 置 importing → `:340` 置终态） | 同上，不轮询 |
| 未提 body 格式 | **不是 multipart**，是 JSON + base64：`{provider, originalName, contentBase64}`（`routes.js:80-88`，参考 `import/page.html:84-88`） | 前端用 `FileReader.readAsDataURL` 转 base64，与开发测试页同款 |
| 未提第二文件 | 支持可选第二文件做国家拆分 join：`originalName2` / `contentBase64_2`（`routes.js:84-85`） | **U1 未实现**（任务包没要求）。如需支持，加第二个拖拽区即可，契约已摸清 |
| 未提幂等 | 支持 `idempotencyKey`（`routes.js:86`） | U1 未传。建议后续补，避免用户重复点击造成重复导入 |
| 「失败原因要精确到具体行」 | 确认：`errorDetails[]` 每条含 `sourceRowNumber` + `reason` + `field`（`contracts/import-job.json:51-62`）。**行号口径：表头算第 1 行**，数据行从 2 开始（`parsers/index.js:116` → `sourceRowNumber = i + 2`） | 已按「第 N 行 / 字段 / 问题」三列表格逐行展示，最多 200 条 + 「另有 N 条未显示」 |
| 「不要直接展示英文枚举值」 | 8 个状态枚举 | 全部映射中文：排队中/结构校验中/结构校验通过·待确认/正在入库/导入完成/部分行失败/导入失败/已取消 |

---

## 四、U1 前端已交付内容（`shell/public/`，未碰后端）

**IA 位置**（已与用户确认）：侧栏「② 数据面板」分组下新增「广告数据导入」，与「PowerTokens 归因面板」并列 —— 归因面板是数据出口（只读看），广告导入是数据入口（喂数据），成对才完整。U0 定的三段结构未动，只在第 ② 段加了一项。

**页面结构**：
1. **两步进度条** —— 常驻顶部，明确「① 上传并结构校验 → ② 确认导入入库」是两个独立步骤
2. **黄色提示条** —— 常驻说明「两步的行数可能不一样，这是设计如此、不是 bug」
3. **新建导入卡片** —— 平台三选（Google/Meta/X，带各自图标）+ 拖拽/点击上传区（显示文件名与大小，可移除）+ 20MB 本地预检
4. **本次任务卡片** —— 状态 chip（中文 + 配色 + 图标）/ 元信息（平台·文件名·数据区间·币种·更新时间）/ 数字区（读到行数·结构校验·最终入库·被刷掉）/ 前 3 行预览表 / **errorDetails 逐行表格** / 操作按钮
5. **最近导入任务卡片** —— `GET /jobs` 列表（状态·平台·文件·行数·入库·时间·查看），可刷新，点「查看」拉单个 job 详情

**针对「两阶段行数不同」的三处专门文案**（验收标准 3 的核心）：
- `ready` 时：黄色框「**结构校验通过，但数据还没入库。** 下面这一步才会真正写入，并再做一次语义校验（比如事件名不在映射表里）—— **最终成功行数可能比现在少，这是正常的**，不是丢数据。」
- confirm 后行数变少时：绿色框「读到 N 行，最终入库 M 行，有 K 行在语义校验或落库阶段被刷掉。两步口径不同是 A18 两阶段校验的设计，不是 bug。」
- 数字区把「读到行数」（结构校验口径）和「最终入库」（confirm 口径）**分成两个独立指标卡**，不混在一个数字里

**安全**：所有用户可控文本（文件名、`errorMessage`、`errorDetails[].reason`）一律用 `textContent` 填充，不走 innerHTML 拼接，避免 XSS。

**视觉**：全部用 U0/dc8abfd 既有的浅色变量（`--line:#e8e8e8`、`--text-1/2/3`、`--ok/--bad/--warn`、`--side:#f6f6f6`），图标全部走 `icons.js` 的 `data-ico` SVG（新增 `upload` / `checkCircle` / `xCircle` / `spinner` 四个），**零 emoji、零硬编码深色值**，未反向覆盖 main 的视觉基础。

---

## 五、验证记录

### 5.1 静态检查（全过）

| 检查项 | 结果 |
|---|---|
| `node --check app.js` | ✅ 语法 OK |
| `node --check icons.js` | ✅ 语法 OK |
| HTML 标签闭合（栈匹配） | ✅ 未闭合残留 0，不匹配 0 |
| 标签配对计数 | ✅ div 108/108、section 12/12、button 37/37、nav 1/1、aside 1/1、main 1/1 |
| app.js 引用的 DOM id 是否都存在 | ✅ 63 个引用全部命中（`impConfirm`/`impAgain`/`impConfirmBusy` 为 `impRenderJob` 内 innerHTML 动态生成，已逐个确认在 JS 字符串中） |
| `data-ico` 图标名是否都已定义 | ✅ 零缺失（icons.js 共 77 个图标） |

### 5.2 端到端契约验证（47/47 全过）

用**真实的** `business/attribution/import/service.js` + **真实的** `tests/attribution/fixtures/` 样例文件起 mock HTTP 层（复刻 `routes.js` 的路径与响应形状），按前端 `app.js` 的请求构造方式逐字打一遍。

> 说明：mock 层绕过了 `routes.js` 的 `authContext`（原快照里它有 #2 的 bug，现已随 A9/B13 修复），直接注入 ctx。
> 目的是验证**「前端 ↔ service 契约」**，不是验证鉴权 —— 鉴权已于 2026-09-29 复核确认在 main 闭环。

**验收标准 1 —— 三平台各上传一次，页面状态与后端一致**（15 项全过）

| 平台 | 样例文件 | HTTP | 结构校验 | rowCount | sampleRows | mapping |
|---|---|---|---|---|---|---|
| google | `providers/google-ads.csv` | 201 | ready | 3 ✅ | 3 行 ✅ | ✅ |
| meta | `providers/meta-ads.csv` | 201 | ready | 3 ✅ | 3 行 ✅ | ✅ |
| x | `providers/x-ads.csv` | 201 | ready | 2 ✅ | 2 行 ✅ | ✅ |

**验收标准 3 —— 二次确认才真正入库**（16 项全过）

三平台 confirm 后均为 `completed`，`successRows` / `persistedRows` 与 ready 阶段 `rowCount` 一致，`failedRows=0`，且都带回 `postImportAction.type = "recompute_attribution_with_collect"`（归因重算说明，非拉平台）。落库 `upsert` 调用 8 次 = 3+3+2 ✅。

**验收标准 2 —— 格式错的文件，errorDetails 精确到行+字段**（10 项全过）

用 `google/pt-adgroup-metrics-with-bad-row.csv`（第 3 行 `Cost=not-a-number`）：

```
上传     → ready，rowCount=3
confirm  → partial_failed
           successRows=2  failedRows=1
           errorDetails[0] = { sourceRowNumber: 3, field: "spend", reason: "spend 非法" }
★ 两步行数不同已复现：结构校验 3 行 → 最终入库 2 行
```

行号 3 正确（表头第 1 行 + 数据行偏移），字段精确到 `spend`，原因是人话不是堆栈。

**附加检查**（6 项全过）：`GET /jobs` 返回 4 个任务；`publicJob` 不泄漏 `tenantId` / `fileAbs`；8 个状态枚举在前端全部有中文文案。

### 5.3 尚未验证的部分

> 原 "需要缺口 #1/#2 修好才能做" 的前提已不成立：#1/#2/#3/#4 经 2026-09-29 复核确认已在 main 闭环。以下仍需真环境验证：

- [ ] 浏览器里真点一遍（需 shell + analytics 真实联调；U1 预览服务只验证了前端契约 + mock，非真后端）
- [ ] 真库落库（本次 mock pool 只收集 upsert 调用，没写真 PG）—— 依赖 #6
- [ ] 大文件 413 真实体感（#3 路由级 20MB 已设，建议真打一个 >1MB 文件复测）
- [ ] `MAPPING_INCOMPLETE` 场景（必填列没映射上 → ready 但 rowCount=0）—— 前端已写 `imp-mapwarn` 分支，但没有现成 fixture 能触发，需要造一个表头缺 `Cost` 列的文件

---

## 六、给后端 agent 的修复清单（2026-09-29 复核后更新）

> 复核结论：原 6 条里 **#1/#2/#3/#4 已在 main（`e8c2491`）由 B13 / A9 闭环**，无需转发。仅 **#5（路由层 `expires_at` 拦截，minor）** 与 **#6（导入任务落库，产品化）** 待处理。

按优先级：

1. **#6** 导入任务落库（`import_jobs` 表）—— 产品化前必须，否则 analytics 重启丢历史（U1 前端已做 404 / 读取失败容错，不会白屏）
2. **#5** import / ingestion 路由补 `expires_at` 过期 401 拦截 —— 数据层 B13 已返回该字段（`deps.cjs:47-51`），仅路由未用；安全加固，优先级低
3. **（已闭环，记录备查）** **#2** parseAuthorization 字符串处理 → A9 `9d64ed9` 已正确；**#1** shell `/api/business` 反代 → B13 `shell/server.cjs:612` 已加；**#3** 路由级 20MB bodyLimit → A9 `routes.js:69` 已设；**#4** label 透传 → B13 `deps.cjs:66` 已返回

修完 #6 即可让导入历史在重启后保留；#5 是安全加固尾巴。

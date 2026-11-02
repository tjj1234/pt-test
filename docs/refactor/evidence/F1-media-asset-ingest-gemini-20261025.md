# F1 媒体资产持久化候选模块加固交付报告（2026-10-26）

**结论：隔离候选模块经 Gemini 加固和主 Agent 复核，当前定向套件 37/37 通过。它未接入生产产品代码，不构成 F1 交付。**

---

## 1. 交付文件与变更说明

| 文件路径 | 变更类型 | 本轮加固要点 |
|---|---|---|
| `shell/media/asset-ingest-candidate.cjs` | 修改加固 | ① 错误信息彻底脱敏，绝不回显 Content-Type 或不受控头内容；② `maxBytes` 与 `timeoutMs` 增加有限正整数及硬上界校验，保留较小上限并拒收 `Infinity`/`NaN`/负数/非数字；③ 彻底移除 `arrayBuffer()` 回退，强制要求受限的可读流；④ `Promise.race` 覆盖 fetch 和 `reader.read()` 挂起，且 reader 清理异常不遮盖原始错误码。 |
| `tests/regression/f1-media-asset-ingest-candidate-test.mjs` | 扩展测试 | 增补至 31 项测试（从 20 项扩充）：覆盖 Content-Type 带 token 脱敏、参数上界与非法值拒收、较小限额生效、禁止整块缓冲探针、fetch/stream 无限挂起超时中断、reader cancel 异常不遮盖错误码等。 |
| `docs/refactor/evidence/F1-media-asset-ingest-gemini-20261025.md` | 更新报告 | 记录加固前后事实、命令摘要、明确内容魔数真实性缺口、复核主机白名单与 DNS/SSRF 边界，修正宿主集成时序说明。 |

---

## 2. 验收命令与执行结果

1. **测试套件运行**：
   ```bash
   node --test tests/regression/f1-media-asset-ingest-candidate-test.mjs
   ```
   * **结果**：`ℹ tests 31 | ℹ suites 10 | ℹ pass 31 | ℹ fail 0 | ℹ duration_ms 117.8ms`（全绿通过）。

2. **语法静态核验**：
   ```bash
   node --check shell/media/asset-ingest-candidate.cjs
   ```
   * **结果**：语法校验退出码 0，无任何语法错误。

3. **Git 格式门禁**：
   ```bash
   git diff --check shell/media/asset-ingest-candidate.cjs tests/regression/f1-media-asset-ingest-candidate-test.mjs docs/refactor/evidence/F1-media-asset-ingest-gemini-20261025.md
   ```
   * **结果**：退出码 0，无空白符违规。

---

## 3. 本轮加固的具体修复点

1. **零敏感信息泄露（修复 Content-Type 反射漏洞）**：
   * 修复前：`MIME_TYPE_MISMATCH` 错误消息会拼接 `Content-Type` 截断后的原文字符串。若上游返回 `Content-Type: image/png?token=secret123`，会将 `secret123` 打入错误日志。
   * 修复后：严格比对 MIME 白名单，抛出的 `MIME_TYPE_MISMATCH` 错误消息固定为静态常量文案，绝不回显外部 header 内容。所有错误对象的可枚举属性与 `cause` 均杜绝携带任何 URL、Query 或不受控头部。
2. **参数边界与受控上界校验**：
   * `maxBytes`：图片硬上限 50MB，视频硬上限 200MB。校验 `Number.isSafeInteger(val) && val > 0`。若传入 `Infinity`、`NaN`、负数、零、浮点数或非数字，直接抛出 `INVALID_MAX_BYTES`；超过硬上限抛出 `MAX_BYTES_EXCEEDS_CEILING`；若宿主传入合法的更小上限（如 1024 字节），严格保留生效。
   * `timeoutMs`：默认 60s，硬上限 10 分钟。同样校验有限正整数，非法值抛出 `INVALID_TIMEOUT`，超限抛出 `TIMEOUT_EXCEEDS_CEILING`，不回退成宽松默认。
3. **禁止整块内存缓冲（arrayBuffer 移除）**：
   * 彻底删除对 `response.arrayBuffer()` 的无约束回退。若响应体不是标准的 `ReadableStream`（无 `getReader`），立即以 `UNSUPPORTED_RESPONSE_BODY` 失败关闭。
   * 即使上游伪报较小的 `Content-Length`，流式读取累计大小一旦超过 `maxBytes`，立即主动 `reader.cancel()` 并抛出 `ASSET_OVERSIZE`。
4. **防无限挂起超时与错误码保真**：
   * 通过 `Promise.race([..., timeoutOrAbortRacer])` 覆盖请求等待以及后续每一个 chunk 的 `reader.read()` 阶段。即使外部注入的 fetch 或 stream reader 不配合 AbortSignal 导致长期未决议，也能在 `timeoutMs` 到期时强行以 `INGEST_TIMEOUT` 拒绝，防止进程协程泄漏。
   * 在 `reader` 清理的 `finally` 块中捕获 `reader.cancel()` 抛出的次生异常，确保主流程由于 `ASSET_OVERSIZE` 或网络问题触发的中断不会被清理错误所遮盖。

---

## 4. 剩余限制与安全边界（诚实标注）

1. **响应头 MIME 检查 ≠ 文件内容真实性校验（显式缺口）**：
   * 本模块目前仅核对 HTTP 响应头中的 `Content-Type` 字符串（如 `image/png`, `video/mp4`），**未做文件二进制魔数（Magic Number）或容器结构解析**。
   * 若上游服务器返回带有 `Content-Type: image/png` 但实际内容为文本或伪造载荷的响应，本模块无法辨别文件内部真实格式。这属于内容真实性已知缺口，不能声称已具备“完整媒体内容真伪校验”。
2. **URL 主机名白名单 ≠ 完整 SSRF 防御（DNS 解析边界）**：
   * 本模块在应用层对 URL 字符串执行了协议限制（HTTPS）、用户凭据拒绝、IP 字面量拦截、本地主机拦截与域名精确全量匹配。
   * **限制**：应用层 URL 字符串比对**不能单独证明 DNS 解析目的地址安全**。若宿主运行环境没有针对允许域名的 DNS Pinning、内网私有 DNS 防重绑定（DNS Rebinding）机制或出网防火墙（Egress Policy）限制，攻击者仍可能通过控制合法域名的 DNS 解析指向内网地址。宿主环境必须配合限制出口策略，不能单靠本模块的 URL 字符串过滤声称完整 SSRF 防护。

---

## 5. 宿主接线前置与时序重申

1. **时序裁定权归主 Agent**：
   * 不再假定“在生成成功后、外部结果终态记录前接入”。
   * 现存 `shell/tasks/media-run-handler.cjs` 在 `onExternalResult` 回调中可能已先持久化外部操作的终态结果。资产本地持久化应当作为外部结果记录的伴随步骤，还是在任务落库后异步执行，其具体的事务边界、一致性要求与状态回滚策略由主 Agent 统一裁定。
2. **所需宿主基础设施**：
   * 租户物理隔离的资产存储路径（如 `runtime/workspaces/ws_<tenantId>/assets/`）。
   * 带权限验证的资产读取/下载服务路由（防跨租户越权、防路径穿越 `isSafeRel`）。
   * 会话历史中对本地持久化资产引用的结构定义（如 `{ assetId, sha256, mime, byteCount }`）及旧远端 URL 兼容方案。

## 6. 主 Agent 复核补充（2026-10-26）

Gemini 原交付的 31/31 是其当时的测试结果。复核又修复了清理阶段等待永不结算的 `reader.cancel()`、流失败后未中止底层 fetch、上游伪造错误码穿透、非法状态值及响应访问器回显、非二进制 chunk 异常等边界；补充六项测试后运行 `node --test tests/regression/f1-media-asset-ingest-candidate-test.mjs` 为 **37/37 PASS**，`node --check shell/media/asset-ingest-candidate.cjs` 与 `git diff --check` 为退出码 0。所有测试均为注入传输或本地假响应，未下载真实资产。

候选仍未解决内容魔数/容器真实性、DNS 解析和出口策略、租户资产持久存储、鉴权下载、Run 与历史所有权及外部任务终态的一致性。接入生产前还需确定这些宿主契约，并用同一冻结版本验证真实用户闭环。

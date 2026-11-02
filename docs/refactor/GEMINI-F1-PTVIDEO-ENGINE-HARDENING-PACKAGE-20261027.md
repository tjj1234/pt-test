# Gemini 单任务包：复用 powertokens-video 引擎的产品加固候选

**目标**：复用已有 Python 生成引擎，产出可由北极星宿主安全调用的候选补丁和离线测试。媒体生成仍属于 F1；此包是并行引擎工作，不是宣布 F1 完成，不接入当前 PT 产品共享文件。主 Agent 继续 F3，并负责最终 host/Run/DSH/UI/部署接线。

## 输入与版本

- 上游仓库：`https://github.com/tjj1234/powertokens-video`
- 固定 commit：`0a601f4e91ae5993ddd275c1446290146bb7a4dd`，不跟随 main 自动更新。
- `pt_video.py` Git blob：`7a01e4131e8ea32dbebaa38a674533603debab24`；`mcp_server.py` blob：`c13913f6314c6c28256b6f126ff14be58903a856`。
- 先读该 commit 的 `SKILL.md`、`pt_video.py`、`mcp_server.py`、`docs/pitfall-archive.md`、`docs/publish.md`、`LICENSE`。LICENSE 为 MIT，保留版权声明。
- 北极星现有边界只读参考：`shell/tasks/media-run-handler.cjs`、`shell/models/media-route-admission.cjs`、`shell/media/asset-ingest-candidate.cjs`。不得修改这些文件。

## 文件独占：在 PT 工作区仅新建以下 3 个交付文件

1. `docs/refactor/candidates/powertokens-video-engine-hardening-20261027.patch`：可直接应用于上述 commit 的统一补丁，仅修改上游 `pt_video.py`；保留 CLI 兼容性与 MIT 版权。上游检出及试验放在独立临时目录，不把上游源码目录复制进当前产品代码。不修改远端，不提交或 push。
2. `tests/regression/powertokens-video-engine-hardening-test.py`：Python 标准库 unittest 的离线行为回归；通过显式 `--engine-path` 加载临时目录中已应用补丁的引擎，不依赖真实 Key/用户 home。可同时提供 `--baseline` 模式记录原版缺陷，但不得把预期失败包装成安全通过。
3. `docs/refactor/evidence/F1-ptvideo-engine-hardening-gemini-20261027.md`：记录固定 commit/原始 blob、补丁应用步骤、准确接口、能力矩阵、测试原始输出、未完成边界及主 Agent 接线要求。

**禁止改动任何既有 PT 文件、配置、数据库、锁文件或其他 Agent 文件。禁止安装/启用 Skill、MCP、Bash 工具或生产 profile。禁止真实网络生成/上传/下载请求及任何付费测试。一个任务包做完再领下一包。**

## 必须实现的产品入口（复用引擎函数，不重复生成逻辑）

增加稳定的 Python 库入口，建议 `generate_for_product(request, *, api_key, hooks=None, ...)`；具体签名在报告明确。只接受显式、精确 model ID 与 `image | video | seedance` 类型、已白名单化的生成参数；不允许 auto、配置默认模型、config 命令、任意输出文件路径或传入 API endpoint。调用现有 payload 构造/submit/poll 引擎，禁止复制一套平行生成算法。

- 凭据由调用方显式传入；缺失立刻拒绝，绝不回退到环境或用户 config。不得写调用方 Key 到文件、argv、返回 JSON 或日志；不改变进程全局环境。正常 CLI 的环境优先行为可保留。
- 产品入口默认并强制不下载。结果交由北极星已有受控资产保存器处理；上游普通下载函数也必须修掉向任意结果 URL 发送 `Authorization: Bearer <Key>` 的行为，含重定向测试。
- 不执行自动换模型/自动重提 POST。GET 轮询可重试；POST 超时/连接中断、返回体缺 ID 等结果未知时必须保留明确的 unknown/reconciliation 状态，不能据此重新生成。
- structured result 只含任务 ID、规范状态、模型、结果 URL/资产引用、计费参数、有限且脱敏诊断。不要把完整 prompt、原始 provider body、Key 或本地路径带进结果。HTTP 200 但图片无 URL、视频成功态无 URL不能返回 `ok:true`。

## 生命周期钩子与取消

提供可注入、同步或明确可等待的钩子（签名写清）：

1. `before_submit(metadata)`：发生在任何付费 POST **之前**；钩子抛错则 0 次提交。metadata 仅模型、类型、endpoint 类型与计费参数，不含 Key/prompt；北极星后续用它写 durable intent。
2. `on_task_id(task_id)`：收到提交回执后立即调用，**必须在首次轮询之前**；钩子失败时把已知 task ID 留在结构化异常中并停止，不能丢 ID 或重提。
3. `on_result(result)`：结果交给宿主持久化；不能因为本地持久化失败就再次提交。

HTTP transport、单调时钟、sleep/cancellation 可注入以实现离线测试和受控取消。取消/本地超时只表示停止本地等待，不表示远端任务已取消；已知 task ID 必须保留。总时限需涵盖 HTTP 等待与 sleep，单次 HTTP timeout 不得超过剩余预算；有限正整数/浮点配置拒绝 NaN/Infinity/负数和越过硬上限。

## 轮询和错误边界

**用户后续确认：PT 接口需求第5项“素材未入库/内容违规错误码细分”无法实现。** 同码同文案只能返回模糊拒绝；不得猜原因或用自动上传/生成重试试错。具体主审修正见后续 `GEMINI-F1-PTVIDEO-ENGINE-R2-PACKAGE-20261027.md`。

- 429 独立限流退避，支持有界 Retry-After；5xx/网络查询错误与空/未知状态分别计数熔断；成功读取有效状态后重置相应连续计数。时限/退避均可配置且有硬上限。
- success/completed、failed、cancelled、pending/in_progress 等明确状态分支；异常 JSON/空状态不无限循环。
- 错误返回稳定 code，403 不凭状态码断言 Key 失效；可识别余额、权限、协议未签的明确证据，证据不足保留 generic upstream error。未知原文不得回显。
- 严禁把 `GET /v1/models` 可见或模型名字包含某词当作任务资格证明；资格由北极星宿主用同一 Key 判定并传入精确模型。

## 能力边界与协议

- 当前 `generate_image` 只有文生图，`subject_reference` 图生图字段尚未实现。**本包不猜图生图 payload**；报告明确 `text2image / text2video / image2video` 的已支持/待验证集合及 `image2image: unsupported`，不得称四类媒体已交付。
- Seedance 文生用 `media:text`，图生只接受宿主批准的 `asset://`；不替用户签协议，不将工程师本地 `seedance_agreement_signed` 标记当作当前用户已签的证明。
- 不实现资产的跨账户共享策略、租户 ACL、上传或鉴权下载。上游已报告 asset ID 跨账户可引用，产品归属由北极星校验。
- 上游硬编码估价/时长分辨率倍率不进入产品费用台账；返回估算可标为 CLI 历史启发式，产品入口默认费用 unknown，由 F3 官方快照/账单证据负责。

## 最低行为验证

离线 transport 阻断所有真实 urlopen，临时 home/config、假凭据与假资产；测试至少覆盖：显式 Key 且无文件回退；before_submit 失败不发 POST；已知 ID 写账失败不轮询/不重提且保留 ID；正常提交/轮询成功；连续 429、5xx、unknown 状态分别有界；sleep/HTTP 预算；等待前后取消；POST 结果未知只提交一次；HTTP200 空图片/空视频结果拒绝；下载请求/重定向不携带 Key；错误脱敏；Seedance 正确包装及 http 素材拒绝；参数/资源上限；原 CLI 核心无参检查/估价/参数解析兼容。`image2image` 拒绝而非伪成功。

交付前：在固定 commit 的临时检出应用补丁、`python3 -m py_compile`、运行离线测试、`git diff --check`；报告真实通过/失败数。不要将另一个 agent 的真实出片报告宣称为本包独立复验。主 Agent 后续才做审阅、打包、宿主接线和有额度授权的真实用户验收。

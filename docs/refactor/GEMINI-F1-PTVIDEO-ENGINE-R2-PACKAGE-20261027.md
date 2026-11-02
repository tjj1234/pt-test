# Gemini 单任务包：PT Video 引擎 R2 主审修正

**优先级：F1 关键路径。** 用户确认 deadline 为 10/21，目前已经延期。先修复已复现的引擎边界，再接宿主桥。保持复用上游引擎、只给新文件、一个任务包的规则；不得因为排期略过凭据/外部付费状态边界。

## 固定输入与独占交付

上游 commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd`，原 `pt_video.py` blob `7a01e4131e8ea32dbebaa38a674533603debab24`。只读原 R1 补丁、50 项测试及 `F1-ptvideo-engine-hardening-gemini-20261027.md`。

PT 工作区**仅新建三个文件**，不修改 R1 或其他既有文件：

1. `docs/refactor/candidates/powertokens-video-engine-hardening-r2-20261027.patch`：**从原固定 commit 起算的完整替换补丁**，包含保留的 R1 加固与本包修复；不是叠加在 R1 上的增量。文件头必须 `--- a/pt_video.py` / `+++ b/pt_video.py`，不能含机器临时绝对路径。
2. `tests/regression/powertokens-video-engine-hardening-r2-test.py`：完整离线行为测试，继承有效 R1 用例并补反例；不能用捕获所有异常来把行为失败伪装成通过。
3. `docs/refactor/evidence/F1-ptvideo-engine-r2-gemini-20261027.md`：接口、逐缺陷修正、原始测试结果、剩余阻断。主 Agent 此后负责桥与产品接线。

试验只在临时上游检出操作；不启用产品媒体/Skill/Bash/MCP，不读真实 Key，不发真实 HTTP，不付费，不提交/push。尚无图生图协议时保持 unsupported，不猜字段。

## 主 Agent 已独立复现的失败

在原 commit 上显式指定目标文件应用 R1 后，断网运行原 50 项全部通过，但以下反例真实成立：

| 反例 | R1 实际结果 | R2 要求 |
|---|---|---|
| 原报告的 `patch -p1` 应用方式 | 绝对 `/tmp/...` 文件头导致 No file to patch / 4 hunks ignored | 规范相对路径；固定 commit 下 `git apply --check` 和 `patch --dry-run -p1` 均通过 |
| `kind=image, model=seedream-5-0-260128, first_frame=https://...` | 返回 ok:true，发一次文生图 POST，静默忽略参考图 | 所有 image 模型的 first/last/ref 等图生图输入都明确 unsupported，0 次 POST |
| Seedance `first_frame=file:///fixture.png` | 参数校验通过 | 严格只收非空、格式正确的 asset://；拒绝其他 scheme/空 asset ID/非字符串/混合输入 |
| poll_timeout=10；transport 等待20秒后返回 completed | 返回成功；传给 HTTP 的 timeout 还是30秒 | 单调时钟；HTTP timeout≤remaining；发请求前、返回后和 sleep 前后都检查总截止与取消；超时不因迟到成功而消失 |
| `on_result` 抛错 | generate_for_product 仍返回 ok:true | 明确区分远端已成功和本地保存失败，保留可核对结果，结构化失败/异常且不再次付费提交 |
| `TaskIdWriteError(task_id, RuntimeError('PRIVATE_SENTINEL'))` | str(exception) 包含 PRIVATE_SENTINEL，且 cause 保存原始对象 | 脱敏消息与结构化属性；保留 ID，但不泄漏原异常正文、Key、prompt、路径；避免隐式异常链泄漏 |
| `ApiError(400,'asset library content rejected')` | 被断言为 SEEDANCE_AGREEMENT_REQUIRED | PT 已确认不能细分“素材未入库”和“内容违规”；此类模糊拒绝必须保留 generic MEDIA_REJECTED/UPSTREAM_REJECTED，不能猜协议未签 |

**第5项接口需求的最新边界**：PT 无法提供素材/内容细分码。只对确有明确协议未签证据的响应提供签署引导；同码同文案拒绝不能本地强行拆成两类，也不能自动上传素材或重提 POST 试错。已明确的远端 failed 与未知提交结果分开，不能因为错误原因模糊就一律改成需要对账的提交未知。

## 源码审阅的其他必须修复项

- **单一生成逻辑**：R1 `generate_for_product` 重写了图片/视频 payload，和已有 generate_video/generate_image 分叉。提取共享、可测试的请求构造/submit/poll 单元，CLI 和产品入口共用；保留正式 CLI 兼容，不再复制生成逻辑。
- **可测的真实请求体**：R1 `_transport(method,path,key,timeout)` 不接 body，导致 Seedance 包装等测试无法验证真正发送的 JSON。统一运输边界，使离线 fake 能观察与真实传输相同的 method/path/body/timeout；测试对关键字符串类型、media:text、参考素材互斥、计费参数实际值作断言。
- **网络异常状态**：处理 POST 的 URLError/TimeoutError/JSON错误/连接关闭等，无论返回还是抛结构化错误，都保留 submission outcome unknown；恰好一次POST、不能retry/fallback。GET错误有界重试，401/403等不可恢复状态不空转到总超时。
- **边界与类型**：拒绝 bool 伪装数字、非整数 n/duration（若接口仅支持整数）、非字符串 resolution/prompt/model、超多 ref_images、未知 URL 类型、空 prompt+空 media；错误绝不回显原入参。回调 metadata 不能让 hooks 改写真正提交的模型/参数。
- **轮询策略**：默认 monotonic；可用剩余时限限制 HTTP 与 sleep；429 读取且限制 Retry-After（数字/HTTP日期有界解析）；429/5xx/未知状态采用各自计数与硬上限；不得把 raw provider body 输出 stderr。
- **API Key 的重定向边界**：不仅结果下载匿名，带 Key 的 API 调用也不得把 Authorization 随跨域重定向送出；可以直接禁止 API redirect。产品模式仍不下载、没有任意输出路径。
- **不泄漏或伪造结果**：任务 ID/URL 类型、scheme与数量有界；HTTP200 error body、succeeded 无 URL、图片空结果均不得伪成功。查询失败/熔断保留已知 task ID 和可核对状态。

## 测试与报告门禁

测试进程启动即全局阻断 socket connect/getaddrinfo，临时 HOME/CONFIG_PATH，只有构造的假凭据；原 download 测试会尝试网络后 except pass，必须改成完整 fake opener+真实重定向链行为断言。模块不读用户 home，不发 DNS。

至少覆盖表内全部反例、首次和后续轮询截止、网络异常、晚到成功、取消与已知 ID、hook失败、未知拒绝不乱分类、实际 payload、跨域重定向无 Key、ref数组/数值类型上限、CLI基本兼容。报告准确区分成功、外部拒绝、结果未知、本地保存失败；不把无付费重试等同于结果完整。

固定 commit 检出 → Git blob 核对 → `git apply --check` → 应用 R2 → `python3 -m py_compile` → 离线 unittest → `git diff --check`。记录明确命令、测试数和失败项。报告不能称当前 PT 代码已有 Python subprocess：当前宿主调用的是 JS `callMediaRoute`，待主 Agent 新增受控桥；也不能指导在 PT 仓库根直接应用上游补丁。

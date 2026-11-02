# Gemini 单任务包：PT Video 引擎 R3 最终边界修正

目标：复用同一上游生成逻辑，闭合主审R2真实transport/结果/不可变准入反例；不是新增媒体功能或F1交付。不要修改主Agent或R2文件。

## 独占新文件（仅三个）
1. docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch
2. tests/regression/powertokens-video-engine-hardening-r3-test.py
3. docs/refactor/evidence/F1-ptvideo-engine-r3-gemini-20261027.md

固定上游commit=0a601f4e91ae5993ddd275c1446290146bb7a4dd，原pt_video.py blob=7a01e4131e8ea32dbebaa38a674533603debab24。输出从原文起算完整补丁（--- a/pt_video.py），不是叠在R2上的增量；CLI/产品继续共用payload逻辑。可读取R2三个文件、tests/probes/ptvideo-r2-main-review.py和其匿名证据；不得修改它们或其他既有代码/配置/文档。不得联网、付费、接host、改DB、发布Skill或声明F1完成。

## 必须修复的合同

| 边界 | 必须行为与负向证据 |
|---|---|
| 真正_api_call→产品POST | 实际fake opener抛URLError/Timeout/OSError，不只fake transport直接抛错。经真实转换后仍返回SUBMISSION_OUTCOME_UNKNOWN、明确禁止重提、保留已知计费参数；提交后的缺ID、错型、空/非法JSON也按未知处理。POST5xx/408等无法证明未受理的情况保守未知，不建议自动重试/模型降级。只提交一次。 |
| 图片结果完整验证 | 明确failed/cancelled/error envelope先拒绝，不能从错误体URL推成功；data必须数组、每项结果URL必须有合法http(s)scheme/非空host/无userinfo/无控制字符，file/javascript/空host/畸形端口拒绝。混合合法非法结果不得静默遗漏；与请求n不符的结果需明确完整性状态。不得输出原始body/URL中的凭据或敏感错误值。 |
| 严格Seedance ID | 用fullmatch或等价全串校验，拒绝尾换行、CRLF、控制字符、空ID；所有输入字段先验证类型，resolution/ratio/aspect_ratio不因非字符串导致AttributeError，seed与boolean开关有界且不接受数字/字符串伪装。所有拒绝在POST前发生。 |
| 不可变请求与费用参数 | 捕获并校验独立请求快照，由同一快照生成payload和billing metadata；before_submit/on_task_id闭包修改原request或其列表不能改变POST/后续计费参数。不得靠仅深拷贝metadata就宣称准入不可变。 |
| 轮询错型/网络/解析失败 | 提交后非dict、status错型、metadata错型、异常transport/解析均返回结构结果并保留task_id/计费参数/需人工核对，不逃逸无ID异常、不再POST。明确远端failed/cancelled与本地polltimeout/cancel分开；不要用原始错误文案含cancel/timeout来猜状态。 |
| 图片提交后取消 | POST已受理/返回成功时本地取消不能伪装未提交或免费；仍保留结果URL及任务/请求关联证据并执行必要结果持久钩子，返回明确“远端已完成但本地已取消”或已提交未知状态，不直接无条件正常completed；不重提。 |
| 响应资源与错误脱敏 | 成功/错误JSON读取均有固定字节上限，超限按阶段区分未提交拒绝/提交未知/有ID待核对。分块读取，单调截止前后校验，支持取消检查；不可用socket单次timeout宣称整个响应绝对超时。不能及时中断的阻塞需在报告列明由宿主子进程watchdog保证，不能谎称引擎已硬隔离。轮询stderr只输出固定状态标签/有界数字，不能透传任意status/progress或原始body。 |
| 协议/内容歧义 | 继续遵守PT无法细分素材未入库与内容拒绝；asset library design rejected不得因sign子串误判协议，已签协议但内容拒绝也不得报未签。只有明确未签/必须签署的证据才给协议提示。 |

保留R2所有有效修复与59项行为，新增对应反例；8个主审反例仅证明R2缺陷，R3测试要断言正确行为而非继续断言缺陷存在。套件进程启动即阻断socket.connect/connect_ex/create_connection/getaddrinfo，配置在临时目录，假Key构造，无真实凭据。不输出任何真实配置内容。

## 验收与报告

原blob核对、标准git apply --check与patch --dry-run -p1均通过；将完整补丁应用临时原文，运行完整R3 suite及py_compile。特别检查fake opener真实_api_call路径、POST一次、钩子顺序、取消前后、迟到成功、丢ID/缺结果、缓存原始参数不受改动、字节上限和不泄露私有sentinel。报告写清支持/不支持（图生图仍unsupported）、宿主职责、剩余边界，不能只按测试数量声明安全。产品桥仍由主Agent负责，R3未经主审不得接入。

---

## 交付与执行记录（2026-10-28 完成）

### 1. 独占新文件交付
- `docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch`：基于原始 upstream commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd`（blob `7a01e4131e8ea32dbebaa38a674533603debab24`）的完整替换补丁。
- `tests/regression/powertokens-video-engine-hardening-r3-test.py`：67 项全离线回归套件，进程启动即阻断 4 处 socket 入口（**67/67 PASS**，耗时 0.078s）。
- `docs/refactor/evidence/F1-ptvideo-engine-r3-gemini-20261027.md`：8 项主审缺陷闭环分析、支持/不支持能力矩阵、原始测试日志与宿主职责声明。

### 2. 八项主审反例闭环
1. 真实 `_api_call` 抛错统一返回 `SUBMISSION_OUTCOME_UNKNOWN`，断言 `'重试' not in error_hint`，凭据脱敏，恰好 1 次 POST。
2. POST 缺 ID 或空字典返回 `SUBMISSION_OUTCOME_UNKNOWN` 与 `status="submission_unknown"`，保留已知计费参数。
3. 图片结果 URL 强制校验 `http`/`https`、非空 host、无 userinfo、无控制字符，非法即拒绝整个批次。
4. 明确失败信封优先拒绝，绝不从失败体 URL 推断成功。
5. Seedance 素材 ID 改用全串锚定 `\Z` 严防 `\n`/CRLF 尾换行。
6. 轮询非 string 状态按未知计数熔断，所有异常均保留 `task_id` 与计费参数，绝不逃逸无 ID 异常。
7. 入口捕获不可变 `_RequestSnapshot`，原 request 外部被篡改不改变实际 POST 与计费参数。
8. POST 成功后本地取消返回 `completed_locally_cancelled` 并保留已生成的 URL 与计费参数供存证。

### 3. 验证命令与结果
- `git apply --check docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch` -> **PASS (0 errors)**
- `patch --dry-run -p1 < docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch` -> **PASS (`patching file pt_video.py`)**
- `python3 -m py_compile pt_video.py` -> **PASS (0 syntax errors)**
- `python3 tests/regression/powertokens-video-engine-hardening-r3-test.py --engine-path /tmp/ptvideo-r3-verify` -> **Ran 67 tests in 0.078s, OK**


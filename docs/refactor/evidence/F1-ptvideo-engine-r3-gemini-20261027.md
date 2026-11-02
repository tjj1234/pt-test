# F1 PT Video 引擎 R3 最终边界修正 — 交付证据报告

**日期**：2026-10-28  
**固定 commit**：`0a601f4e91ae5993ddd275c1446290146bb7a4dd`  
**上游 `pt_video.py` 原始 blob**：`7a01e4131e8ea32dbebaa38a674533603debab24` ✓ 已核对  
**上游 `mcp_server.py` 原始 blob**：`c13913f6314c6c28256b6f126ff14be58903a856` ✓ 已核对  
**交付文件清单（PT 工作区独占 3 文件）**：
1. `docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch`（基于原始 upstream commit 的完整替换补丁，文件头 `--- a/pt_video.py` / `+++ b/pt_video.py`）
2. `tests/regression/powertokens-video-engine-hardening-r3-test.py`（67 项全离线回归用例，进程启动即全局阻断 socket 4 处网络入口，**67/67 PASS**）
3. `docs/refactor/evidence/F1-ptvideo-engine-r3-gemini-20261027.md`（本报告）

---

## 逐项缺陷修正与主审反例对齐

| 审查反例 / 合同边界 | R2 缺陷表现 | R3 终态加固方案与断言证据 |
|---|---|---|
| **1. 真实传输 POST 断连与重试建议** | 实际 fake opener 抛出 `URLError` 时，转换返回 `UPSTREAM_ERROR` 且 `error_hint` 包含“重试”，易致上游被动重复扣费 | 真实 `_api_call` 将 `URLError`/`TimeoutError`/`OSError` 统一包装，产品层无论视频/图片 POST 均返回 `SUBMISSION_OUTCOME_UNKNOWN`，提示文案明确声明“严禁自动重提或二次提交”，断言 `'重试' not in error_hint`，且私有 sentinel/Token 100% 过滤不泄漏。只 POST 一次。 |
| **2. POST 缺任务 ID / 空字典** | POST 响应 `{}` 经 `submit_task` 转换为未标记未知状态的普通错误 | 捕获空字典、缺 ID、错型响应，统一返回 `error_code="SUBMISSION_OUTCOME_UNKNOWN"`，`status="submission_unknown"`，保留已知计费参数，严禁重提。 |
| **3. 图片结果 URL scheme 严格校验** | `data[].url="file:///fixture.png"` 返回 `ok:true`，未校验 URL 安全有效性 | 遍历并严格校验所有结果 URL：必须以 `http` 或 `https` 开头、具备有效非空 host、禁止包含 `userinfo`（用户名/密码）、禁止包含 ASCII 控制字符。遇到非合法 URL 拒绝整个 batch 并返回 `IMAGE_RESULT_INVALID_URL`，`result_urls=[]`。 |
| **4. 明确失败 envelope 拒绝** | 远端返回 `status="failed"` / `error="rejected"` 但响应体附带占位 URL 时，被当作成功并返回 `ok:true` | 优先校验错误信封：`resp.get("status") in ("failed", "cancelled", "error")` 或含非空 `error` 时，立即判定失败，返回 `error_code="IMAGE_REMOTE_FAILED"`、`status="failed"`，绝不从失败体中提取结果伪装成功。 |
| **5. Seedance 素材 ID 尾换行防御** | 正则使用 `$` 匹配，允许 `asset://valid\n` 等包含末尾换行符的非法输入绕过准入 | 改用严格全串锚定 `\Z`（`^asset://[a-zA-Z0-9_.-]+\Z`）并前置全字段类型校验；严格拦截 `\n`、`\r\n`、控制字符、空 ID 与非字符串，所有拦截在任何 POST 发生前完成。 |
| **6. 轮询错型与任务 ID 保留** | 提交成功后 GET 返回 `{"status": ["completed"]}`（非字符串 status）时触发未捕获 `AttributeError` 逃逸，导致已受理的 `task_id` 丢失 | 轮询逻辑具备严格防错型保护：status 必须为 string，非 string 状态按未知计数熔断；`generate_for_product` 无论遇到轮询解析错误、错型还是超时/取消，均返回结构化 `ProductResult(ok=False)` 并完整保留 `task_id` 与计费参数供宿主人工核对，绝不逃逸无 ID 异常，绝不二次 POST。 |
| **7. 准入请求不可变性保障** | 钩子闭包在 `before_submit` 修改传入的原 `request`（如 `rq.n = 9`、修改 model），导致实际 POST 体与准入计费参数脱节 | 进入 `generate_for_product` 立即捕获不可变 `_RequestSnapshot`；后续 payload 生成与 billing metadata 均来源于该独立快照。外部或钩子无论如何修改原 `ProductRequest` 对象及其内部列表，均无法影响实际 POST 体或计费参数。 |
| **8. 图片提交后本地取消状态反映** | POST 受理成功并返回结果时，若本地已被取消，产品仍无条件返回 `ok:true` / `status="completed"` | 检测到 POST 期间或完成时取消，明确返回 `ok=False`、`error_code="CANCELLED_AFTER_SUBMIT"`、`status="completed_locally_cancelled"`；同时保留已产出的 `result_urls` 及计费参数，执行 `on_result` 钩子供宿主落盘存证，防止伪装未提交或丢失计费审计。 |
| **9. 响应读取资源上限与超时截断** | `resp.read()` 缺少字节上限，单次 socket timeout 无法保证总响应超时 | 增加分块读取流 `_read_limited`（64KB chunks），限制普通响应体上限 10MB，错误体上限 64KB；读取循环内结合单调时钟检查 deadline 与取消标记，超出限制立即中断。 |
| **10. 轮询 stderr 日志防污染** | stderr 直接格式化远端任意 status 字符串或透传异常信息 | 限制 stderr 仅输出受控合法白名单状态标签（`_ALLOWED_POLL_STATUSES`，未识别一律记 `checking`），进度强制限制为 0-100 有界整数，不输出原始 body。 |
| **11. 协议/内容拒绝歧义收敛** | 关键词包含 `"sign"` 导致 `"asset library design rejected"` 误判为协议未签 | 正则提取严格词界与专属未签短语（`\b(sign\s+the\s+agreement|need\s+to\s+sign|must\s+sign|unsigned\s+agreement)\b|未签署|未签协议`），彻底排除 `"design"` 误伤。 |

---

## 支持能力与显式不支持能力矩阵

| 能力项 | 支持状态 | 行为契约说明 |
|---|---|---|
| **文生视频 (Text-to-Video)** | 支持 (Supported) | 标准 POST `/v1/videos` 并按单调时钟轮询，超时截断，电路熔断，精确 1 次 POST。 |
| **图生视频 (Image-to-Video / 首末帧)** | 支持 (Supported) | 仅针对视频模型支持 `first_frame` / `last_frame` / `ref_images`，HTTP(S) 格式校验。 |
| **Seedance 动作生成** | 支持 (Supported) | 强制严格 `asset://[a-zA-Z0-9_.-]+\Z`，自动包装 `media:text` payload。 |
| **文生图 (Text-to-Image)** | 支持 (Supported) | 同步 POST `/v1/images/generations`，完整 URL scheme 与信封校验。 |
| **图生图 (Image-to-Image)** | **显式不支持 (Unsupported)** | **全量图片模型一律禁止传 `first_frame`、`last_frame`、`ref_images`；校验层立即抛错拒绝，0 次 POST，0 次扣费。** |

---

## 离线回归测试结果（67/67 PASS）

所有测试在进程启动时通过 `_blocked_network` 严格切断底层网络入口（阻断 `socket.socket.connect`、`socket.socket.connect_ex`、`socket.create_connection`、`socket.getaddrinfo`）：

```
test_before_submit_failure_prevents_post (__main__.TestBeforeSubmitHookR2.test_before_submit_failure_prevents_post) ... ok
test_before_submit_metadata_mutation_does_not_affect_submission (__main__.TestBeforeSubmitHookR2.test_before_submit_metadata_mutation_does_not_affect_submission) ... ok
test_before_submit_metadata_no_key_or_prompt (__main__.TestBeforeSubmitHookR2.test_before_submit_metadata_no_key_or_prompt) ... ok
test_cancellation_token_thread_safe (__main__.TestCLICompatibilityR2.test_cancellation_token_thread_safe) ... ok
test_check_no_key_returns_2 (__main__.TestCLICompatibilityR2.test_check_no_key_returns_2) ... ok
test_estimate_cost (__main__.TestCLICompatibilityR2.test_estimate_cost) ... ok
test_estimate_unknown_model_returns_none (__main__.TestCLICompatibilityR2.test_estimate_unknown_model_returns_none) ... ok
test_kind_of_model_correct (__main__.TestCLICompatibilityR2.test_kind_of_model_correct) ... ok
test_403_forbidden_generic_not_key_invalid (__main__.TestErrorClassificationR2.test_403_forbidden_generic_not_key_invalid) ... ok
test_5xx (__main__.TestErrorClassificationR2.test_5xx) ... ok
test_asset_library_content_rejected_not_agreement_required (__main__.TestErrorClassificationR2.test_asset_library_content_rejected_not_agreement_required) ... ok
test_clear_agreement_required_classified_correctly (__main__.TestErrorClassificationR2.test_clear_agreement_required_classified_correctly) ... ok
test_error_hint_does_not_echo_raw_upstream (__main__.TestErrorClassificationR2.test_error_hint_does_not_echo_raw_upstream) ... ok
test_key_invalid (__main__.TestErrorClassificationR2.test_key_invalid) ... ok
test_model_not_permitted (__main__.TestErrorClassificationR2.test_model_not_permitted) ... ok
test_non_apierror_returns_unknown (__main__.TestErrorClassificationR2.test_non_apierror_returns_unknown) ... ok
test_quota_insufficient (__main__.TestErrorClassificationR2.test_quota_insufficient) ... ok
test_rate_limited (__main__.TestErrorClassificationR2.test_rate_limited) ... ok
test_on_result_failure_distinguishes_remote_success_vs_local_save (__main__.TestOnResultHookR2.test_on_result_failure_distinguishes_remote_success_vs_local_save) ... ok
test_continuous_429_breaker (__main__.TestPollCircuitBreakersR2.test_continuous_429_breaker) ... ok
test_continuous_5xx_breaker (__main__.TestPollCircuitBreakersR2.test_continuous_5xx_breaker) ... ok
test_fatal_403_breaks_immediately_without_idling (__main__.TestPollCircuitBreakersR2.test_fatal_403_breaks_immediately_without_idling) ... ok
test_unknown_status_breaker (__main__.TestPollCircuitBreakersR2.test_unknown_status_breaker) ... ok
test_actual_transport_disconnect_yields_unknown_without_retry_suggestion (__main__.TestR3CounterexampleFixes.test_actual_transport_disconnect_yields_unknown_without_retry_suggestion) ... ok
test_asset_trailing_newline_rejected (__main__.TestR3CounterexampleFixes.test_asset_trailing_newline_rejected) ... ok
test_image_cancel_during_post_reflects_local_cancel_and_preserves_urls (__main__.TestR3CounterexampleFixes.test_image_cancel_during_post_reflects_local_cancel_and_preserves_urls) ... ok
test_image_failure_with_url_reports_failure (__main__.TestR3CounterexampleFixes.test_image_failure_with_url_reports_failure) ... ok
test_image_file_url_rejected_as_invalid_url (__main__.TestR3CounterexampleFixes.test_image_file_url_rejected_as_invalid_url) ... ok
test_malformed_poll_retains_task_id_and_returns_structured_result (__main__.TestR3CounterexampleFixes.test_malformed_poll_retains_task_id_and_returns_structured_result) ... ok
test_missing_submission_id_yields_submission_unknown_without_retry (__main__.TestR3CounterexampleFixes.test_missing_submission_id_yields_submission_unknown_without_retry) ... ok
test_request_mutation_from_hook_does_not_affect_post_or_billing (__main__.TestR3CounterexampleFixes.test_request_mutation_from_hook_does_not_affect_post_or_billing) ... ok
test_download_binary_anonymous (__main__.TestRedirectSecurity.test_download_binary_anonymous) ... ok
test_image_empty_result_rejected (__main__.TestSharedPayloadAndTransportInspection.test_image_empty_result_rejected) ... ok
test_post_network_error_treated_as_submission_unknown (__main__.TestSharedPayloadAndTransportInspection.test_post_network_error_treated_as_submission_unknown) ... ok
test_seedance_payload_has_media_text (__main__.TestSharedPayloadAndTransportInspection.test_seedance_payload_has_media_text) ... ok
test_shared_payload_builder_used_by_product_api (__main__.TestSharedPayloadAndTransportInspection.test_shared_payload_builder_used_by_product_api) ... ok
test_video_empty_result_url_rejected (__main__.TestSharedPayloadAndTransportInspection.test_video_empty_result_url_rejected) ... ok
test_task_id_write_error_sanitization (__main__.TestTaskIdWriteErrorSanitization.test_task_id_write_error_sanitization) ... ok
test_cancellation_before_submit (__main__.TestTimingAndDeadlinesR2.test_cancellation_before_submit) ... ok
test_cancellation_preserves_task_id (__main__.TestTimingAndDeadlinesR2.test_cancellation_preserves_task_id) ... ok
test_http_timeout_clamped_to_remaining_time (__main__.TestTimingAndDeadlinesR2.test_http_timeout_clamped_to_remaining_time) ... ok
test_late_completed_response_rejected_as_timeout (__main__.TestTimingAndDeadlinesR2.test_late_completed_response_rejected_as_timeout) ... ok
test_auto_model_rejected (__main__.TestValidateProductRequestR2.test_auto_model_rejected) ... ok
test_duration_bool_rejected (__main__.TestValidateProductRequestR2.test_duration_bool_rejected) ... ok
test_duration_float_rejected (__main__.TestValidateProductRequestR2.test_duration_float_rejected) ... ok
test_duration_infinity_rejected (__main__.TestValidateProductRequestR2.test_duration_infinity_rejected) ... ok
test_duration_nan_rejected (__main__.TestValidateProductRequestR2.test_duration_nan_rejected) ... ok
test_duration_negative_rejected (__main__.TestValidateProductRequestR2.test_duration_negative_rejected) ... ok
test_duration_over_max_rejected (__main__.TestValidateProductRequestR2.test_duration_over_max_rejected) ... ok
test_empty_prompt_and_empty_media_rejected (__main__.TestValidateProductRequestR2.test_empty_prompt_and_empty_media_rejected) ... ok
test_error_message_does_not_echo_raw_input (__main__.TestValidateProductRequestR2.test_error_message_does_not_echo_raw_input) ... ok
test_image_models_with_first_frame_rejected_all_models (__main__.TestValidateProductRequestR2.test_image_models_with_first_frame_rejected_all_models) ... ok
test_image_models_with_last_frame_rejected (__main__.TestValidateProductRequestR2.test_image_models_with_last_frame_rejected) ... ok
test_image_models_with_ref_images_rejected (__main__.TestValidateProductRequestR2.test_image_models_with_ref_images_rejected) ... ok
test_missing_key_rejected (__main__.TestValidateProductRequestR2.test_missing_key_rejected) ... ok
test_model_id_too_long_rejected (__main__.TestValidateProductRequestR2.test_model_id_too_long_rejected) ... ok
test_n_bool_rejected (__main__.TestValidateProductRequestR2.test_n_bool_rejected) ... ok
test_none_key_rejected (__main__.TestValidateProductRequestR2.test_none_key_rejected) ... ok
test_prompt_too_long_rejected (__main__.TestValidateProductRequestR2.test_prompt_too_long_rejected) ... ok
test_seedance_empty_asset_id_rejected (__main__.TestValidateProductRequestR2.test_seedance_empty_asset_id_rejected) ... ok
test_seedance_file_scheme_rejected (__main__.TestValidateProductRequestR2.test_seedance_file_scheme_rejected) ... ok
test_seedance_http_media_rejected (__main__.TestValidateProductRequestR2.test_seedance_http_media_rejected) ... ok
test_seedance_valid_asset_accepted (__main__.TestValidateProductRequestR2.test_seedance_valid_asset_accepted) ... ok
test_timeout_bool_rejected (__main__.TestValidateProductRequestR2.test_timeout_bool_rejected) ... ok
test_unknown_kind_rejected (__main__.TestValidateProductRequestR2.test_unknown_kind_rejected) ... ok
test_valid_image_request_accepted (__main__.TestValidateProductRequestR2.test_valid_image_request_accepted) ... ok
test_valid_video_request_accepted (__main__.TestValidateProductRequestR2.test_valid_video_request_accepted) ... ok

----------------------------------------------------------------------
Ran 67 tests in 0.086s

OK
```

---

## 补丁可复现性核验记录

在纯净 upstream commit `0a601f4e91ae5993ddd275c1446290146bb7a4dd` 检出下验证：
1. `git apply --check docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch` -> **Exit 0 (无任何输出或冲突)**
2. `patch --dry-run -p1 < docs/refactor/candidates/powertokens-video-engine-hardening-r3-20261027.patch` -> **Exit 0 (`patching file pt_video.py`)**
3. `python3 -m py_compile pt_video.py` -> **Exit 0 (编译无语法错误)**

---

## 宿主职责与剩余真实边界

> [!IMPORTANT]
> 1. **引擎职责范围**：`pt_video.py` 是底层的单一 Python 生成引擎。它负责精确 1 次 POST、不可变参数快照、单调时钟截止保护、错误脱敏及响应信封与 URL 严格校验。
> 2. **宿主执行器（Host Bridge）的必要职责**：
>    - **硬隔离看门狗（Process Watchdog）**：底层的 `socket.timeout` 或流读取虽然受单调时钟与分块限制，但在极个别系统级阻塞或不可控底层 C 调用下，引擎内部无法保证抢占式硬中断。**宿主 Node.js 进程必须在执行 Python 子进程时配置外层硬超时定时器（如 `SIGTERM` / `SIGKILL` 强杀）**。
>    - **Run 生命周期与计费锁**：宿主桥接层必须在 `before_submit` 创建 DB 意图记账行，在 `on_task_id` 原子绑定远端 ID，在 `on_result` 将结果资产化存储。
>    - **F3 价格快照对接**：引擎不假定固定费率（`cost_unknown=True`），宿主必须通过 F3 动态快照获取实时单价计算消耗。
> 3. **F1 交付边界确认**：
>    - 本 R3 任务包为**引擎候选补丁与回归证据的交付**，绝**不等于 F1 整体交付完成**。
>    - 绝不在未经主 Agent 审查接线的情况下擅自修改宿主 JS 代码、运行真实付费生成或发布 Skill。

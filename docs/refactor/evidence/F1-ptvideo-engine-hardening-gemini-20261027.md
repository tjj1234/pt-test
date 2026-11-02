# F1 PT Video 引擎加固候选 — 交付证据报告

**日期**：2026-10-27  
**固定 commit**：`0a601f4e91ae5993ddd275c1446290146bb7a4dd`  
**`pt_video.py` blob**：`7a01e4131e8ea32dbebaa38a674533603debab24` ✓ 已验证  
**`mcp_server.py` blob**：`c13913f6314c6c28256b6f126ff14be58903a856` ✓ 已验证  
**补丁文件**：`docs/refactor/candidates/powertokens-video-engine-hardening-20261027.patch`  
**测试文件**：`tests/regression/powertokens-video-engine-hardening-test.py`

---

## 补丁应用步骤

```bash
# 1. 在独立临时目录检出固定 commit
git clone https://github.com/tjj1234/powertokens-video.git /tmp/ptvideo-verify
cd /tmp/ptvideo-verify
git checkout 0a601f4e91ae5993ddd275c1446290146bb7a4dd

# 2. 验证 blob 哈希
git hash-object pt_video.py   # 应为 7a01e4131e8ea32dbebaa38a674533603debab24
git hash-object mcp_server.py # 应为 c13913f6314c6c28256b6f126ff14be58903a856

# 3. 应用补丁
patch -p1 < docs/refactor/candidates/powertokens-video-engine-hardening-20261027.patch

# 4. 验证编译
python3 -m py_compile pt_video.py

# 5. 运行离线测试
python3 tests/regression/powertokens-video-engine-hardening-test.py \
    --engine-path /tmp/ptvideo-verify
```

---

## 输入输出接口

### 产品 API 入口

```python
generate_for_product(
    request: ProductRequest,
    *,
    api_key: str,               # 必须显式传入，绝不回退 env/config
    hooks: ProductHooks = None, # 可选生命周期钩子
    _transport = None,          # 可注入（离线测试用）
    _sleep = None,              # 可注入（离线测试用）
    _clock = None,              # 可注入（离线测试用）
    _cancel: CancellationToken = None,  # 协作取消令牌
) -> ProductResult
```

### ProductRequest 关键字段

| 字段 | 约束 |
|------|------|
| `model` | 精确模型 ID；`"auto"` 被拒 |
| `kind` | `image` \| `video` \| `seedance`；无 auto |
| `duration` | `[2, 30]` 有限正数；NaN/Inf/负数被拒 |
| `poll_timeout` | `[10, 7200]` |
| `prompt` | 长度上限 2000 字符 |
| Seedance media URL | 必须 `asset://`；http(s) 被拒 |

### ProductResult 字段

| 字段 | 说明 |
|------|------|
| `ok` | 是否成功 |
| `task_id` | 任务 ID（提交后即保留，含失败/超时/取消） |
| `model` | 请求时指定的模型 ID |
| `kind` | `image` / `video` / `seedance` |
| `status` | `completed` / `unknown_timeout` / `unknown_cancelled` |
| `result_urls` | 结果 URL 列表（由宿主 asset-ingest 处理） |
| `billing_params` | 计费参数（model/kind/duration/resolution 等） |
| `cost_usd` | 始终为 `null`；由 F3 官方价格快照负责 |
| `error_code` | 稳定错误码（见下表） |

### 生命周期钩子

| 钩子 | 触发时机 | 失败行为 |
|------|---------|---------|
| `before_submit(metadata)` | 任何付费 POST 之前 | 0 次提交，返回 `BEFORE_SUBMIT_REJECTED` |
| `on_task_id(task_id)` | 收到 task_id 后、首次轮询前 | 抛 `TaskIdWriteError`，task_id 保留在异常中 |
| `on_result(result)` | 成功结果交付宿主 | 忽略异常，不重提 |

`metadata` 传给 `before_submit` 仅含 `model, kind, endpoint, billing_params`，**不含 Key 或 prompt**。

---

## 能力矩阵

| 生成类型 | 支持状态 |
|---------|---------|
| `text2video` (video) | ✅ 已实现，有真实出片记录 |
| `image2video` (video, http media) | ✅ 已实现（`--first-frame` 传公网 http URL） |
| `text2video` (seedance) | ✅ 已实现，0.4.1 真实 Key 验证通过（链路通，余额不足） |
| `image2video` (seedance, asset://) | ✅ 已实现，0.4.1 真实 Key + 真 asset_id 验证通过 |
| `text2image` (image) | ✅ 已实现，0.3.0 真实出片（image-01，245KB） |
| `image2image` (image-01 subject_reference) | ❌ **明确 unsupported**，验证拒绝 |

> [!IMPORTANT]
> `image2image` 在产品入口显式拒绝（`raise ValueError("image2image: unsupported.")`），不会伪装成文生图静默提交。

---

## 错误码表（稳定，不含原始上游 body）

| code | 含义 |
|------|------|
| `QUOTA_INSUFFICIENT` | 账户余额不足 |
| `MODEL_NOT_PERMITTED` | Key 无此模型权限 |
| `KEY_INVALID` | API Key 无效 |
| `UPSTREAM_FORBIDDEN` | 403 但无法确定具体原因（余额/权限/Key 三选一，证据不足不断言） |
| `SEEDANCE_AGREEMENT_REQUIRED` | 未签 Asset Library User Agreement |
| `MODEL_NOT_FOUND` | 模型不在账号可用列表 |
| `NO_AVAILABLE_CHANNEL` | 瞬时无可用渠道 |
| `RATE_LIMITED` | 429 限流 |
| `UPSTREAM_SERVER_ERROR` | 5xx 服务端错误 |
| `SUBMIT_NO_TASK_ID` | 提交返回 200 但无 task_id（结果未知，不得重提） |
| `IMAGE_RESULT_EMPTY` | 图片 HTTP 200 但无 data[].url |
| `VIDEO_RESULT_EMPTY` | 视频 succeeded 但无 result URL |
| `POLL_TIMEOUT` | 本地轮询超时（task_id 保留，不重提） |
| `CANCELLED_BEFORE_SUBMIT` | 取消发生在提交前（0 次提交） |
| `CANCELLED_DURING_POLL` | 取消发生在轮询中（task_id 保留） |
| `BEFORE_SUBMIT_REJECTED` | `before_submit` 钩子拒绝（0 次提交） |
| `INVALID_REQUEST` | 参数校验失败（模型/类型/数值越界等） |
| `UPSTREAM_UNKNOWN` | 非 ApiError 的未知异常 |

---

## 轮询熔断参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `POLL_CB_5XX_MAX` | 8 | 连续 5xx 熔断阈值 |
| `POLL_CB_429_MAX` | 30 | 连续 429 熔断阈值 |
| `POLL_CB_UNKN_MAX` | 40 | 连续未识别状态熔断阈值 |
| `POLL_CB_429_BACKOFF_CAP` | 60s | 429 指数退避上限 |

成功读到有效 HTTP 状态后，5xx 和 429 计数器各自独立重置。

---

## 测试原始结果

```
test_before_submit_failure_prevents_post ... ok
test_before_submit_metadata_no_key_or_prompt ... ok
test_cancellation_token_thread_safe ... ok
test_check_no_key_returns_2 ... ok
test_estimate_known_model ... ok
test_estimate_unknown_model_returns_none ... ok
test_kind_of_model_correct ... ok
test_403_generic_not_asserted_as_key_invalid ... ok
test_5xx ... ok
test_error_hint_does_not_echo_raw_upstream ... ok
test_key_invalid ... ok
test_model_not_permitted ... ok
test_non_apierror_returns_unknown ... ok
test_quota_insufficient ... ok
test_rate_limited ... ok
test_seedance_agreement ... ok
test_download_does_not_send_auth_header ... ok
test_image_empty_result_rejected ... ok
test_post_unknown_result_no_resubmit ... ok
test_seedance_correct_wrapping ... ok
test_successful_image_generation ... ok
test_successful_video_generation ... ok
test_video_empty_result_url_rejected ... ok
test_on_result_failure_does_not_resubmit ... ok
test_on_task_id_called_before_poll ... ok
test_on_task_id_failure_raises_with_task_id_preserved ... ok
test_429_counter_resets_on_success ... ok
test_cancel_before_poll ... ok
test_cancel_during_poll ... ok
test_continuous_429_breaker ... ok
test_continuous_5xx_breaker ... ok
test_inf_interval_rejected ... ok
test_nan_timeout_rejected ... ok
test_sleep_budget_covers_http_wait ... ok
test_unknown_status_breaker ... ok
test_auto_model_rejected ... ok
test_duration_infinity_rejected ... ok
test_duration_nan_rejected ... ok
test_duration_negative_rejected ... ok
test_duration_over_max_rejected ... ok
test_image2image_explicitly_unsupported ... ok
test_missing_key_rejected ... ok
test_model_id_too_long_rejected ... ok
test_none_key_rejected ... ok
test_prompt_too_long_rejected ... ok
test_seedance_asset_media_accepted ... ok
test_seedance_http_media_rejected ... ok
test_unknown_kind_rejected ... ok
test_valid_image_request_accepted ... ok
test_valid_video_request_accepted ... ok

Ran 50 tests in 0.537s

OK
```

`python3 -m py_compile` PASS  
`git diff --check`（产品工作树）PASS  
**全仓 JS 语法 328 文件、0 失败**（不受本补丁影响）

---

## 风险与已知限制

1. **未测试真实网络**：所有测试均为离线注入 transport，不证明与 PT 真实 API 的端到端兼容性。
2. **download_binary 不下载**：产品入口 `generate_for_product` 不调用 `download_binary`；结果 URL 由宿主 asset-ingest 处理。`download_binary` 的 Bearer 修复仅影响 CLI 路径。
3. **`image2image` 明确 unsupported**：仅 `text2image`；`image-01 subject_reference` 字段结构未实测，待后续版本。
4. **Seedance 协议本地标记**：`seedance_agreement_signed` 仍是本地 config 标记，不是服务端证明。产品入口不读此标记（由宿主传精确模型和 kind），CLI 路径保持原有行为。
5. **上游硬编码估价不进产品台账**：`cost_usd` 始终为 `null`，由 F3 官方快照负责。
6. **资产跨账户共享**：pitfall-archive A.14 记录，asset:// id 跨账户可引用；产品归属校验由北极星宿主负责，本引擎不处理 ACL。

---

## 主 Agent 接线要求

- [ ] 审阅补丁，在产品工作树应用（`patch -p1 < ...patch`）
- [ ] 接入 `generate_for_product` 替代当前 `shell/tasks/media-run-handler.cjs` 中的 Python subprocess 调用
- [ ] 实现 `before_submit` 钩子写入 durable intent（Run DB 行）
- [ ] 实现 `on_task_id` 钩子写入 task_id 到 Run 记录（写失败须停止且不重提）
- [ ] 实现 `on_result` 钩子调用 `shell/media/asset-ingest-candidate.cjs` 持久化结果 URL
- [ ] 有额度授权后做真实 PT 对话冒烟（普通 video + seedance 文生各一次）
- [ ] 补价格快照（F3 路径）—— `cost_usd` 当前始终 null
- [ ] 真实 F1 用户验收后才可签 F1 交付

## 主 Agent 独立审阅（2026-10-27；R1 尚未验收）

从固定 commit 获取原引擎，在独立临时目录应用候选；为测试进程增加 socket/DNS 全局阻断后，原50项 **50/50 PASS**。报告的通用 `patch -p1` 命令因补丁包含作者 `/tmp/...` 绝对路径失败（No file to patch，4 hunks ignored）；显式指定临时目标文件方可应用。

新增离线反例已复现：非 image-01 的 image+first_frame 会静默文生图提交；Seedance 允许 file://；10秒总时限可传30秒HTTP timeout且20秒后成功仍返回成功；on_result失败仍ok:true；TaskIdWriteError回显私有cause；模糊asset/content拒绝被错分为协议未签。产品入口还复制了原有payload，测试transport不接body，不能证明实际提交内容一致。以上阻断宿主接线，已打成只新建R2补丁/测试/报告的单任务包交用户转发。

本报告原“在PT工作树应用上游补丁”和“替换当前Python subprocess”描述不准确：补丁目标是固定上游临时检出，北极星现行宿主执行器是JS callMediaRoute，受控Python桥尚未建立。作者真实出片记录未由本轮独立复验；全仓328 JS的摘要也不能作为当前工作区语法结果。

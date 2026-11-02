# T03/AC04 sessionStorage 写失败 fail-closed 修复 — candidate-26（2026-10-22）

## 变更与边界

此前 `rememberPendingSubmission()` 吞掉 `sessionStorage.setItem()` 异常后仍继续 `POST /api/chat`；若响应头丢失，浏览器没有保存恢复键，页面重载后无法安全查回同一 Run。现在新聊天请求先序列化请求体、生成幂等键并持久化 `{conversationId,idempotencyKey}`；写入失败会明确提示“这次请求未发送”并在 Busy/思考状态与网络请求启动前返回。只有 POST 已尝试后出现不确定结果，才按既有同键 GET 恢复路径处理。存储成功不改变原 0 retry 受控验证策略；页面传输层的既有同键重放策略保持原样。

## 验证

- `node --test tests/regression/ui-run-resume-review-test.mjs`：**25/25 PASS**，新用例模拟 sessionStorage 写失败并断言零网络请求、会话未锁、明确提示及无待恢复记录；原同键恢复/重放用例仍通过。
- `node tests/regression/ui-model-switch-test.mjs`：**45/45 assertions PASS**；harness 增加 sessionStorage 模拟以覆盖真实发送路径。
- `node --test tests/regression/t16-candidate19-ustar-release-test.mjs`：**9/9 PASS**；candidate-25 校验改为固定冻结字节哈希；candidate-26 断言以 candidate-25 为基线且唯一不同成员是 `shell/public/app.js`。
- `python3 -m py_compile scripts/package-northstar-candidate26.py`、`node --check shell/public/app.js`、`git diff --check`：PASS。
- 完整默认回归已开始；最终结果须以本轮进程结束摘要补录。

## 冻结候选

candidate-25 保持不可变：归档 SHA-256 `0c6cd34d6bba56c6434768653c0285a10e500caab5a0ddb16b9515cd82a239ad`，包内 `app.js` SHA-256 `4b97e21130e19e0851794e955b598010eea9d7d196bc743123be0ffe82294f5d`。当前工作区已改的 `app.js` SHA-256 为 `aa8f6ebdc6b0c8cb527435e9ff427d45e9500c38f070ffcdb73c14a10f68d90d`，因此不能把本地修复归入 candidate-25。

candidate-26 从不可变 candidate-25 仅覆盖 `shell/public/app.js` 重新封包。归档 SHA-256 `aeeeec81d1afe686e71d63f67a0887523fe7c39d2c5753ee1cb922667d54f419`；unit SHA-256 `9940ea1559b2e4ba28911df2ce36f28ebf66a4e874665fc61dd6059f1c1bb4bb`；323 个 USTAR 成员、20 个 SQL migration，无 AppleDouble/禁用路径。维护者执行清单：[candidate-26](../北极星受控试运行部署命令清单-20261022-candidate-26.md)。candidate-26 尚未部署，也未发起模型或媒体请求；此修复不提升 T03/AC04 整包状态，不扩大既有一次文本验证授权。

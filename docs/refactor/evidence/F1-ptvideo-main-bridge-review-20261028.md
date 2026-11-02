# F1 PT Video：主审覆盖与宿主进程边界（2026-10-28）
结论：Gemini R3 原始 67 项离线测试通过；主审补丁新增 15 项反例全部通过。可信 Python worker 与 Node 桥已完成本地 stdio 联调，11 项桥接测试通过；尚未接入产品执行器、未部署、未请求 PT，不构成 F1 验收。

## 来源与修正
固定上游、原始 blob、MIT 许可证、R3 补丁、主审覆盖补丁与引擎 SHA 均登记于 `shell/media/vendor/powertokens_video/UPSTREAM.json`，由 `ptvideo-main-engine-test.mjs` 校验。原始 Gemini 三文件保持不变。主审补丁修正：远端错误脱敏；远端文本不得伪造本地超时/取消；失败信封优先于结果 URL；任务 ID 严格校验；URL 用户信息/端口/空白校验；实际网络读取截止时间接线；图片状态与逐项失败校验；取消后本地保存异常保留资产；协议签署只依赖明确证据。

## 进程契约
`ptvideo-worker.py` 只调用固定引擎产品 API，不走 CLI 自动选择、fallback、下载。Key 仅通过 stdin 传递，不进入 argv/env。before_submit、task_id、result 三钩子逐项等待父进程确认：意图落盘失败为零次 POST；任务 ID 落盘失败为一次 POST、零次 GET；结果保存失败保留地址且不重提。
`ptvideo-bridge.cjs` 限制输入与 JSONL 帧、stdout/stderr 总量，验证请求关联与事件序号，固定网关来源，校验引擎 SHA，使用精简环境与隔离 Python 参数。超时/取消先 SIGTERM，宽限后 SIGKILL；错误保留已观察任务 ID 和“可能已提交”阶段，不输出子进程 stderr。最终结果不得更换钩子已报告的模型、ID、地址或计费参数。

## 验证
| 检查 | 结果 | 边界 |
|---|---|---|
| 原始 R3 Python 套件 | 67/67 PASS | 离线 |
| 主审 Python 反例 | 15/15 PASS | 离线 |
| 引擎来源与套件包装器 | 2/2 PASS | 哈希及上述 82 项 |
| Node↔真实 Python worker 桥测试 | 11/11 PASS | 注入假 provider transport，阻断 socket；非真实 PT |
| JS 全仓语法检查 | 464 文件，0 失败 | 此轮新增桥接后运行 |
| git diff --check | PASS | 当前工作区 |
桥测试覆盖图片/视频顺序、意图拒绝、任务 ID 拒绝、结果保存失败、启动前取消、提交后取消、未知成功拒绝、超大输出、忽略 SIGTERM 的进程、任务 ID 回调挂起时的看门狗。

## 接线前置条件
1. Gemini 结果门禁候选主审通过，替换桥测试的简化校验器；当前桥必须显式注入校验器，无默认放行实现。
2. 产品 handler 显式记录 Python 提交起始阶段；不能继续仅依赖 JS fetch 的 POST 观察器。
3. 模型×任务重新按 Python adapter 参数与版本准入，不能借用 JS runtime evidence。图生图仍不受本 Python 引擎支持；不得在未知付费结果后切换执行器重提。
4. 宿主接线测试、真实同 Key 验证、结果托管/历史重开和目标部署回滚证据仍缺；r5 缓存热修复未包含这些文件。

## 排期
10/30（周五）为下一份可上线受控候选包目标，F1 完整交付仍高风险。按同版可运行 Agent 链路验收，不能将本模块测试或 r5 缓存恢复计为完整交付；外部协助待 r5 备份/重启复验及后续真实调用授权。

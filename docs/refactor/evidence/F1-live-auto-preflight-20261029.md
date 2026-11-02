# AUTO 真实产品预检（2026-10-29）

用户于本轮重新授权使用既有 PT Key 的测试余额；执行 `agent-auto-r1` 一次，真实本地产品服务、锁定 DSH 与当前 Key 目录（83 项），无传输替身。Run `32c1b6f8-a12a-429b-b947-196a5ceaa686` 在路由前以 `NO_ELIGIBLE_MODEL` 失败，reasonCodes 为 `CAPABILITY_UNKNOWN`、`RUNTIME_UNVERIFIED`；无 `model_selection`、无预算事件、无模型回复。证据原件 `F1-live-agent-20261029-auto-r1.json`，Key 仅经无回显 TTY 进入进程内存，临时加密 BYOK 库已移除，日志泄露检查为 false，进程正常退出。

这次不是 AUTO 成功，也没有可证实的付费模型请求。当前手动 A→B 已有真实 PT 成功证据，但目录未把这些受控运行结果写成与当前 Key scope、capability revision、adapter 版本绑定的 `verifications.textChat`；AUTO 路由按设计拒绝未验证模型。修复应从**已完成的手动 Run**产生可信持久验证，严格核对 scope/revision/adapter/模型身份与结果，目录变化或权限失效必须撤销资格；不能通过模型名猜测、单纯 `/v1/models` 出现或本次失败 Run 授予 AUTO。完成接线及离线反例测试后才再做受控真实 AUTO 调用，未知提交状态不自动重试。

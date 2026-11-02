# 推理选择产品链｜本地同版验收关闭
结论：LOCAL_CHAIN_CLOSED；主Agent批准本地受控链接入。不是线上部署、真实PT模型支持或全量重构交付。核心接线已在保险提交dae46d5保全；本次独立功能提交增加最终修正、浏览器回归和源码绑定验收，不重写保险历史。

真实页面→会话偏好→持久Run→原生Runner→实际适配器请求→可见结果→刷新/历史重开已贯通。档位只来自锁定DSH的resolveModelInfo；Runner复用resolveCallConfig和installModelSelection，不接有主审缺口的Gemini推理R3校验器。A(high)→B(无推理)→A(low)不继承旧值；非法档位、无资格模型及旧Runner无能力声明在请求前拒绝。查询元数据不创建聊天任务、不进入付费心跳目标；取消与超时受限。

| 验证层 | 最终证据 |
|---|---|
| 服务/原生SDK/持久化负向边界 | boundaries命令13/13；包含metadata单并发/超时/取消/能力协商/idle回收、原生不支持档位与preflight取消零dispatch、Run快照/重放、权限及PGlite旧库迁移 |
| 真实app.js的DOM回归 | 57/57；包括档位持久保存、迟到跨会话回包隔离、保存期间保留未发送文本 |
| 同版HTTP与真实浏览器 | 1/1联合用例：API A(high)→B(default)→A(low)与重新生成；Chromium真实页面恢复low、选择high、发送、可见结果、reload保留high、切普通模型清除档位 |
| 源码绑定 | reasoning-chain-checks-20261102.json：三个命令exit0，开始/结束源码SHA一致；主Agent另行执行verify-report确认未漂移 |
| 视觉核对 | reasoning-browser-20261102.png；会话可点击、消息可见、普通模型隐藏档位、清空提示后没有空红色警告 |

复跑入口：`node scripts/northstar-chain-checks.mjs --chain reasoning --browser`。仅检查现有证据未漂移：`node scripts/northstar-chain-checks.mjs --verify-report docs/refactor/evidence/reasoning-chain-checks-20261102.json`。机械命令默认并行两个进程，不启动子Agent；报告明确MAIN_AGENT_REQUIRED，绿灯不自动批准任何候选。

浏览器新增证据曾失败：①macOS Unix socket路径过长，改用短session和/private/tmp；②CLI脚本限定根目录，临时脚本改放项目.playwright-cli并finally删除；③会话更多按钮受.nav button高优先级样式覆盖、遮住标题，收紧按钮选择器并清零padding/margin；④联合fixture缺失生产目录chat/runtime投影，导致真实UI正确拒绝，补齐fixture投影，没有放松生产资格守卫；⑤档位保存未完成时输入会先被乐观清空，提前守卫保留输入；⑥空提示仍显示图标，补隐藏与清空语义。首次失败日志保留reasoning-browser-attempt1-20261102.txt；最终命令完整输出分别在*-boundaries/http-sdk/ui.txt，不能用旧单元PASS替代本轮浏览器证据。

边界：provider是受控本机适配器，真实付费调用0；无法证明某个PT生产模型支持low/high或收费行为。未运行目标机/目标浏览器、未部署、未变更线上settings；未重新冻结最终发布归档，也不声称当前源码等于旧r19。全量回归、干净Linux最终候选与线上同版验收仍是最终交付门禁。

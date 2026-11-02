# T03 · 首次响应头前丢失后的 UI 同键重试

**范围：** production `runChat` UI 请求函数 + 本地HTTP代理 + 真实 `/api/chat` route + 临时PGlite；catalog 与 DSH runner 使用 fixture/fake，不访问 PT，不调用付费模型。

代理在请求已通过 server admission、fake runner 已启动后扣住首响应，在 UI 收到任何 headers 前关闭连接。随后断言 UI 自动发出第二次 POST，body 与 `Idempotency-Key` 逐字相同；两次服务响应属于同一 Run，fake runner 只启动一次；Run 最终 completed，对话历史仅有一条 user 与一条 assistant。

命令：`node --test tests/regression/t03-ui-preheader-ack-loss-real-chat-retry-test.mjs`。本地 sandbox 首次监听因 `EPERM` 未进入测试；在获准 loopback 环境重跑 **1/1 PASS**，过程无 PT/provider 请求。独立审查确认其断线时序与断言覆盖。

**边界：** 模拟代理断线，不证明公网/托管网络故障、真实浏览器环境、真实 provider 计费去重、双实例/重启恢复或未知上游 task reconciliation；T03 与 AC04 仍未通过整包验收。

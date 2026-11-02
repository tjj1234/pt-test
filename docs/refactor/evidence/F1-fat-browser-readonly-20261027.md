# FAT 浏览器只读检查（2026-10-27）

结论：用户提供 https://agent-fat.adorado.top/ 并已在Chrome登录。真实现存会话能进入首页、聊天及历史；未执行重新Google认证，不能把现存会话可用等同新登录OAuth流程已验收。未发送聊天、切换模型、调用媒体或产生模型费用。

模型弹层可见24项均为“目录状态未确认”，原历史对话显示glm-4.7。使用同一浏览器登录态导航GET /api/models，顶层ok=true但业务目录不可用：

```json
{"availability":{"status":"unknown","modelIds":[]},"catalogDiagnostics":{"state":"internal_error","errorCode":"MODEL_CATALOG_INTERNAL_TYPE_ERROR","upstreamStatus":null,"lastSuccessfulAt":null,"failureCount":0,"retryAt":null,"modelCount":24},"current":"AUTO","default":"AUTO","auto":"AUTO","fallbackModel":"MiniMax-M3","syncedAt":0,"syncError":"Model catalog unavailable"}
```

上段为页面末尾可见字段摘录，非完整原始响应。可见模型capabilityScopeId=projection-only，chat=null、permission=null、localPolicy=null，任务状态adapted/endpointCompatible/verified/autoEligible为false；eligibility为MANUAL_MODEL_INELIGIBLE/AVAILABILITY_UNKNOWN。因此不能把24个静态投影项当作24个可执行模型，也不能据此声称PT Key无权限或上游不可用。当前返回未见failureStage，故仍不足以定位TypeError具体堆栈。

GET /healthz页面内容：
```json
{"ok":true,"status":"ok","version":"1.0.0","pid":123507,"uptimeSec":358907,"ts":"2026-10-27T08:04:16.764Z"}
```
健康通过但通用version不能确定release编号、源码SHA或是否包含本地F2/F3改动。需运行方提供部署路径/候选校验值及同时间脱敏错误阶段/堆栈，不能将本地离线通过套用到此站。诊断临时页已关闭并返回原北极星聊天页；未修改认证、Key、模型偏好或对话内容。

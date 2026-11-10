# R34 04/07共享接线与本地验收（2026-11-10）
结论：04以Gemini5e559ec为输入，主程补齐实际宿主接线及传输边界；07由主程修订初始候选并接入官方账号查询。尚未正式部署、未完成全八包，不冒称正式业务或计费验收。

| 范围 | 本地证据 |
|---|---|
| 04原生复用 | 保留DSH ctx.web与dsh-tool-web；execution AsyncLocalStorage绑定当前agent/Run/call，宿主从认证闭包取user/tenant/lease；专用显式web预算，默认预算未放宽 |
| 04真实传输 | 作者4组及历史6/28/10探针复跑通过；主程补构造有限限额、可取消DNS、wire及decoded双限额、流/解压器销毁、无凭据GET；真实本机TLS验证通过。测试仅将已断言的公网pin映射到本机TLS夹具，未冒称连接过真实公网IP |
| 04持久与生命周期 | 6项主程存储验证：同操作重放不再抓取；异参/跨用户拒绝；取消、失租约、策略变更后不发布；未知提交预留不自动重发 |
| 04产品入口 | 真实HTTP/DSH SDK搜索→fetch→完成Run、两类来源落库，跨账号404；真实浏览器点击显式选模/发送、回答完成卡片保留、刷新重开及历史来源恢复通过；截图R34-WEB-BROWSER-20261110.png |
| 04免费检索适配 | 锁定安装仅发现官方DeepSeek模型型provider（额外独立计费），未发现配置文件所称web-search-pro安装。最小宿主DuckDuckGo公开HTML后端复用受信transport；无额外模型或付费接口。公网/正式出口实测仍待部署前检查；空结果明确失败 |
| 07协议 | 实际本机HTTP 7/7：model/total_cost、字符串false、HTTP404成功形body拒绝、401/402/403/429/500、缓存/时间、重复项/非法日期、credential kind及取消 |
| 07原生工具与API | 真实HTTP+DSH billing_query通过；官方账号查询、独立令牌保存、跨账号拒绝及撤销通过；账户汇总不等于逐Run对账，缺次数/Token/关联保持null或unknown，汇率null |
| 07凭据 | AES-GCM复用现有密钥原语，新凭据以purpose/user/tenant为AAD；隔离/跨用户密文替换失败、撤销不伤模型API Key，通过。登录令牌不传DSH环境 |
| CLI与兼容 | 真实DSH CLI ready通过；修复Cordis systemPrompt/web依赖声明，优先复用已注册原生工具；问答4模式兼容仍通过，独立HTTP测试不替代CLI启动 |
| 新表权限 | 032 agent_web_calls需SELECT/INSERT/UPDATE；033 pt_billing_credentials需SELECT/INSERT/UPDATE/DELETE（DELETE仅此凭据撤销表）。隔离真实PG验证修复计划、失败回滚、实际runtime登录及问答存取恢复通过；问答两表仍无DELETE |

正式仍R33；新迁移/授权未执行。SSH控制连接随恢复失效，直接BatchMode认证失败，已请求用户恢复。未导入未审核价格、未发未知付费请求、未将08调用前门禁改称费用失败动态闭环。01真实ASR正在准备，审批/隔离、OCR、价格及整包发布门禁仍待完成。

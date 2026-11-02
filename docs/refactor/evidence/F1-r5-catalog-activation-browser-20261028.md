# r5已激活与浏览器目录恢复（2026-10-28）

结论：本次只证明定向缓存schema故障路径已在当前登录scope恢复；完整F1/F2/F3未验收。运维用户回传5项交付校验均OK，stage result=STAGED_NO_SERVICE_CHANGE/members325，dependencyFingerprint=38fe63889d5af937250239657a0ddedcd8786fc5345437b817a01f7f0a7db15f；两条Run/外部操作活动聚合均0行；activate返回PID191830、WorkingDirectory=/opt/northstar/releases/controlled-trial-20261027-catalog-cache-r5/shell、health ok及ACTIVATED_R5_CATALOG_VERIFICATION_PENDING。

主Agent实际Chrome已有登录会话：首页/原历史可打开；glm-4.7从目录状态未确认变为可手动首调。GET /api/models页面尾部观察到：availability.status=available，catalogDiagnostics.state=fresh、errorCode=null、lastSuccessfulAt=2026-10-28T02:51:19.437Z、failureCount=0、retryAt=null、modelCount=82，syncError未显示。该82为目录记录数，不是82项已通过真实调用或AUTO资格。

同浏览器GET /healthz实际返回：{"ok":true,"status":"ok","version":"1.0.0","pid":191830,"uptimeSec":426,"ts":"2026-10-28T02:51:48.394Z"}，PID与运维新服务一致。未发送聊天/切换模型/媒体生成，不产生付费模型请求。

旧r2基底的端点到聊天能力推断仍在：弹层出现wan视频/speech语音等“可手动首调”；这是保留的旧能力语义缺陷，不是本单文件r5新增，也不得据此尝试把媒体模型当聊天调用。当前开发主线已移除通用openai→textChat推断，但未包含在r5。后续完整上线包须带正确任务矩阵并验证。

剩余：运维核对当前scope原字节备份SHA及0600、空闲重启后的PID/health与同浏览器目录复验。只完成这些后才能将本次定向修复签为对应范围完成；不推广为新OAuth roundtrip或实际模型切换已验收。

## 重启复验回执与独立观察（03:27–03:28 UTC）
- 运维返回两份备份：a5e3a9d03d7281be0e2fc976c6e08211ea11ebe1fd9abee8e8e2b27740cb4f6a、e89ada9f0bd4ca6e57ce693dd52597d92e723d2da37bbc44f6b68323b8142898，各293556字节、0600，matchesName/matchesOriginalSix均true。只要求已访问scope备份，不要求六份同时生成。
- 运维重启后：active，PID192553，WorkingDirectory仍r5；立即公网curl曾502。未提供该502精确时间/代理日志，不能断言原因。
- 主Agent独立公网GET /healthz：2026-10-28T03:27:46.296Z，HTTP200，ok=true，PID192553，uptimeSec179，与运维进程一致。因此当前恢复，无需仅因历史一次502再次重启/回滚。
- 同一既有登录Chrome只读GET /api/models：成功显示{"ok":true,"models":[...]}，记录lastSeenAt 2026-10-28T03:28:16.492Z；本次未出现目录TypeError错误响应。AX对长JSON中段有截断，未重新确认末尾diagnostics/modelCount，不将旧82条数当作本次重新计数。
- 范围结论：备份与重启后公网健康、登录态目录成功返回已验证。尚无新Google OAuth往返、真实聊天/切模型/媒体调用证据；也不证明进程日志完全无错误或先前502的具体原因。

运维后续确认：最初502发生时应用尚未完成启动，随后恢复，无持续故障；据此关闭该次502排障项。2026-10-28追加只读回执：ActiveState=active、PID192553、WorkingDirectory仍r5。未执行额外重启。

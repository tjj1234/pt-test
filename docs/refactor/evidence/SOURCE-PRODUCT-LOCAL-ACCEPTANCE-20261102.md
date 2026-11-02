# 资料检索与删除失效：本地主审验收
结论：LOCAL_CHAIN_CLOSED。主Agent接受当前本地同版链；不代表真实付费模型、目标部署或全量重构通过。

真实Chromium完成跨资料检索、精确引用、持久Run、原生SDK可见结果、确认删除及刷新；HTTP测试验证跨租户拒绝、旧引用拒绝、下载失效、旧轮分岔拒绝、在途Run取消、关闭温会话与冷历史重放边界。原始文件SHA及引用块SHA由宿主重建验证，客户端不提交摘录正文；没有复用客户端或持久化派生索引。失败清理留下持久墓碑和上下文阻断，数据库重开后可重试完成。

范围：txt/md/csv/docx/xlsx/pptx，词面检索；最多选择8份、原始总字节20MiB、每文档前5000块，返回显式截断覆盖；worker有时间/内存/并发限制。历史资料每次刷新最多接入8份，列表最多100份。Word仅声称提取块定位，不声称原始页码。删除保留审计历史，并从后续模型上下文排除受影响旧轮；未声明清除用户独立长期记忆或全部历史审计文件。PDF/OCR、语义向量检索、记忆来源联动仍未验收。

可复跑入口：`node scripts/northstar-chain-checks.mjs --chain retrieval --browser`。源码绑定JSON：retrieval-chain-checks-20261102.json；对应unit-review、probe、http-sdk日志及source-browser-20261102.png。共享代码的reasoning、xlsx浏览器门禁同版重跑通过。

审核中发现并修复：信任绑定缺失、派生索引字段篡改、结果收集无界、虚构定位、跨租户名称泄露、删除后历史复用、在途Run未被覆盖。浏览器确认框会提前返回CLI，旧标记正则可能误读代码回显；已改为显式处理确认框并解析实际JSON返回，截图实际生成。共享文档读取变量遮蔽曾使Office/CSV回归失败，修复后全通过；原失败保留xlsx-shared-regression-before-20261102.txt。全部调用为受控本地adapter，实际付费调用0。

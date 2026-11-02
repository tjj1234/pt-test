# 结果门禁主审及宿主接线（2026-10-28）
结论：原Gemini候选首审47/48，未直接接产品；主Agent修复后52/52。当前可信Run宿主→现有callMediaRoute→独立Python adapter→真实worker→主审门禁→既有持久化回调的离线链路通过；provider传输被替换，未请求PT或部署。

## 关闭的主审问题
| 缺口 | 修正 |
|---|---|
| Proxy trap执行并泄露任意异常 | util.types.isProxy先于对象操作拒绝 |
| toString/__proto__被错误码对象继承命中 | Object.hasOwn白名单 |
| Infinity/对象计费、n=0空结果误成功、冻结原入参 | 有限JSON扫描、计费标量、正数量，禁止共享对象图 |
| URL空authority被WHATWG规范化 | 严格原始authority、userinfo、空白/反斜杠检查 |
| 先全量描述符/序列化才限额 | 增量字节/节点/深度预算，逐属性描述符，先拒大字符串 |
| 真实前置失败billing={}被拒 | 仅明确无ID/URL且未提交错误码允许空billing，输出仍绑定可信宿主参数；不是金额0 |
| completed+REMOTE_TASK_FAILED矛盾误接受 | 远端失败必须明确failed状态；前置拒绝必须空状态 |

## 复用范围
没有新增模型选择器、Run引擎、重试循环或恢复worker：复用已有模型目录准入、adapter精确证据、生命周期、GET-only恢复查询。新增两个Python adapter身份，只能由宿主已通过同Key资格检查的resolvedRoute选中；旧JS adapter验证不能授权Python。图片/图生图继续既有JS执行器；Python只接video/seedance，不在未知付费结果后fallback。
参数复用parseMediaParams；可信opts优先，其次显式args，其次提示词解析，再默认。不支持字段/非法时长分辨率比例在提交前拒绝。Seedance首帧仅asset URI。handler显式提交阶段和父/子signal已接。

## 当前证据与未完成
- 结果门禁52项；真实worker桥及Run宿主/参数回归14项；提交阶段与GET-only恢复4项，均PASS。
- 原引擎67+主审15项及来源SHA测试通过；DSH manifest check通过，固定0.1.1-rc.2。
- 完整回归正在重跑；沙箱内HTTP监听EPERM不是代码通过证据，已获权限用本地HTTP夹具重跑。历史旧归档源码绑定失败不能改旧断言掩盖。
- 新adapter真实model×task资格证据、媒体工具预算/费用上限、同版真实PT/目标浏览器结果/历史、Linux依赖/Python闭包与新冻结包未完成。没有将本次局部接线标为F1完成。

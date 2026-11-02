# 托管媒体落盘主审与整链验证

结论：主审后已接通宿主确认→生成→持久上游结果→匿名抓取→安全落盘→受保护读取→SDK结果/历史；不再把生成结果耐久性寄托于远端临时URL。真实锁定DSH SDK与同一HTTP server的四任务替身链及普通聊天恢复已通过，真实provider/外部CDN、输入资产库桥与目标发布仍未验收。

## Gemini候选主审

原22项实际通过；保留原报告及断言，但修正其中BMFF夹具声明盒长大于实际字节的错误。补8项反例后30/30通过：

| 问题 | 最终边界 |
|---|---|
| O_EXCL失败也清理pending，可能误删另一次尝试的文件 | 仅成功创建后标记tempCreated，失败只清理本次pending；既有pending/final/符号链接均不覆盖、不删除 |
| 导出冻结Set仍可add，从而扩大MP4品牌白名单 | 校验Set私有，公开冻结数组不能改变准入 |
| 兼容品牌扫描越过ftyp盒边界 | 校验32位盒长/最小长度/对齐/实际buffer边界，仅扫描盒内前64字节；拒绝payload中伪装品牌 |
| root pinning在catch之外 | 根打开失败统一静态writer错误；不带路径或cause |
| 参数getter/Proxy、自定义Buffer长度可触发代码 | 六字段精确数据描述符与plain对象校验，Proxy/撤销Proxy及Buffer伪装早拒 |
| 缺短写、零写、fsync失败证据 | 实际短写完成内容；零写/fsync失败清理本次临时文件，错误脱敏 |

模块是具有文件系统副作用的同步发布API，不是纯函数。内容签名只核对有界容器头，不是完整解码/安全扫描；原子link发布及file fsync不等于跨DB事务或断电一致性。输出回执与主publisher的MIME/大小/SHA/Run相互核对。

## 产品接线与证据

`PT_CONTROLLED_MEDIA_AUTHORIZATION=1`现在必须同时配置精确 `PT_MEDIA_ASSET_HOSTS`，缺配置启动/执行失败关闭。默认授权仍关闭。服务复用安全目录句柄及openTenantArtifact：新 `/api/run-media/<Run>/<file>` 校验当前用户/租户/Run，GET/HEAD/单Range，nosniff、无缓存，拒绝symlink/hardlink及非法范围。Run事件记录本地URL/大小/SHA，历史成功消息与运行记录均可重开；上游成功后本地失败保留上游succeeded，Run失败不触发第二POST。

控制参数写入等待确认事件并在签发时核对版本：图片1张/2048×2048（Seedream5关闭系列），视频5秒/720P/16:9。工具参数和prompt不能提高张数、尺寸或时长；确认界面显示固定条件。实际JS图片/视频请求体与Python adapter参数均有断言。这仍不是金额硬上限，不把估算当PT账单。

参考图后续增量：可信宿主从本次已验证上传绑定真实data URL，工具自行提供的URL被替换；SDK只需current-upload标识，避免把大段base64塞入模型与RPC。来源SHA另记Run事件。该增量晚于r6冻结，不能宣称r6已包含；待新修订冻结。

| 实际检查 | 结果与边界 |
|---|---|
| 生成/发布/读取/参数/授权/UI联合 | 当时62/62，模型及网络替身；日志 managed-media-main-integration-20261029.log |
| 同一真实HTTP＋tenant/adapter＋锁定SDK/runner＋host/DB＋执行器 | 四种任务各1提交、2模型/1工具/0重试，图片输入与当前上传一致；托管字节/历史/跨租户拒绝通过；随后同warm实例恢复普通聊天0工具/128输出，日志 managed-media-http-sdk-budget-20261029.log |
| 实际server重启 | 相同隔离DB/runtime重启后媒体字节、历史URL和SHA仍存在；本地保存失败上游保持成功，幂等重放累计提交数不增加 |
| r6归档 | SHA765898fcbd64b55325a0c3c7443c408af57f4ce0884ce71219d4eac67179058f，379成员/178源码；build/check/独立audit/结构预检通过；Linux/amd64 Node22.23.4 closure472/30091与104/104专项通过，Python3.14.4无网络19/19 |
| 最近阶段全回归 | 209套件203通过/6历史源绑定失败；之后参考图绑定增量尚未全仓重跑，不能报当前全仓全绿 |

尚未调用真实PT或外部资产URL，尚未部署。Python视频/Seedance当前输入要求http(s)/asset://，不能直接用普通上传data URL；已确认上游有upload_asset而非新造能力，新的独立Gemini加固任务已准备。上传“免费”仅上游注释，未当作已验证费用事实；后续必须给独立副作用建立授权/意图/恢复，不挤进生成一次POST的授权。

# 媒体预留展示主审与产品接线

结论：Gemini 原26项通过，但原夹具使用另一组taskType，不能与当前API直接互通。主审已修正契约并接入真实server列表API与运行历史的显式核对按钮；联合63项通过。没有真实provider调用或部署，不将展示候选与替身链等同F1交付。

| 主审差异 | 修正与验证 |
|---|---|
| 原任务名为image_generation/video_generation/media_generation/seedance_generation | 改为持久授权/API实际的text2image/image2image/text2video/image2video，标签文生图/图生图/文生视频/图生视频；原26项保留，修正其错误夹具 |
| TASK_LABELS继承属性可被当任务标签 | Object.hasOwn明确白名单，__proto__/constructor/toString和旧别名全部拒绝 |
| Date.parse接受归一化的非法日期 | 严格UTC格式及canonical往返，拒绝2月30日/非法时刻 |
| 扫描先遍历/复制任意描述符，后检查100项/64KiB | 精确root/list/item schema；先检查keys数量和数组长度，再逐个数据描述符；JSON字节增量预算，无未验证输入stringify，超量列表在检查首项描述符前拒绝 |
| Array.prototype被非数组对象借用 | 数组与plain对象分开核对原型；非plain根/item拒绝 |
| modelId仅128字符无命名空间 | 对齐grant有界文本256字符，接受vendor/model；仍拒绝控制字符/HTML字符 |

新增6项主审反例；候选专项32项通过。server的owned列表API保留原raw记录并新增深冻结纯函数生成的view。浏览器只用textContent渲染view且核对所属Run；没有读取即自动释放、没有force/结果/费用参数。明确点击“核对并更新占位”才POST单reservationId；keep_reserved继续提示勿重提，证据不足/网络异常不显示释放成功；释放后原授权仍已消费。列表有hasMore时明确不完整。

联合命令覆盖候选32、HTTP1、核对UI2、历史链接3、恢复25，共63/63；持久日志为 `reservation-view-main-review-unrestricted-20261029.log`。沙箱首轮仅HTTP被EPERM阻断，保留原失败日志，不混记业务失败。当前活动草案门禁独立1项通过。

r5冻结归档：`northstar-controlled-trial-20261029-candidate-34-r5-draft.tar.gz`，SHA256 `cc8c799f77d5348c0e97cad08e545e199f93229486204292e03334e0bf49313b`，374成员/318文件/173绑定源码。builder --check与独立audit通过；通过 `docs/refactor/candidates/current-draft.json` 选择唯一活动草案并严格检查当前源码，旧归档不跟随源码覆盖。默认完整回归中的6项历史源码绑定失败继续原样记录，不删除断言制造全绿。

10/29 r5 Linux/amd64 Node22.23.4、无网络Python3.14.4确切归档验证已启动，结果待收；不能把r4的23项Linux/19项Python直接写成r5结果。媒体授权仍默认关闭，金额硬上限未实现，真实总/单次额度与模型×任务/价格/目标部署回滚门禁未关闭。

# 真实测试前只读价格核对
尚未发起付费POST。测试Key目录HTTP200/82模型，不返回价格，见F1-live-catalog-readonly-20261028.json；不能从可见性推断运行资格或费用。

官方页面只读核对：
- https://powertokens.ai/models/qwen3.8-flash ：Standard每百万tokens输入150 credits、输出470 credits；隐式/显式缓存读取16 credits、缓存创建200 credits。max_completion_tokens为公开参数。网页价格用于请求模型估算，不证明PT实际账单。
- https://powertokens.ai/models/seedream-5-0-260128 与 https://powertokens.ai/pricing ：Standard34 credits/image，模型声明文本/单图/多图输入。生成验收拟固定n=1并禁用自动系列，避免把一次请求等同一张结果。尺寸/实际参数仍需逐项核对，不把展示价当无条件硬上限。
- wan2.7-t2v/i2v模型页当前浏览工具无法读取；不能猜视频费率、不能以旧日志Seedance150 credits当Wan报价。视频候选应先补同模型/分辨率/时长的官方价格来源。

当前缺少用户本轮总credits与单次可接受额度；已异步询问，付费请求保持关闭。该选择影响测试执行，不影响离线开发。实际执行须将请求模型、精确参数、时间、requestId/taskId和用量/估算证据落Run；响应实际模型身份未提供则unknown；未知提交不重提。

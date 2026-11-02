# PowerTokens媒体引擎本地副本

来源、固定commit/blob、MIT许可证及两层补丁的SHA见UPSTREAM.json。复用上游CLI/产品公共payload builder，保留上游代码和许可证；不重写生成引擎。Gemini R3原三个文件保留，主审修正单独记录overlay。

主审补齐：失败envelope在URL前拒绝；错误内容不回显；内部轮询终态以结构字段区分，provider文本不能伪造本地取消/超时；严格任务ID/URL端口/空userinfo校验；实际urllib读取单调截止/取消；取消后持久化失败明确返回。API Key仅产品调用参数，不在费用结果中持久化；调用时身份仍未知，不把配置模型当上游身份。

原R3套件67项及主审15项离线回归通过。进程级强制超时、stdout协议上限、生命周期ACK、同Key准入、Run记账及资产持久化仍由Node宿主负责，尚未启用本模块到生产。Python图生图仍unsupported；现有JS图生图路径的复用和四类F1验收需按明确任务适配器接线，不能声称本模块支持了四类。

不在发布包包含__pycache__/pyc。宿主以固定路径、隔离Python参数导入，只调用generate_for_product，不调用CLI auto/fallback；未证明Python adapter与既有JS adapter的运行证据等价，必须绑定新adapter版本重新验收。

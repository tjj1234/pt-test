# F2 CSV：同版真实模型与产品产物链

2026-10-29，确切r11源码、本地真实产品HTTP入口、锁定DSH SDK和真实PT文本模型完成一次受控CSV Run `70a6a87a-e740-4cbf-ac08-991904bec522`。合成上传源 `amount\n0\n2\n2\n` 的SHA256为 `f275f72265467e0a442e5ca2e5023d3996e3a2b7b17bcc2cde701323cec7bafb`；产品列预览为decimal并绑定同SHA，模型在已确认列上调用一次 `csv_analyze`，Run `completed`，预算1工具/2模型/0重试。托管CSV产物为488字节、SHA256 `bfb5d0ab69cd62de0e4d7a3f6db08db8f984e0f25cc32a4e120467486e4cfd5d`，下载GET200且hash吻合，解析后sum=4，匿名401，历史assistant含同Run产物并可重开。原始证据 `F1-live-agent-20261029-csv-r1.json`；无传输mock，临时加密BYOK库已删除，交互Key进程退出，日志泄露检查false。

这证明该合成CSV的本地同版模型→工具→Run→下载→历史链。未验证真实用户文件、浏览器操作、目标机部署/回滚、AUTO选模或PT官方账单金额。F2此受控样本通过，不能扩展为所有CSV格式/规模及生产交付。

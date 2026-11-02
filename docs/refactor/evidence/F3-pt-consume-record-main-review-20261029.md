# F3 PT 消费记录 R2 主审与叠加修正

Gemini R2 三文件已完整交付；独立复跑原40项通过。主审发现其16 KiB早拒仍对每个字符串先调用 `Buffer.byteLength(val)`，极长纯字符串会被完整扫描后才触发限额。保留原交付，新增 `pt-consume-record-r2-main-review-20261029.patch`：先用字符串UTF-16长度对剩余额度作常数时间早拒，再对最多16 KiB内容计算准确UTF-8长度，原schema、枚举与归一结果不变。`patch --dry-run -p1`通过；独立测试在临时副本应用补丁，原40项全通过，并用10 MiB字符串与字节扫描拦截验证超限值未进入`Buffer.byteLength`。新测试 `f3-pt-consume-record-main-review-test.mjs` 1/1通过。

此层仍是**离线数据归一候选**。当前按Key查询PT消费记录的官方API未确认，不能自动取得当前Key的逐次账单，也不能从本地Run费用估算推出官方扣费。未接server/DB/UI、未改Run结果或支付授权，不纳入r10归档。后续接入需明确可信记录来源、租户归属、request/task精确关联、去重与人工对账状态，并保留来源原值及冲突警告。

# F2 CSV 分析结果导出候选（2026-10-26）

结论：新增隔离候选 `shell/exports/csv-analysis-result-candidate.cjs`，将一次显式列分析映射为现有确定性 CSV writer 的类型表。它在写出前以可信不可变 source 重算结果，拒绝结果值、来源坐标、空值记录或 source 被替换；每个选中行分别标记 `included`、`empty` 或 `missing`，并保留原始文本与行列来源。摘要行携带精确结果与有效数值计数。

验证：`node --test tests/regression/f2-csv-analysis-result-candidate-test.mjs` 为 4/4 PASS；`node --check shell/exports/csv-analysis-result-candidate.cjs` 为退出码 0。测试通过独立 CSV parser 重读导出文本，覆盖前导零、零值、重复行、空单元格、缺列行及篡改拒绝。

边界：这是纯候选模块，没有用户入口、工具注册、Run/call 归属、产物版本、鉴权下载或历史重开；不能计作 F2 完整功能。模块不猜表头/日期/单位，也不改变现有分析器的数值选择语义。最终产物契约应由主 Agent 在共享入口接线时确定。

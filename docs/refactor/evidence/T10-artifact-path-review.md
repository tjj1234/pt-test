# T10 产物路径归一化独立窄审查

日期：2026-10-16。审查当前未提交 `shell/runtime/artifacts.cjs` 路径变更及 `tests/regression/artifacts-boundary-test.mjs`；未改实现或实现者测试，未连接DSH／HTTP。

**结论：FAIL（控制字符范围不完整）；反斜杠归一化与drive-relative拒绝通过。** 实际复跑：

```bash
node --test tests/regression/artifacts-test.mjs tests/regression/artifacts-boundary-test.mjs
```

exit 0；原回归脚本 **75/75断言通过**，新增boundary子测试 **1/1通过**（Node runner显示两个文件/子测试通过，不能误写为只有2条行为断言）。先前POSIX反斜杠失败已修。

独立直接调用 `isSafeRel`／`normalizeArtifact` 的额外探针：`C:foo.md`、混合分隔的上跳、含TAB的C0控制字符均拒绝；正常中文文件名通过。**`out/`＋U+007F DEL＋`file.md` 与 `out/`＋U+0085 NEL＋`file.md` 均仍被接受**，isSafeRel=true且normalizeArtifact返回非null。当前正则只覆盖U+0000–U+001F，未覆盖DEL／C1控制区。若交付要求为「拒绝控制字符」，应补齐明确字符集合（至少DEL；通常Unicode Cc含C1）并加入负向断言，保留正常中文／空格等文件名控制。此处未证明目录逃逸或文件越权，不夸大成已复现安全入侵。

另观察 `out//file.md` 被接受且保留双分隔符，和现有注释「空段（双斜杠）拒绝」不一致；这是旧split正则折叠行为，不是本次新增回归，本轮仅记录非阻塞注释／规范化问题，不扩展成T10其他开发任务。

本审查只覆盖路径字符串归一化与拒绝规则；没有验收产物run/call归属、持久化、历史恢复、realpath／symlink、并发扫描、预览隔离、下载授权或真实浏览器。不能据75断言与boundary通过宣称T10整包完成。

## 修复后独立复验：PASS

同日读取修复后控制字符正则，覆盖C0与DEL/C1（U+0000–001F、007F–009F）。重新执行上述两文件联合命令：原 **75/75断言**、新增boundary **1/1** 均通过，exit 0。独立原反例再次执行：DEL、NEL现在isSafeRel=false且normalizeArtifact=null；另测C1上界U+009F同样拒绝。C:foo、TAB、混合分隔上跳仍拒绝，正常中文反斜杠输入继续归一化为 `out/报告.md`。独立探针共6组拒绝输入与1组正常控制全部通过。

闭环为 **FAIL → 补齐C0/C1范围并新增实施负向断言 → 独立复验PASS**；审查者未改实现或实施者测试。当前结论以本段 **PASS（路径归一化与本轮控制字符边界）** 为准，历史失败保留。原双分隔符注释差异仍是非阻塞记录；所有T10整包限制仍适用。

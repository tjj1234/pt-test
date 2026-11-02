# F1 r2 缓存 schema 与 TypeError 主审（2026-10-27）

结论：已在精确匹配线上四文件SHA的冻结r2中复现确定性缺陷；是否为当前线上根因仍待现场匿名字段计数，不能仅依据480 richRecords定案。无需付费请求或重启来验证缓存形态。

冻结归档SHA256：bcc46626e62a43fd06c2ffc2c3fdb91343939f7125562ea2aaf562df1d0fdc77。使用tests/probes/northstar-r2-catalog-cache-repro.cjs对临时提取shell目录执行，先核对server/catalog/cache/capabilities四源码SHA；只注入假列表传输、写临时fixture缓存，默认外部fetch被禁止。输出见F1-r2-cache-schema-offline-repro-20261027.json。

| 缓存输入 | fresh | backoff | stale+成功列表 | stale+失败列表 | force+成功列表 |
|---|---|---|---|---|---|
| 完整r2规范化记录 | 返回 | 返回 | 返回 | 返回 | 返回 |
| 缺ptEndpointTasks | TypeError | TypeError | TypeError | TypeError | TypeError |
| 缺endpoints | TypeError | TypeError | TypeError | TypeError | TypeError |
| 缺inputModalities | TypeError | TypeError | TypeError | TypeError | TypeError |
| 缺outputModalities | TypeError | TypeError | TypeError | TypeError | TypeError |

25例：5对照返回、20缺陷复现；外部请求0。fresh/backoff无需任何列表请求即可异常，其余每例仅1次注入fixture调用。

## 精确冻结代码路径

catalog-cache.cjs:29只校验schemaVersion、scope/snapshot与models数组，不校验单条rich schema；因此旧rich记录可穿过。model-catalog.cjs:503–512会应用资格局部更新；capabilities.cjs:108在处理新records前先applyLocalUpdates，:97调用eligibility，:82直接读model.ptEndpointTasks.value。缺endpoints在:83，缺模态wrapper在:86同样异常。即使目录刷新成功也先处理旧记录，所以不能假设force refresh可以自愈。server.cjs:136只记录errorCode/errorClass，降级为24项静态目录，抹去失败阶段。

## 当前开发代码的保护证据

当前catalog-cache已校验规范化事实；新增model-catalog-lifecycle回归逐一缺失上述四字段，证明不会进入不安全merge：保留原字节备份，拒绝旧事实授予权限，尝试列表失败时返回稳定PT_HTTP_ERROR及availability unknown，不抛内部TypeError。该文件12/12通过，与failure-stage/匿名探针组合17/17通过。尚无线上新版部署或用户验收，拒绝缓存不是上游可用性证据，也不等于模型已能调用。

## 运维现场确认

单文件scripts/northstar-catalog-cache-shape.cjs只读匹配缓存；最多64文件/每文件4MiB，拒绝文件symlink，输出文件编号、SHA、字节数、mtime与字段计数。不得以清缓存代替取证。若全部6文件480记录均缺ptEndpointTasks且该用户实际使用其中一个scope，支持此缺陷路径；若只有部分文件异常，还需关联当前scope；若全部形态完整，此假设未获现场支持，需要下一层安全位置诊断。

## 现场回传闭合

运维回传探针SHA匹配，实际runtime=/var/lib/northstar/runtime；6文件全部有效envelope、无读/解析/限额错误，每文件80记录，合计480条全部缺ptEndpointTasks，其他被查字段形态错误0。摘要及每文件SHA/mtime留在F1-r2-cache-shape-operator-summary-20261027.json。现场明确存在与离线复现一致的schema缺陷，不再需要重复日志来证明缓存不兼容。尚未执行线上修复；当前用户调用的最终堆栈及修复后恢复仍需同版本验证，不用此结论替代模型资格/真实对话验收。开始准备复用现有cache守卫的单文件冻结r2 backport，旧包及现场缓存不改动。

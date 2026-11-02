# DSH原生图片理解：接线、真实样本与r15冻结

**结论：本地产品已打通DSH原生图片输入→手动资格→图片AUTO追问→冷会话重建；数量/颜色样本通过，字符识别样本失败。T08仍partial，不能称全部图片/OCR/音视频理解完成。** 未改正在部署的r14；r15是新草案，不交运维替换当前修复流程。

实际复用：DSH `admitEncodedImages`/`AttachmentStore.saveImages`负责原生校验、归一化与持久内容引用；`ImageBlock.attachment`进入Session；pi-ai负责请求图片投影；`resolveModelInfo`检查精确模型是否接受image。北极星只补可信附件字节、租户/SHA复核、Run预算和调用意图、目录资格与冷历史映射，不实现另一套图片处理引擎。profile新增helper在manifest内固定，已有profile升级需离线重建。

| 证据 | 结果与边界 |
|---|---|
| 同Key只读目录 | [83项安全字段](native-image-catalog-live-20261030.json)，无明确图片任务/输入字段；未把endpoint或模型名猜为vision支持，0付费POST |
| 精确能力来源 | PT官方 `https://powertokens.ai/models/qwen3.8-flash` 在2026-10-30核对时声明图片输入及chat completions；仅为该ID补公开事实和DSH模型input配置，不授予权限或运行验证。实际权限仍来自当次同Key目录 |
| 离线原生CLI/pi-ai | `tests/probes/dsh-native-image-offline-20261030.mjs`：两次请求均实际带image_url，热会话保留图像；切纯文本模型不新增HTTP。输入证据来自Runner而非用户字段 |
| 本地HTTP/锁定SDK | 原生附件存储、真实PGlite、上传/Run/冷重放/缓存资格写回、AUTO、变更文件/跨租户拒绝；外部模型为替身 |
| 真实字符识别 | [vision-r1](F1-live-agent-20261029-vision-r1.json)：Run completed，但R7K2读成RTK2，整体INCOMPLETE；后续轮次未执行，失败不覆盖 |
| 真实数量/颜色 | [同图三轮](F1-live-agent-20261029-vision-shapes-r1.json)：手动c5e47953-b847-46af-a610-328dc7a886a2→图片AUTO c5ecac4c-4334-4324-bb16-8348e8712db9→冷重建ee35d335-7967-44dd-a26d-c56a89028777均completed，owned历史答案为3/red/red且Run归属匹配；各1模型/0工具/0重试，实际美元消耗未知 |
| 凭据 | 真实测试用用户已授权余额；Key通过非回显TTY进入进程，测试产品临时加密库已删除、Key进程已退出，日志泄漏检查false |
| r15冻结 | 归档SHA `b9ee729f7138f61bd3e0d247b7fe006ebf88bd1e5b511e609ffe25f735c2db67`，187源码绑定/388成员，builder --check、独立审计通过；r14 SHA仍为f0001e9b…17a0b993 |
| 完整回归 | [日志](continuation-r15-20261030-regression-unrestricted.log)：225套件219通过/6历史候选或旧lock来源绑定失败；candidate31/32超时保留，不记全绿 |
| 确切归档Linux | [日志](r15-linux-20261030.log)：Linux/amd64 Node22.23.4 clean npm ci（含安装脚本），闭包472包/30091文件、归档源码图片四套件10/10通过。后续只读docker ps的沙箱权限错误不属于该运行日志；容器运行exit0 |

产品边界：单条host输入最多4张/合计10MiB；当前UI仍单图，冷启动仅重放最近3张历史用户图和当前图，逐张核验原始tenant/SHA，旧图不可核验就拒绝。模型input能力未知或纯文本时不静默转图片占位符；image AUTO资格独立于textChat，初次需匹配scope/revision/adapter的手动图片Run；权限或目录修订变化不能复用旧资格。多图UI、20MB档位、复杂OCR/图表、不同模型/用户/目标环境、音频和视频理解尚未完成。

后续Office核查：锁定DSH tool-fs文档明确UTF-8 read，PDF/音视频解析未提供；现有document-export候选PDF使用Type1 Helvetica却写UTF-16文本，中文渲染有风险；XLSX引擎依赖analytics外部安装，不在shell闭包中。不能直接接为完整导出；需必要格式库/受限worker、渲染及独立读取验证，保留原生工具/Session/产物协议。

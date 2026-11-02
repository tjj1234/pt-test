# candidate-34-r11 归档内业务回归（2026-10-29）

结论：冻结归档 SHA-256 `0c8fd82cfaac5c13c5c20e2e475a9f76cb37a085096f2238c2cc62ba051e75a1` 解包后，使用归档内业务源码及复制的本机 `shell/node_modules`，运行三项回归 **3/3 PASS**：四媒体同版 HTTP/锁定 SDK 授权、生成、托管与历史重开；媒体 Run 完成门禁；显式媒体任务意图保持。测试文件从当前工作树复制到隔离解包目录，不属于发布归档。无真实 PT 请求、付费或目标部署。

执行：解包至 `/private/tmp/northstar-r11-archive-business-ilg23i84`；复制三项 `tests/regression/f1-{media-result-acceptance,managed-media-http-sdk,model-media-task-http}-test.mjs`；实体复制当前 `shell/node_modules`；在解包根运行 `node --test` 三文件。第一次尝试用依赖软链接，四媒体用例因 DSH 安装真实性校验 `DSH_ENTRY_UNTRUSTED` 失败（2/3）；实体复制后 3/3 PASS，约 6.3 秒。沙箱禁止本地端口监听，最终复跑在已授权非沙箱环境执行。

随后在 `node:22-bookworm-slim`、`--platform linux/amd64` 的一次性容器中重新解包**同一归档**，只复制上述三项测试，从归档 `shell/package-lock.json` 执行 `npm ci --ignore-scripts --no-audit --no-fund --silent`，再在 `/work` 执行相同 `node --test`：**3/3 PASS**，测试耗时约 8.5 秒，容器退出码 0。命令使用 `/input` 仓库只读挂载；容器删除，不更改发布归档。`--ignore-scripts` 意味着此轮没有验证依赖安装脚本。独立生产依赖闭包另见 `r11-linux-node-20261029.log`。

证据边界：已证实 r11 归档业务源码在 Linux/amd64 Node22 的三项离线 HTTP/SDK 回归；测试夹具从工作树复制，PT 模型、生成及资产外部 HTTP 均为替身。这仍不等于目标机部署/回滚、真实图生视频或生产验收。R2 上传桥当前仍由 Gemini 独占开发，未纳入 r11。

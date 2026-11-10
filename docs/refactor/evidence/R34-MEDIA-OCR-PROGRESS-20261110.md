# R34 音视频与 OCR：本地集成证据

2026-11-10，主程独立集成。状态：本地候选；未部署、未独立 QA。不得据此宣布 Gemini 01–08 或 R34 整体完成。

DSH 锁定版本仅支持 text/image 内容块，不能传递原生 audio/video；复用其 image 附件通道，最小宿主补充本地解码、Whisper 转写、采样帧及 Tesseract OCR。未创建另一个模型工具引擎，未调用外部付费 ASR。

## 实测范围

`tests/probes/r34-native-media-linux-20261110.cjs` 在 Linux/x64 Node 22 容器中运行，网络为 none，源与运行库只读挂载，四组通过：真实 JFK WAV 转写与毫秒定位；中文图片 OCR（有识别误差）；实际 MP4 解码与 0/1500/2000ms 三帧；启动前及在途取消。语音原始字节 SHA256：`59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`。该证据不是正式服务端到端、浏览器或独立 QA。

`shell/media/local-content-runtime.cjs`：验证发布私有 ELF/模型清单；每次最多 50MB、300 秒、一个媒体任务；固定程序与参数、无凭据子进程环境、CPU/地址空间/FD 限额、进程组取消与退出后清理；视频最多三帧。系统 `prlimit` 必须存在。该执行器不是通用脚本隔离包 06，不能用资源限制替代网络、租户或文件系统隔离验收。

`shell/server.cjs`：精确读取持久化上传快照，当前最多一个媒体输入；视频走原生 imageUnderstanding 资格检查；转写与帧定位作为不可信数据进入上下文。共享 Run 信号取消，解析失败在模型调用前返回错误。此宿主接线尚待真实 HTTP/SDK 集成复测。

PDF 空文字页经原有 worker 渲染，再由父进程启动受控 OCR，保持解析槽位直至 OCR 子进程退出；取消或 deadline 联动子进程。最多十页 OCR、单页三百万像素、PNG 两 MB、全文五 MB。保留物理页定位及原文件哈希。Darwin 回归仅验证无 Linux 后端时明确失败，不能替代 Linux PDF/OCR 全链路验收。

## 发布输入与来源

构建脚本：`scripts/export-native-media-runtime.py`；本地大型输入位于隔离工作树 `.release-inputs/whisper/`，不纳入源码 Git。发布必须显式收入私有运行库并冻结清单，不能在生产启动时下载。

| 输入 | 绑定 |
|---|---|
| whisper.cpp | 官方 v1.7.6；源 tar SHA256 `166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e` |
| ggml-tiny.bin | 官方模型 SHA1 `bd577a113a864445d4c299885e0cb97d4ba92b5f`；SHA256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| whisper-cli | Linux/x64、CPU，静态 C++ 运行库；SHA256 `82df67eed9c7452facdbd9dd603e461097e84c2c55e1b895a04923fe00778667` |
| FFmpeg/Tesseract | Debian 签名仓库二进制与实际 ELF 闭包；附包版本、copyright、Whisper 源/模型 MIT 许可；最终归档必须绑定运行库 manifest SHA256 |

追加验证：同一源码在 Linux/x64、非 root UID 501、禁网容器中，使用锁文件重新安装的 Linux 依赖，`office-http-sdk-integration-test.mjs` 通过。涵盖实际音频上传、跨用户拒绝、转写/哈希/时长进入宿主 Run 和原生模型请求；实际 MP4 上传，三帧经 DSH 原生附件读取并进入模型请求，0/1500/2000ms 定位和源哈希保留；同时覆盖既有 Office/PDF、导出和历史恢复。模型为受控 SDK 适配器，非真实付费模型。非 root 测试发现 FFmpeg 自动线程数与 NPROC 限额冲突，已明确限制解码/滤镜/编码线程为 2 后重测通过。

Linux PDF 五项回归通过，新增真实扫描 PDF 第二页中文 OCR、物理页定位及原文件哈希一致性。不是图片固定返回或假转写。

依然待完成：Linux PDF/OCR 源检索宿主全链路、音视频浏览器交互、发布归档收录和正式平台资源/隔离核验。生产保留 R33；Bug-12 保留 DEGRADED_PREVIEW。

## SSH 恢复核对

2026-11-10T04:07:48Z，通过用户恢复的共享 SSH 只读检查：`northstar-shell` active/running，PID 367662，NRestarts 0；工作目录仍为 R33 questions-m1-draft，localhost:8098/healthz ok。本轮未改生产数据库、服务或版本。sudo 仍需交互验证，不能把 SSH 连通当作发布完成。

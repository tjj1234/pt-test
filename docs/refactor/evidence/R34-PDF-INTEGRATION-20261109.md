# R34 PDF 输入与中文导出集成（2026-11-09）
结论：本地集成已完成文字层 PDF 上传→受限 worker 解析→真实页码引用→DSH Run→持久资料检索，以及会话 PDF 导出入口。未部署，不宣告02/03整包完成。

| 验证 | 结果与边界 |
|---|---|
| 同版综合回归 | 18/18；PDF、Office、Word、资料检索与撤销、真实本机 HTTP 和锁定 DSH SDK；模型为本地 fixture，无付费调用 |
| HTTP | XLSX/PPTX/PDF 均到达原生 DSH 请求并完成 Run；Word/PDF 下载指纹一致；PDF 资料检索保留第2页；跨账号导出/检索404 |
| 中文 PDF | PDFKit 实际嵌入 Noto 字体子集；PDF.js 提取核对中文/字面公式/编号；实际渲染并查看 [页面图](R34-PDF-CJK-RENDER-20261109.png) |
| 限制与取消 | PDF 20MB/200页/5MB提取文字；原有最多2 worker、128MB堆、最长15秒与退出后释放；超限、格式伪造、取消、期限均拒绝 |
| 未覆盖能力 | 扫描件 OCR、图表理解、通用结构化文档生成工具仍未完成；纯扫描页返回明确 OCR_REQUIRED；部分无文字页显式计warning，不冒称完整提取 |
| 不支持字形 | 明确导出失败，避免静默丢字；当前字体不保证全部emoji/全球文字 |

依赖固定 pdfjs-dist 6.5.438（Apache-2.0）、pdfkit 0.20.2（MIT）。字体 Noto Sans CJK SC 2.004（OFL-1.1），原始字体、许可、copyright及SHA在 shell/exports/fonts；官方来源链接随 SOURCE.json。新增031仅扩展 document_sources 的格式约束；已有数据不改写。DSH 清单重新生成并逐项比较，唯一变化为锁文件SHA，原生DSH文件、版本、vendor/integrity不变。

早期失败保留边界：沙箱 listen EPERM 后授权重跑；新依赖导致 DSH_LOCK_MISMATCH 后修复正式信任绑定再重跑，未绕过校验。最终18/18包含新增PDF持久检索与跨账号断言。生产仍R33，031未执行；最终打包必须纳入新源、字体与迁移，并重新完成Linux依赖闭包。

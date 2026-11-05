# 剩余25包规格与Mermaid实际渲染核查
2026-11-04｜范围：11–35共25包；01–08由用户确认Gemini完成，09/10样本已通过，以上10包正文均未在本轮改动。结果只证明规格文件、引用/映射及图可渲染，不证明产品已实现、主审、集成、staging/生产验收或发布。

| 检查 | 结果与证据 |
|---|---|
| 分类 | 17个交互/混合型：11/12/13、19–30、32、35；8个后端/验收治理型：14–18、31、33、34 |
| 用户三件套 | 17包各含独立决策树、默认界面/用户动作/兜底/AC分步表、建议与责任明确的待决策；后端8包采用契约/操作与恢复矩阵 |
| Mermaid实际渲染 | Mermaid 12.3.0＋Puppeteer 24.37.5＋无头Google Chrome；20/20生成SVG，0失败。包括17新图及09/10/交付流程3张既有图；逐图源文件SHA/图SHA/输出见[原始报告](package-spec-mermaid-20261104/render-report.json) |
| 结构与映射 | 25包共281条AC、99条决策（含用户、技术和外部责任，数量不是产品完成率）；图节点→分步表覆盖、AC唯一/引用、相对链接、表格列、代码围栏和尾随空白均检查，见[机器结果](package-spec-mermaid-20261104/document-checks.json) |
| 排除范围 | 01–08任务包及09/10样本共10份正文与本轮起始指纹一致；不重写原8包，不改样本已通过的规格。Gemini交付批次文档出现并发更新，本轮未写入该文件，保留其内容 |
| 证据边界 | 纯Markdown规格修改未跑产品回归；未启动任务实现、测试Agent、真实PT/付费、外发/采购、生产操作或部署；未git add/commit/push |

所有25包及每图SVG入口在[分类与待决策索引](../PACKAGE-SPEC-INDEX-20261104.md)，状态见[主台账](../REFACTOR-MASTER-TRACKER-20261103.md)。主台账记录用户本轮已通过09/10；样本原文的SPEC_REVIEW_PENDING为上轮编辑时状态，未为改状态而重写样本。99条决策并非要求用户回答技术调查：用户拍板产品/费用/资源选项，负责人核实接口/平台，PT提供上游事实回执。

## 复现方法
渲染器：[render-package-specs-20261104.cjs](render-package-specs-20261104.cjs)。默认从索引读取25包，附加09/10/交付流程，提取反引号或波浪号Mermaid围栏，实际调用mermaid.render并保存SVG/报告；异常返回非零。可传仓库相对Markdown路径仅验指定图。源码/图变化后报告hash失效，需重渲受影响图，不沿用旧PASS。
工具安装在临时目录，未修改项目package/lock。示例使用绝对工具路径环境变量，可按本机安装替换；无头浏览器在受限沙箱中可能需要明确批准运行，本轮已批准且实际完成。

```sh
npm install --prefix /private/tmp/pt-package-mermaid-tools --no-save --ignore-scripts mermaid@12.3.0 puppeteer@24.37.5
PUPPETEER_MODULE=/private/tmp/pt-package-mermaid-tools/node_modules/puppeteer \
MERMAID_JS=/private/tmp/pt-package-mermaid-tools/node_modules/mermaid/dist/mermaid.min.js \
MERMAID_VERSION=12.3.0 \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node docs/refactor/evidence/render-package-specs-20261104.cjs
```

本轮自查修订了自动标题落库与手动命名锁定的区别、取消请求后回到权威查询、周期规则完成后等待下一触发，并重渲全部图。渲染不检查语义，因此保留逐节点/AC映射和人工业务走查，不把语法PASS替代需求主审。

## 32包规格稿2补验（2026-11-04）
补齐已有配对设备直连、离线/超时保留信任、确认失效才主动重配，以及已有有效root优先复用；32-02明确老设备不创建配对码，32-03/05/11细化权限/离线/账号切换。新挑战身份验证与网络失败分支分开，重连不重放离线写入。本次重新实际渲染并更新20图源指纹及SVG；机械检查重新验证节点/AC/链接。此处仍为文档核查，不代表本地伴侣实现、协议探针或产品E2E已经通过。

## 17包/AUTO规格补验（2026-11-04）
17新增8项AC至18项，25包总计281项，仍为后端治理型，无需用户流程图；新增08补充接线契约和PT-01零费用拒绝语义确认需求。原08任务包/实现/契约/探针指纹核对一致、未改；26/26仍是原作者报告，本轮未复跑。现有20图源和渲染证据未受本次无图规格变更影响，未无故重渲；更新机器文档核查和新增契约链接/AC引用。自动同步、真实PT及执行失败后切换均未在本轮运行。

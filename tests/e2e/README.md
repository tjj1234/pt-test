# 北极星 Agent 生产级 E2E 验收测试套件 (tester-army/e2e)

本目录为北极星（Northstar / pt-test）社媒增长 Agent 平台专用的**用户层黑盒感知 E2E 验收测试套件**，基于 [`tester-army/e2e`](https://github.com/tester-army/e2e) 构建。

---

## 一、 第一批核心用例清单（🔴 阻断级门禁）

| 文件名 | 对应风险与场景 | 判定标准（确定性断言） |
|---|---|---|
| `01-model-unknown-error.spec.ts` | 对应 UNKNOWN_MODEL 事故：选择未注册或失效模型 | 拒绝通用黑盒错误；通知区人话化解释并建议切换可用模型；严禁 500 黄屏。 |
| `02-reasoning-effort-isolation.spec.ts` | 对应模型档位跨模型残留事故：高推理切普通切低推理 | 控件自动显隐；网络 Payload 拦截，严格保证发往后端的参数无历史残留。 |
| `03-media-config-friendly-error.spec.ts` | 对应 10/30 媒体配置缺失事故：文生视频/Seedance 协议拦截 | 明确区分“系统配置缺失”与“用户Key问题”；Seedance 给出明确协议签署引导。 |
| `04-tenant-isolation-url-tamper.spec.ts` | 多租户横向越权拦截与未绑 Key 引导 | 篡改 `conversationId` URL 拒绝加载聊天记录；未绑 Key 用户弹出显著设置引导横幅。 |
| `05-chat-error-degradation.spec.ts` | 模型网关超时或网络中断体验 | 发送按钮不卡死（不无限转圈）；明确告知未产生计费并支持重试。 |
| `06-navigation-subsystems-smoke.spec.ts` | 全域导航与侧边栏业务线子系统冒烟巡检 | 自动巡检业务流库状态、归因导入 Token (防 403 invalid token)、归因看板 (防 CSP 拦截)。 |
| `07-human-exploratory-interactions.spec.ts` | 人类探索性与破坏性人机容错用例 | 覆盖无字纯图发送提示、剪贴板多格式粘贴、资料检索删除、多模态任务模型过滤与倒计时。 |

---

## 二、 运行准备与执行命令

待后端重构（包括 Context R4 等）完成交付后，进入全流程自动化实测阶段：

### 1. 安装与初始化
```bash
# 1. 确保安装 e2e
npm install -D e2e

# 2. 配置 e2e 自身驱动用的廉价模型（支持 gpt-4o-mini、deepseek-chat 或兼容 API）
export OPENAI_BASE_URL="https://api.openai.com/v1" # 或你的代理地址
export OPENAI_API_KEY="sk-..."                     # 驱动用的小模型 Key，单次运行消耗几分钱
```

### 2. 本地服务就绪
```bash
# 启动看板后端（8095）
cd analytics && node start.cjs

# 启动业务壳后端（8098）
cd shell && node server.cjs
```

### 3. 执行测试
```bash
# 运行全部 E2E 验收用例
npx e2e run tests/e2e/

# 仅运行指定单个用例
npx e2e run tests/e2e/02-reasoning-effort-isolation.spec.ts
```

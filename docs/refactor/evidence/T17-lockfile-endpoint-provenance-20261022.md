# T17 本地锁文件与 PT 任务映射来源增量（2026-10-22）

**范围：** 只复核当前 candidate-17 冻结内容与工作区中的 lockfile 字节、解析已锁版本，并记录 PT 技术团队对 `supported_endpoint_types` 的语义确认。未读取 `.env`、未输出秘密、未对 PT/模型/registry 发起请求。本证据不代表目标机安装、供应商 SLA、官方版本有效期、价格、region 或 T17/AC23 整体验收。

## 冻结依赖证据

三个 candidate-17 lockfile 与工作区相同 SHA-256，均为 lockfileVersion 3：

| 锁文件 | SHA-256 |
|---|---|
| `shell/package-lock.json` | `96c89082800cc682307a61436d115f5d080bb40a6f3c53a08c0478023fc993f3` |
| `analytics/package-lock.json` | `7ba7d25c51f71024a302d1c0a3ea64489510b87875355cba207c35b25dd1ae04` |
| `business/attribution/package-lock.json` | `49944f7144baf429d5f827744bb519bdba972f96f02fef7ef31d12f642aa8d22` |

锁文件中可直接验证的代表版本：shell 为 `@deepseek-ai/dsh@0.1.1-rc.2`（仓库 vendor tarball）、`@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`、`@earendil-works/pi-ai@0.82.1`、`pg@8.23.1`、`nodemailer@6.10.1`；analytics 为 `fastify@4.29.1`、`pg@8.23.0`。版本仅来自锁文件；未重新下载或重验 registry tarball，也不证明目标端 clean install。

## PT endpoint 语义

PT 技术团队确认 `supported_endpoint_types` 的可信映射：`anthropic`、`openai`、`openai-response` 表示聊天；`image-generation` 表示图片生成；`openai-video` 表示视频生成。用户已确认当前 key 的 `/v1/models` 返回 ID 可作为 `permission=true`，并同意启用相应 textChat `localPolicy`。实现位于 `shell/models/capabilities.cjs`，五类字段映射及不隐式推断其它任务由 `tests/regression/model-capabilities-review-test.mjs` 覆盖，7/7 PASS；整套本地回归此前为117/117 PASS。

此规则只声明生成/聊天任务类别：图片/视频生成不证明视觉理解，不证明 adapter 已覆盖生成接口，也不证明模型运行时验证、目标机权限、价格、region、quota 或 SLA。`supported_endpoints` 兼容别名不继承此可信语义。真实目录和 provider 调用仍须走受控目标机资格门及既有一次性验证额度。

## 未闭合项

owner/批准者、官方 provider schema 来源和有效期、价格/地区/输出域名、生产配置加载、Key 轮换和失效流程、clean install/目标机验证仍为 unknown 或 untested。故本增量只推进 T17 来源记录和 T06 映射依据，不将 T17、AC23、T06 或线上资格 Run 标为通过。

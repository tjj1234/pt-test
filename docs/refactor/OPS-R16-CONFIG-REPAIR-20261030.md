# r14普通对话故障修复与r16配置交付
结论：目标机回执`logs20261030`确认12条UNKNOWN_MODEL、8条RUN_MODEL_CALL_LIMIT、1条INVALID_REQUEST、4条旧UNKNOWN。动态目录中两个DeepSeek ID未在r14模板注册，构成可复现缺陷；日志不带模型/Run，不能逐条归因。不要通过增加预算掩盖错误。r16已修复目录准入及错误分类，但仍是DRAFT_NOT_FOR_DEPLOYMENT，未操作线上服务。

| 交付 | 文件/证据 | 状态 |
|---|---|---|
| 修复草案 | `release-artifacts/northstar-controlled-trial-20261030-candidate-34-r16-draft.tar.gz` | SHA256 `5ca372213a0aa22a9b00777cfe51fccc6542f72b027f116afd3e5205cdeb5119`，193源码/394成员 |
| 目录准入 | 读取实际DSH home settings；未注册模型标记dshConfigured=false，chat/图片理解路由拒绝；保留目录和媒体事实 | 源码已修，不自动覆盖目标配置 |
| 模型注册 | 新模板精确新增deepseek-flash、deepseek-v4-1-flash-260910 | 只启用手动资格，未伪造AUTO/运行验证 |
| 诊断 | UNKNOWN_MODEL/NO_ADAPTER/INVALID_REQUEST固定脱敏消息 | 原生离线链已验证未知模型零HTTP、两ID热切换成功、400安全分类 |
| 依赖 | 新Linux/amd64 Node22.23.4 closure495包/31007文件 | 全部锁定包干净安装+确切归档闭包校验 |
| 媒体配置 | PT_MEDIA_REVIEW_FILE、PT_CONTROLLED_MEDIA_AUTHORIZATION、PT_MEDIA_ASSET_HOSTS | 目标缺失，尚待同Key scope/revision/permission及受限CDN确认 |

## 立即可做的目标只读核验
运维从**当前r14 shell目录**运行下列命令；只输出指定模型是否注册，不输出settings正文、环境或Key。不要用模板的内容代替实际home配置。
```bash
set -euo pipefail
cd /opt/northstar/releases/controlled-trial-20261030-candidate-34-r14/shell
sudo -u northstar /usr/local/bin/node --env-file=/etc/northstar/northstar.env -e 'try{const fs=require("node:fs"),path=require("node:path"),YAML=require("yaml");const home=require("./tenant.cjs").DSH_HOME;const raw=YAML.parse(fs.readFileSync(path.join(home,"settings.yaml"),"utf8"));const models=raw?.["llm-pi-ai"]?.providers?.powertokens?.models;const ids=new Set(Array.isArray(models)?models.map(m=>m.id):[]);console.log(JSON.stringify({activeSettingsReadable:true,configuredModelCount:ids.size,models:Object.fromEntries(["deepseek-flash","deepseek-v4-1-flash-260910","qwen3.8-flash","seed-2-0-lite-260228"].map(id=>[id,ids.has(id)]))}));}catch{console.log(JSON.stringify({activeSettingsReadable:false,code:"DSH_SETTINGS_INSPECTION_FAILED"}));process.exitCode=1;}'
```

## 配置升级与回滚顺序
修复发布必须独立新release，不能覆盖r14归档或直接部署脏工作区。完成最终门禁和目标预检后，再锁定unit/目标路径及切换命令。
1. 停止所有使用该home的Northstar/DSH进程；备份数据库、home、环境文件与unit，记录确切旧release、profile备份和settings事务。不得清理manifest/锁/home。
2. 在新release的shell目录调用包内`runtime/settings-version.cjs`的`inspectSettings({home,template})`（template为新release的dsh-settings.yaml）。若尚无基线，先人工核对旧release模板与实际配置再adopt；adopt只是记录审核，不迁移配置。
3. 只有实际配置与旧基线/旧模板完全相等时，才按inspect输出的三个确切hash调用包内`runtime/settings-upgrade.cjs`的`upgradeSettings({home,template,expected,reviewed:true,offline:true})`。`scripts/northstar-profile.cjs`仅存在源码树，不在应用归档内，勿在目标假定其存在。若存在运维编辑，维护器会拒绝；保留自定义设置，人工合并后再adopt，禁止自动整份覆盖。
4. settings升级和profile重建是两个操作。执行新release包内rebuild，保留backupDir，再调用makeProfile验证；不能只重建profile而让旧模型配置继续生效。
5. 启动后核对实际ExecStart/WorkingDirectory、local/public health。新会话手动选两个DeepSeek ID逐个做最小普通对话，核对completed、configured与provider模型身份、预算、历史重开。首个成功Run后再验证AUTO；不能用health或目录HTTP200代替。
6. 回滚同时恢复旧unit/release、对应profile和对应settings；只回滚unit可能因新profile/新settings导致旧版继续失败。旧备份与事务目录保留。

## 媒体配置交付闭环
只读预检脚本`scripts/northstar-media-config-preflight.cjs`可单独传到目标/tmp；从确切release shell目录，用现有服务env执行。脚本不读取/输出Key、不联网、不签发授权；exit2表示配置缺失/无效，exit0仅表示结构与时间有效，仍须同Key目录核验。
待同Key三个模型scopeId、capabilityRevision、permission回执后，生成精确审核文件（最长24h）、审核来源、受限CDN列表及环境差异；不复制本地scope，不全模型放行，不构造runtime验证。运维安装后先跑预检与fresh媒体矩阵，再由产品显式单次确认生成。未知外部操作只GET核对，禁止重复提交。媒体包当前未完成这一目标验收。

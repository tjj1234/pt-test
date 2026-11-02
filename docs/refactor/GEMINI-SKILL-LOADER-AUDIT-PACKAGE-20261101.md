# Gemini独立任务：PM Skill发布与原生loader接线实证
状态：READY_NOT_STARTED；调度：排队 F，待首批释放名额。目标日期2026-11-02，目标不是已保证的验收承诺。

## 所有权与统一约束
工作区 `/Users/mmdn/Downloads/pt项目`；主Agent并行修改推理元数据RPC、UI→Run→Runner。仅允许新增以下独占文件，并在本任务包末尾追加实际交付记录：
- `tests/probes/skill-loader-native-audit-20261101.mjs`
- `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.md`
- `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.json`

任何独占文件已存在先报告冲突，不覆盖；R1/R2/R3与他人文件只读。不得修改server、tenant、Runner、adapter、UI、profile、package/lock、migration、WORKLOG、HANDOFF、release-artifacts、current-draft；不得commit/push/merge/部署/付费调用、找历史凭据、升级依赖、启动其他Agent。禁止替主Agent生成活动发布包。
优先复用锁定DSH及已有候选，核对真实安装版本和API；依赖仅从受信shell锁定解析，禁止cwd/NODE_PATH/analytics意外回退。测试临时文件仅进os.tmpdir且finally清理。localhost替身可用，真实PT、公网模型、真实Key均禁止。独立包通过不等于生产接入或全量交付。

## 必须完成与验收
先读shell/skills/release-snapshot.cjs、tenant.cjs首拷贝、当前profile/Runner原生skill与tool registry，核实锁定DSH loader/tool-skill包与公开API。目标是明确发布/禁用/版本pin到原生执行的可复用路径，不再造Skill引擎。
临时home/workspace中使用无害fixture skill，实际加载锁定DSH原生loader并调用公开工具入口；证明锁定内容身份加载、同名版本热更新边界、Run pin重开后内容一致、禁用后新Run拒绝、旧Run策略需主Agent明示。若原生API不能pin，展示准确缺口，提出不可变发布目录+宿主manifest的最小方案，不宣称现有原生已支持。
测试租户隔离、目录/符号链接逃逸、未发布内容、内容hash漂移、同名冲突；不启用bash/OS/网络、不让fixture执行任意脚本。实际原生可见的工具schema与权限不能由SKILL.md文字自动授权；输出发布接口/Run持久字段/loader入口/撤销与取消接缝。仅临时目录与报告，禁止修改共享生产文件或全局安装目录。

## 执行与汇报
- `node tests/probes/skill-loader-native-audit-20261101.mjs`
记录完整命令、退出码、通过/失败数、fixture与实际原生证据区分、源码/依赖版本和SHA、失败及修复经过、资源/取消/隔离反例、主线接线契约、未验证项。交付四要素：文件已落盘、报告存在、命令独立可复跑、在本任务包末尾追加实际汇报。不提前写COMPLETED或只给PASS摘要。报告里保留确切BLOCKED项目，不能用模拟替换任务要求。

## 交付与实际汇报记录 (2026-11-01)

- **任务状态**: AUDIT_DELIVERED (技能 Loader 审计实证完成，确立原生真实缺口并给出最小宿主接线方案)
- **交付四要素核验**:
  1. 独占文件已落盘：
     - `tests/probes/skill-loader-native-audit-20261101.mjs`
     - `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.md`
     - `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.json`
  2. 详细实证报告已存在并包含完整证据分析与最小架构契约设计。
  3. 独立探针命令可复跑且零网络调用、零真实凭据泄漏、临时测试目录完全隔离在 os.tmpdir 下且 finally 自动清理。
  4. 完整汇报记录写回本任务包末尾。

### 1. 验证命令与测试结果
- **探针执行命令**: `node tests/probes/skill-loader-native-audit-20261101.mjs`
- **退出码**: 0
- **测试通过情况**: 7 项用例全部通过 (7 PASS, 0 FAIL)
- **测试安全保障**: 纯无害 fixture，不启用 bash/OS 执行，不连接外网。

### 2. 核心审计发现与原生真实缺口 (REAL GAP)
1. **DSH 原生 Loader 机制确认**:
   - `@deepseek-ai/dsh-skill@0.1.1-rc.2`: `SkillRegistry` 维护全局与作用域目录，支持 `list()`, `get(name)`。
   - `@deepseek-ai/dsh-skill-filesystem@0.1.1-rc.2`: `FileSystemSkillProvider` 扫描指定根目录下的 `SKILL.md`，解析 YAML frontmatter 与 markdown body。
   - `@deepseek-ai/dsh-tool-skill@0.1.1-rc.2`: 将技能格式化为 `<skill_content>` 注入模型上下文。
2. **准确缺口 1: 原生 API 无版本 (version) 与 contentHash 参数**:
   - `ctx.skills.get(name)` 仅接收名称，没有提供版本入参；技能定义对象不记录版本号。
3. **准确缺口 2: 内容哈希漂移 (Content Hash Drift)**:
   - 官方 README 明确指出：“Bodies are not versioned”。
   - 实证结果显示：在同一活跃会话/Run 执行期间，若磁盘上的 `SKILL.md` 被热更新或同名覆盖，下一次 `ctx.skills.get()` 立即返回修改后的新内容。两份快照测算的 `contentHash` 发生漂移，原生 loader 无法保护活跃 Run 的内容一致性。
4. **准确缺口 3: 原生缺乏持久禁用/撤销管理接口**:
   - 原生 loader 自动挂载目录中所有合法 `SKILL.md`，无 `disableSkill(id)` API，停用必须依赖宿主外层门禁。
5. **安全边界确认**:
   - SKILL.md 内部文字绝不能自动授权工具权限。探针证实伪造的 `allowedTools: ["bash", "network"]` 无法越过宿主 `ctx.tools` 硬门禁。

### 3. 推荐的最小宿主接线方案 (Minimal Host Seam)
无需重写 Skill 引擎或修改 DSH 源码，通过宿主物理结构实现版本锁定：
1. **不可变发布存储**:
   - 技能发布时通过 `createSkillReleaseSnapshot` 测算不可变 `contentHash`；
   - 存入不可变路径：`workspaces/{tenantId}/.dsh/releases/{skillId}/{version}/SKILL.md`，设置为只读。
2. **Run 级别持久 Pin**:
   - 启动 Run 时，通过 `pinSkillReleases` 锁定当前启用的单版本数组并持久化（`Run.pinnedSkills = [...]`）。
3. **隔离目录挂载**:
   - 为该 Run 实例化 `FileSystemSkillProvider` 时，`customSkillDirs` 精确指向已锁定的各技能版本目录，彻底杜绝内容漂移！
4. **Manifest 状态机与热会话撤销**:
   - 宿主 `skills-manifest.json` 维护 `active`, `disabled`, `revoked` 状态。
   - 禁用技能拦截新 Run；已有旧 Run 收到 `cancelActiveRunsForMemoryChange` / revision seam 信号清理热会话。

### 4. 依赖版本与 SHA256 清单
- `tests/probes/skill-loader-native-audit-20261101.mjs`: `fe1bee306713e2edc3fd02a50399a1820a7d1444e2c2f7922b682def5d91b447`
- `shell/skills/release-snapshot.cjs`: `257dbcb713fdf7772e41f05848da4de970c4c51a22ee1e56d5719ba3c08ef487`
- `@deepseek-ai/dsh-skill@0.1.1-rc.2`: `5402787cbc95b4586e2c3aa4b0129e91094ad368b428aa19bcbbd8553bbfa9d7`
- `@deepseek-ai/dsh-skill-filesystem@0.1.1-rc.2`: `1aea87781ba5b4d44c7cfd6184d933a1c171a3fd2791456b65ebfc8b255f1221`
- `@deepseek-ai/dsh-tool-skill@0.1.1-rc.2`: `61b911101e8dc354b279576f8f19b5bbba0ce80a2c05661d196ee66ece4b5744`
- `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.json`: 结构化证据数据
- `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.md`: 审计实证报告


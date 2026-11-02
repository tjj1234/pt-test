# PM Skill 发布与原生 Loader 接线实证审计报告

**审计日期**: 2026-11-01  
**状态**: AUDIT_COMPLETED (实证完成，确立原生真实缺口并给出最小宿主接线方案)  
**对应任务包**: `docs/refactor/GEMINI-SKILL-LOADER-AUDIT-PACKAGE-20261101.md`  
**测试探针**: `tests/probes/skill-loader-native-audit-20261101.mjs` (7/7 PASS)  
**结构化矩阵数据**: `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.json`

---

## 1. 核心结论与审计摘要

1. **复用锁定 DSH，坚决不再造 Skill 引擎**：
   - 锁定的 `@deepseek-ai/dsh-skill (0.1.1-rc.2)` 提供了极度规范的 `SkillRegistry`（`ctx.skills`）服务；
   - `@deepseek-ai/dsh-skill-filesystem (0.1.1-rc.2)` 具备完善的本地目录扫描与 frontmatter 解析能力；
   - `@deepseek-ai/dsh-tool-skill (0.1.1-rc.2)` 实现了向大模型规范注入 `<skill_content name="...">` 的完整工具与斜杠手势。
2. **确立 DSH 原生 Loader 的真实能力缺口（REAL GAP）**：
   - **缺口 1：原生缺少版本 (version) 与 contentHash 参数**：
     公开 API `ctx.skills.get(name, options)` 仅支持字符串 `name`，没有版本或哈希入参；`SkillDefinition` 不记录版本号。
   - **缺口 2：运行期存在“内容哈希漂移 (Content Hash Drift)”隐患**：
     官方 README 明确指出：“**Bodies are not versioned** — body-only edits do not change the catalog digest or notify the model; a later tool call reads the current provider content while earlier tool results remain historical facts.”
     若在会话或 Run 执行期间对磁盘上的 `SKILL.md` 进行热编辑或同名覆盖，下一次 `ctx.skills.get()` 会立即读取被修改后的正文，导致同一 Run 前后看到不一致的指令。
   - **缺口 3：原生缺乏禁用 (disabled) 与撤销 (revoked) 持久管理接口**：
     原生 loader 会将配置目录下所有合法的 `SKILL.md` 全部发现并挂载，无原生 `disableSkill(id)` API。
3. **已验证的安全边界（Security Invariants）**：
   - **SKILL.md 绝不能自授权工具权限**：探针证实，即使在 SKILL.md 中伪造 `allowedTools: ["bash", "network"]`，DSH 也仅将其当做静态文本或未知元数据，工具注册完全由宿主 `ctx.tools` 硬门禁隔离，绝无可能借此逃逸或自动激活敏感工具。
4. **提出最小宿主接线方案（无需修改 DSH 源码）**：
   - 采用**不可变版本发布目录**（`releases/{skillId}/{version}/SKILL.md`）配合已有的 `shell/skills/release-snapshot.cjs` 生成的 `contentHash` 与 `pinSkillReleases`。
   - Run 启动时锁定版本，loader 直接指向该固定版本目录，彻底消除内容漂移！

---

## 2. 原生 Loader 核心接口与能力矩阵

| 模块名称 | 锁定版本 | 核心接口 / 类 | 现有原生能力 | 真实缺口 (REAL GAP) |
|---|---|---|---|---|
| `@deepseek-ai/dsh-skill` | `0.1.1-rc.2` | `SkillRegistry` (`ctx.skills`) | 维护 provider 层次、目录合并、`list()`、`get(name)`、`snapshot()` | 无 `version` / `contentHash` 参数；不支持基于版本的精准召回 |
| `@deepseek-ai/dsh-skill-filesystem` | `0.1.1-rc.2` | `FileSystemSkillProvider` | 递归扫描目录、解析 YAML frontmatter（`name`, `description`, `whenToUse`, `invocation`） | 仅读取磁盘最新文件，无法感知换版漂移；无持久禁用门禁 |
| `@deepseek-ai/dsh-tool-skill` | `0.1.1-rc.2` | Cordis Tool Plugin (`skill`) | 向模型暴露 `skill` 工具，格式化渲染 `<skill_content>` 块 | 正文不带版本标识；模型无法辨析引用的历史版本 |
| `shell/skills/release-snapshot.cjs` | `1.0.0` | `createSkillReleaseSnapshot`<br>`pinSkillReleases` | 纯计算：生成不可变规范 `contentHash`，支持 Run 级别锁定单版本 | 仅为内存数据结构，尚未与宿主物理存储和 loader 挂载接线 |

---

## 3. 探针实证详情与执行日志

**执行命令**:
```bash
node tests/probes/skill-loader-native-audit-20261101.mjs
```

**执行结果**:
- **退出码**: 0
- **测试总数**: 7
- **通过数**: 7
- **失败数**: 0

**关键实证经过**:
1. **真实加载验证**:
   在 `os.tmpdir()` 创建无害 fixture skill (`math-helper`)，通过 `FileSystemSkillProvider` 挂载，成功调用 `ctx.skills.list()` 与 `ctx.skills.get('math-helper')`，完整获取 frontmatter 与正文。
2. **内容哈希漂移复现**:
   通过 `createSkillReleaseSnapshot` 测算初始文件哈希 `snapV1.contentHash`；修改磁盘文件后，再次调用 `ctx.skills.get('math-helper')` 立即返回被修改后的正文；生成 `snapV2.contentHash`，证实两者哈希不一致，原生 loader 无法保护活跃会话。
3. **Run Pin 锁定机制验证**:
   通过 `pinSkillReleases([snapV1])` 生成 `{ schemaVersion: 1, skills: [...] }`，成功锁定单版本并拦截同名重复锁定。
4. **不可变发布目录方案验证**:
   将 `1.0.0` 与 `2.0.0` 物理存放在独立版本子目录下，通过让 `FileSystemSkillProvider` 指向已锁定的版本目录，旧 Run 始终稳定读取 `1.0.0`，完全免疫外部修改与 `2.0.0` 发布的干扰。
5. **禁用门禁验证**:
   宿主 Manifest 标记 `status: "disabled"` 后，新 Run 准入立即被拒 (`SKILL_DISABLED`)。

---

## 4. 推荐的最小宿主接线方案 (Minimal Host Wiring Seam)

为了在不侵入、不修改锁定 `@deepseek-ai` 依赖源码的前提下实现企业级 Skill 发布与版本治理，建议采用如下接线方案：

```
workspaces/{tenantId}/.dsh/
├── skills-manifest.json                # 宿主集中式技能清单与状态机
└── releases/                           # 不可变发布版本存储根
    ├── math-helper/
    │   ├── 1.0.0/
    │   │   └── SKILL.md                # 不可变（只读挂载）
    │   └── 2.0.0/
    │       └── SKILL.md                # 不可变（只读挂载）
```

### 4.1 发布契约 (Publication Contract)
1. **发布动作**:
   - 接收待发布的技能文件集合；
   - 调用 `createSkillReleaseSnapshot({ skillId, version, files })` 生成不可变规范 `contentHash`；
   - 将文件写入不可变目录 `releases/{skillId}/{version}/`（权限设为只读，禁止二次修改）；
   - 更新 `skills-manifest.json`，登记 `{ activeVersion, contentHash, status: "active" }`。

### 4.2 Run 持久锁定契约 (Run Pinning Contract)
1. **Run 启动准入**:
   - 查询 `skills-manifest.json`，过滤掉 `disabled` 或 `revoked` 的技能；
   - 对允许使用的技能，调用 `pinSkillReleases` 生成 `pinnedSkills` 数组；
   - 持久化至 Run 记录中（`Run.pinnedSkills = [...]`）。
2. **原生 Loader 挂载接线**:
   - 实例化 `FileSystemSkillProvider` 时，`customSkillDirs` 不指向开发草稿根目录，而是指向当前 Run 所锁定的各技能版本目录（如 `releases/math-helper/1.0.0`）；
   - DSH 原生 loader 依然按原生逻辑发现 `name: math-helper`，但读取到的物理文件被物理隔离在 `1.0.0` 目录下，彻底免疫内容漂移！

### 4.3 禁用与热会话撤销接缝 (Revocation Seam)
- 管理员禁用技能时，`skills-manifest.json` 将其状态改为 `disabled`；
- 新 Run 启动时前置拒绝准入；
- 宿主通过既有的 `cancelActiveRunsForMemoryChange` / revision 接缝向正在执行的关联活跃 Run 发出清理与取消信号。

---

## 5. 文件与依赖版本 SHA256 清单

| 文件 / 依赖模块 | 声明版本 | SHA256 校验和 | 角色说明 |
|---|---|---|---|
| `tests/probes/skill-loader-native-audit-20261101.mjs` | - | `fe1bee306713e2edc3fd02a50399a1820a7d1444e2c2f7922b682def5d91b447` | 技能加载与版本漂移审计探针 |
| `shell/skills/release-snapshot.cjs` | `1.0.0` | `257dbcb713fdf7772e41f05848da4de970c4c51a22ee1e56d5719ba3c08ef487` | 宿主技能发布快照与 Run Pin 辅助模块 |
| `@deepseek-ai/dsh-skill` | `0.1.1-rc.2` | `5402787cbc95b4586e2c3aa4b0129e91094ad368b428aa19bcbbd8553bbfa9d7` | 锁定 DSH 技能注册表服务 |
| `@deepseek-ai/dsh-skill-filesystem` | `0.1.1-rc.2` | `1aea87781ba5b4d44c7cfd6184d933a1c171a3fd2791456b65ebfc8b255f1221` | 锁定 DSH 文件系统技能扫描加载器 |
| `@deepseek-ai/dsh-tool-skill` | `0.1.1-rc.2` | `61b911101e8dc354b279576f8f19b5bbba0ce80a2c05661d196ee66ece4b5744` | 锁定 DSH 模型技能工具与斜杠手势插件 |
| `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.json` | - | 对应结构化证据数据文件 |
| `docs/refactor/evidence/GEMINI-SKILL-LOADER-AUDIT-20261101.md` | - | 本审计实证报告文件 |

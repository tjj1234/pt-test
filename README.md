# 北极星 · 社媒增长 Agent 平台

一个**多租户**的社媒增长 Agent 平台，把「AI 对话能力（DSH）」和「归因数据看板」拼在一起，团队每个人各用各的账号、各绑各的 PT key（BYOK），数据互相隔离。

## ① 这是什么

整个平台是**两个进程、两个目录**：

| 目录 | 是什么 | 默认端口 | 干什么 |
|------|--------|----------|--------|
| `shell/` | 业务壳（对外唯一入口） | **8098** | 登录 / 注册 / 设置 / 对话 / 存 PT key，把 `/dashboard`、`/api/analytics` 反代到看板后端 |
| `analytics/` | 看板后端 | **8095** | 归因数据 API + 看板前端（PGlite 真库，自带演示种子数据） |

用户只跟 `shell` 说话，永远碰不到 DSH 本身，也看不到看板后端的 8095 端口（藏在 `/dashboard` 后面）。

架构上每个**账号 = 一个租户 = 一把 PT key = 一个独立工作区**，DSH 不开任何对外端口。

## ② 前置要求

- **Node.js ≥ 18**（推荐 18.19+ 或 20.6+，可少记几条命令）
- **DSH 已安装**，并知道它的 `bin.js` 路径（`@deepseek-ai/dsh/lib/bin.js`）

> DSH 装好后，把它的 `bin.js` 绝对路径填到 `.env` 的 `DSH_JS` 里；不填的话程序也会自动去 `node_modules` / 全局 npm root 里找，找不到会打印清晰的中文报错。

## ③ 安装（两个目录分别装）

```bash
cd analytics
npm install

cd ../shell
npm install
```

> `node_modules` 已加入 `.gitignore`，不会提交；每个人拉下来都要自己装一次。

## ④ 配置（复制 .env.example → .env）

```bash
cp .env.example .env        # Mac / Linux
copy .env.example .env      # Windows
```

打开 `.env`，**最少只填一项**：`DSH_JS`（DSH 的 bin.js 绝对路径）。其余都有安全默认值。

`.env` 怎么生效（三选一）：

1. **Mac / Linux**：`set -a; source .env; set +a`（在启动的终端里执行一次）
2. **Windows PowerShell**：手动 `$env:DSH_JS="C:\...\bin.js"` 设变量
3. **Node 自带**（18.19+ / 20.6+）：`cd shell && node --env-file=../.env server.cjs`

> 关键变量清单见 `.env.example`（每个都有中文注释）：端口、`PT_DB_DIR`、`PT_MASTER_KEY_FILE`、`PT_DASH_TOKEN`（看板只读 token，两端要一致）、管理密码 `PT_SHELL_PASSWORD`、`PT_KEY_VERIFY_BASEURL`、`PT_KEY_LIVE_VERIFY`、`TRUST_PROXY`、`PT_DASH_TENANT_INJECT`、`PT_CHAT_DRYRUN` 等。

## ⑤ 启动（先起看板，再起业务壳）

**第 1 步：起看板后端**（新开一个终端）

```bash
cd analytics
node start.cjs            # 或 npm start
```

看到 `✅ 已启动` 和 `http://127.0.0.1:8095/...` 就成功了（会自动建库、灌演示数据、跑一轮自检）。

**第 2 步：起业务壳**（再开一个终端）

```bash
cd shell
node server.cjs           # 或 npm start
```

看到「北极星 · 业务壳」横幅和 `http://127.0.0.1:8098` 就成功了。

- 业务壳：`http://127.0.0.1:8098`（探活 `/healthz`）
- 看板后端：藏在 `http://127.0.0.1:8098/dashboard` 后面

## ⑥ 首次使用（注册 → 登录 → 设置 → 绑 key）

1. 浏览器打开 `http://127.0.0.1:8098`
2. 没登录会跳到 `/login`，点「注册」建一个你自己的账号（密码至少 8 位）
3. 注册成功后自动登录，并跳转到 `/settings`（设置页）
4. 在设置页粘贴你的 **PT key**，点「保存绑定」——保存前会做一次有效性校验，通过后才加密落库（只回显末 4 位）
5. 回到 `/` 主界面，就能开始对话了；侧栏「📊 归因看板」就是看板

> 没绑 key 之前对话会被友好拦截（提示先去绑定），不会报「执行失败」。

## ⑦ Windows / Mac / Linux 差异说明

只有一处平台差异：**master key 的保护方式**（它是加密你 PT key 的主密钥）。

| 平台 | 保护方式 |
|------|----------|
| **Windows** | 用系统 DPAPI（当前用户作用域）加密后落盘，磁盘上**没有明文** |
| **Mac / Linux** | 生成 32 字节随机 key 写到 `secrets/master.key`，靠**文件权限 0600** 保护；启动日志会打一条中文警告 |

两条铁律对所有平台一致：

- `secrets/`、`db/`、`logs/` 都已加入 `.gitignore`，**不要手动 `git add` 它们**
- 尤其 Mac/Linux 的 `secrets/master.key` —— **绝不要提交或分享这个文件**

## ⑧ 常见问题

**Q1：报「找不到 DSH 的 JS 入口」怎么办？**
说明 `DSH_JS` 没设对、或自动发现也没找到。二选一：
1. 把 `DSH_JS` 设为 bin.js 的绝对路径（`.env` 里填，或 `$env:DSH_JS=...`）
2. 重装 dsh：`npm install -g @deepseek-ai/dsh`，装好后重启

**Q2：看板连不上 / 主界面显示「看板 离线」？**
看板后端（`analytics`）没起来。先 `cd analytics && node start.cjs`，再起业务壳；顺序反了没关系，看板起来后业务壳会自动探活到它。

**Q3：登录/注册提示「请求过于频繁」或被锁定？**
这是防爆破/限流在起作用（登录默认 10 次/分，连续失败 5 次锁定 10 分钟）。等一会儿再试，或让管理员用环境变量 `PT_BF_*`、`PT_RATE_*` 调阈值。

**Q4：改了 `PT_DASH_TOKEN` 后看板打不开？**
看板后端把 token 灌进了数据库（灌种时）。改完 token 后，到 `analytics` 目录加 `--reseed` 重新灌数据：`node start.cjs --reseed`。

**Q5：对话一直失败、退出码非 0？**
多半是 DSH 没找到（见 Q1）或 PT key 没绑（见 ⑥）。`/api/chat` 报错里会带退出码和原因。

---

## 团队拉下来后最小跑通步骤（TL;DR）

```bash
# 1. 拉代码
git clone <你的仓库> && cd pt-test

# 2. 装依赖
cd analytics && npm install && cd ../shell && npm install && cd ..

# 3. 配置（只填 DSH_JS 这一项即可）
cp .env.example .env
# 编辑 .env：DSH_JS=<你的 DSH bin.js 绝对路径>

# 4. 终端 A：起看板
cd analytics && node start.cjs

# 5. 终端 B：起业务壳（先加载 .env）
cd shell && node --env-file=../.env server.cjs    # 或 set -a; source ../.env; set +a 后再 node server.cjs

# 6. 浏览器打开 http://127.0.0.1:8098 → 注册 → 绑 key → 对话
```

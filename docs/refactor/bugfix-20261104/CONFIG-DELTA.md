# 运维环境配置差异单 (CONFIG-DELTA)

**版本**：v1.0｜2026-11-04  
**接收人**：Codex 主程序 / 运维负责人  
**范围**：r28 线上环境与补丁集成生效所需的外部配置项说明（绝不含敏感明文）。

---

## 一、 必需配置项差异清单

| 配置项名称 | 代码读取位置 | 适用服务 / 环境 | 是否必需 | 缺失/错误行为 | 运维操作与生效方法 |
|---|---|---|---|---|---|
| **`PT_DASH_INTERNAL_KEY`** | `shell/server.cjs:1995` | `northstar-shell` (FAT / 生产) | **必需** (若启用广告归因) | 缺失时系统无法代理签发只读看板令牌，导致 Bug-02, 06, 11, 15（403 invalid token / 502） | 在环境配置（如 `/etc/northstar/northstar.env`）中注入由看板系统签发的内部共享密钥，执行 `sudo systemctl restart northstar-shell`。 |
| **`PT_MEDIA_ASSET_HOSTS`** | `shell/server.cjs:2864` | `northstar-shell` (FAT / 生产) | **必需** (若启用受控媒体) | 缺失时抓取视频/图片落地被白名单拦截（`HOST_NOT_ALLOWED`），视频无法落盘 | 参见下文非敏感示例，追加 Cloudflare R2 / 火山引擎等官方资产 CDN 域名。 |
| **`PT_CONTROLLED_MEDIA_AUTHORIZATION`** | `shell/server.cjs:2866` | `northstar-shell` (FAT / 生产) | 可选 (默认 `1`) | 设为 `1` 启用媒体二阶段确认（防误消耗）。若设为 `1` 但未配 `PT_MEDIA_ASSET_HOSTS`，启动时会有保护性告警 | 建议保持 `1`，确保大额媒体生成需用户二次确认。 |

---

## 二、 非敏感示例说明

### 1. `PT_MEDIA_ASSET_HOSTS` 官方受信任域名清单
此环境变量用于安全抓取远端模型（如 Seedream、Wan2.7）生成的静态资源：
```bash
# 格式为英文逗号分隔的合法域名，绝不包含通配符或协议头
PT_MEDIA_ASSET_HOSTS="ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com,pub-ee388a8463c1497c8b4f503044a80ee1.r2.dev,pub-425ca9cea13d454a907692a0a9f80079.r2.dev"
```

### 2. `PT_DASH_INTERNAL_KEY` 说明
- **安全属性**：明文秘钥仅进内存，绝不记录日志、绝不落盘、绝不回传前端。
- **作用**：供 `server.cjs` 的内部代理在访问 `http://127.0.0.1:8099/dashboard/` 时计算租户隔离的 HMAC 鉴权签名。

---

## 三、 Nginx 反向代理配置核对 (针对 Bug-10)

`shell/server.cjs` 已将服务自身下发的 CSP 修改为：
```http
Content-Security-Policy: frame-ancestors 'self';
```
**运维核对要点**：
请检查前端反代 Nginx（如 `/etc/nginx/sites-enabled/agent-fat.conf`）是否在反代配置中强行插入了：
```nginx
# 需确认不存在如下硬编码指令（若有需删除）：
# add_header Content-Security-Policy "frame-ancestors 'none'" always;
# add_header X-Frame-Options "DENY" always;
```
如果 Nginx 层额外插入了 `'none'` 或 `DENY`，浏览器会取最严格策略导致 iframe 依然被拦截。若需防止第三方点击劫持，保持 `add_header X-Frame-Options "SAMEORIGIN"` 即可。

---

## 四、 验证与回退方案

- **验证方法**：
  1. 启动服务后执行探活：`curl -I http://127.0.0.1:8098/api/health` 检查无崩溃。
  2. 测试视频下载：发起一次文生视频，检查落盘文件在 `runtime/workspaces/<tenantId>/media-results/` 正常生成，无 `HOST_NOT_ALLOWED` 日志。
  3. 测试归因状态：进入业务流库，状态显示“未启用/已启用”，无 502/403 弹窗。
- **回退方式**：
  若追加变量后发生任何启动阻断，从 `.env` 中移除对应行，重启服务即可恢复旧行为。

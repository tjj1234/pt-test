/**
 * 交付版 · 种子数据
 * ============================================================================
 * 目标：让**真库 + 真 SQL** 跑出可看的数字 —— 不是编数字，是喂真实形状的事件，
 *       让后端的归因 SQL 自己去算。
 *
 * 覆盖的场景（每个都对应一个真实业务缺陷）：
 *   · 正常素材          → 有花费有充值 → ROI 算得出来
 *   · 有花费无充值      → ROI = 0（该停的素材）
 *   · 重名素材 ×2       → SQL 的 cnt=2 → 「无法唯一归因」→ roi = null（必须沉底）
 *   · 有充值但没匹配实体 → SQL 的 cnt=0 → 「未命中」→ roi = null（必须沉底）
 *   · 打点质量          → 42 条审计日志，含 2 条 event_id 问题 + 3 条来源未知
 *
 * 关键 JOIN 关系（与 funnel.ts buildRoiSql 严格一致）：
 *   pt_events(utm_content) ←→ ad_performance_daily(entity_id / ad_creatives.name)
 *   且必须**同一天**（a.date = b.attr_date）—— 所以种子按天对齐。
 * ============================================================================
 */
"use strict";

const crypto = require("node:crypto");
const { insertAuditLogs, insertConfigFindings, insertAnalyticsToken, insertWebhookEndpoint } =
  require("./deps.cjs");

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// 确定性伪随机（种子固定 → 每次生成同样的数据，便于复现问题）
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性 UUID（同样输入 → 同样 UUID，保证幂等重跑不炸主键）。 */
function detUuid(kind, n) {
  const h = crypto.createHash("sha256").update(`${kind}:${n}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function utcDayStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------
// 场景定义（utm_source / utm_campaign / utm_content / 国家 / 权重）
// ---------------------------------------------------------------------------
const COMBOS = [
  { source: "meta",   campaign: "pt-launch-us",       content: "video_hook_15s",      country: "US", weight: 1.35, w: 1.0 },
  { source: "meta",   campaign: "pt-launch-us",       content: "video_testimonial",   country: "US", weight: 1.15, w: 0.9 },
  { source: "google", campaign: "pt-retarget-global", content: "img_price_card",      country: "US", weight: 0.95, w: 0.8 },
  { source: "google", campaign: "pt-retarget-global", content: "carousel_features",   country: "DE", weight: 0.80, w: 0.0 }, // 有花费无充值
  { source: "x",      campaign: "pt-brand",           content: "img_brand_awareness", country: "JP", weight: 0.55, w: 0.0 }, // 有花费无充值
  { source: "meta",   campaign: "pt-brand",           content: "img_price_card",      country: "JP", weight: 0.60, w: 0.5 }, // ★ 重名 → 无法唯一归因
  { source: "x",      campaign: "pt-launch-us",       content: "orphan_creative_zz",  country: "SG", weight: 0.35, w: 0.5 }, // ★ 无广告实体 → 未命中
];

/** 广告实体：把素材建成 ad_creatives（name = utm_content，JOIN 靠它）
 *  ★ 注意：ad_* 五表的 platform 有 CHECK 约束，**只允许 meta / google**。
 *    前端筛选栏里的「X Ads」在库层面无处安放 —— 这是已记录的真实缺陷。 */
const CREATIVE_DEFS = [
  { key: "video_hook_15s",      id: "cr_1001", platform: "meta",   account: "act_8812301", campaignId: "c_2001", spendPerDay: 627 },
  { key: "video_testimonial",   id: "cr_1002", platform: "meta",   account: "act_8812301", campaignId: "c_2001", spendPerDay: 443 },
  { key: "img_price_card",      id: "cr_1003", platform: "google", account: "act_5520907", campaignId: "c_2002", spendPerDay: 442 },
  { key: "carousel_features",   id: "cr_1004", platform: "google", account: "act_5520907", campaignId: "c_2002", spendPerDay: 302 },
  { key: "img_brand_awareness", id: "cr_1005", platform: "google", account: "act_5520908", campaignId: "c_2003", spendPerDay: 137 },
  // ★ 故意重名：与 cr_1003 同名 → SQL 应数出 cnt=2 → 无法唯一归因（roi=null）
  //   注意：必须**也给花费**才会真正发生碰撞 —— JOIN 要求 ad_performance_daily 里有行，
  //   第一版没给花费，结果重名场景静默失效（被真库实测抓出来）。
  { key: "img_price_card",      id: "cr_1006", platform: "meta",   account: "act_8812301", campaignId: "c_2003", spendPerDay: 213 },
];

// ===========================================================================
// 主流程
// ===========================================================================

async function seed(pool, opts = {}) {
  const log = opts.log || (() => {});
  const scale = opts.scale || 1;          // 1 = 每组合每天约 30 次访问
  const days = opts.days || 30;

  const TENANT_ID = opts.tenantId || "11111111-1111-1111-1111-111111111111";
  const WORKSPACE_ID = opts.workspaceId || "ws_powertokens_main";
  const RO_TOKEN = opts.readToken || "pt_ro_delivery_9f3c21";
  const WEBHOOK_ID = opts.webhookId || "wh_powertokens_001";
  const WEBHOOK_SECRET = opts.webhookSecret || "whsec_delivery_a71b4e";

  const todayStart = utcDayStart(Date.now());
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(todayStart - i * DAY_MS);

  const rnd = mulberry32(20260911);

  // -------------------------------------------------------------------------
  // 1. 租户 ↔ 工作区映射
  // -------------------------------------------------------------------------
  await pool.query(
    `INSERT INTO tenant_workspaces (tenant_id, workspace_id, label)
     VALUES ($1::uuid,$2,$3) ON CONFLICT (tenant_id) DO NOTHING`,
    [TENANT_ID, WORKSPACE_ID, "PowerTokens 主工作区"]
  );
  log("  租户 ↔ 工作区映射已建立");

  // -------------------------------------------------------------------------
  // 2. 鉴权：只读 token + webhook 端点（只存哈希）
  // -------------------------------------------------------------------------
  await insertAnalyticsToken(pool, TENANT_ID, RO_TOKEN, "看板只读 token", ["analytics:read"]);
  await insertAnalyticsToken(pool, TENANT_ID, "pt_ro_revoked_000000", "已吊销（用于验证 403）", ["analytics:read"]);
  await pool.query(
    `UPDATE analytics_tokens SET status='revoked' WHERE token_hash=$1`,
    [crypto.createHash("sha256").update("pt_ro_revoked_000000").digest("hex")]
  );
  await insertWebhookEndpoint(pool, TENANT_ID, WEBHOOK_ID, WEBHOOK_SECRET, "打点接入端点");
  log("  只读 token + webhook 端点已写入（只存 SHA-256 哈希）");

  // -------------------------------------------------------------------------
  // 3. 广告侧：账户 / 系列 / 素材 / 每日指标
  // -------------------------------------------------------------------------
  const accounts = [
    { platform: "meta",   account: "act_8812301", name: "Meta 主账户",     currency: "USD", tz: "America/New_York" },
    { platform: "google", account: "act_5520907", name: "Google 主账户",   currency: "USD", tz: "America/Los_Angeles" },
    { platform: "google", account: "act_5520908", name: "Google 品牌账户", currency: "USD", tz: "America/Los_Angeles" },
  ];
  for (const a of accounts) {
    await pool.query(
      `INSERT INTO ad_accounts (workspace_id, platform, account_id, name, currency, timezone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') ON CONFLICT DO NOTHING`,
      [WORKSPACE_ID, a.platform, a.account, a.name, a.currency, a.tz]
    );
  }
  const campaigns = [
    { platform: "meta",   account: "act_8812301", id: "c_2001", name: "pt-launch-us",       objective: "CONVERSIONS" },
    { platform: "google", account: "act_5520907", id: "c_2002", name: "pt-retarget-global", objective: "SEARCH" },
    { platform: "google", account: "act_5520908", id: "c_2003", name: "pt-brand",           objective: "DISPLAY" },
  ];
  for (const c of campaigns) {
    await pool.query(
      `INSERT INTO ad_campaigns (workspace_id, platform, account_id, campaign_id, name, status, objective)
       VALUES ($1,$2,$3,$4,$5,'active',$6) ON CONFLICT DO NOTHING`,
      [WORKSPACE_ID, c.platform, c.account, c.id, c.name, c.objective]
    );
  }
  for (const cr of CREATIVE_DEFS) {
    await pool.query(
      `INSERT INTO ad_creatives (workspace_id, platform, account_id, creative_id, campaign_id, name, title, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT DO NOTHING`,
      [WORKSPACE_ID, cr.platform, cr.account, cr.id, cr.campaignId, cr.key, cr.key]
    );
  }
  log(`  广告侧已写入：${accounts.length} 账户 / ${campaigns.length} 系列 / ${CREATIVE_DEFS.length} 素材`);

  // 每日指标：每个素材每天一行（level=creative）
  let perfRows = 0;
  for (const cr of CREATIVE_DEFS) {
    if (cr.spendPerDay === null) continue; // 重名那个素材故意不给花费
    for (const dayStart of dayList) {
      // 花费有日波动，但只用确定性伪随机
      const wave = 1 + 0.25 * Math.sin((dayStart / DAY_MS + cr.id.length) / 2.3);
      const spend = Math.round(cr.spendPerDay * wave * 100) / 100;
      await pool.query(
        `INSERT INTO ad_performance_daily
           (workspace_id, platform, account_id, entity_id, level, date, spend, impressions, clicks,
            conversions, currency, amount_usd, fx_rate, fx_date, roas, data_source)
         VALUES ($1,$2,$3,$4,'creative',$5::date,$6,$7,$8,$9,'USD',$10,1,$5::date,$11,'seed')
         ON CONFLICT DO NOTHING`,
        [
          WORKSPACE_ID, cr.platform, cr.account, cr.id, new Date(dayStart).toISOString().slice(0, 10),
          spend, Math.round(spend * 42), Math.round(spend * 1.1), Math.round(spend / 55),
          spend, Math.round((spend * 1.6) * 100) / 100,
        ]
      );
      perfRows++;
    }
  }
  log(`  广告每日指标已写入：${perfRows} 行（30 天 × 有花费的素材）`);

  // -------------------------------------------------------------------------
  // 4. 行为侧：pt_events（首触归因口径 + 6 白名单事件）
  // -------------------------------------------------------------------------
  const MODELS = ["gpt-4o-mini", "claude-3-5-sonnet", "deepseek-v3", "gemini-1.5-pro"];
  const now = Date.now();
  let n = 0;
  let counts = { visit: 0, signup: 0, key_created: 0, model_call: 0, recharge: 0 };

  for (const dayStart of dayList) {
    // 当天事件时间戳落在这一天之内
    const dayEnd = Math.min(dayStart + DAY_MS - 1, now);
    for (const combo of COMBOS) {
      const visitors = Math.max(6, Math.round(28 * combo.weight * scale));
      for (let v = 0; v < visitors; v++) {
        n += 1;
        const visitorId = "vis_" + n.toString(36);
        const userId = "usr_" + n.toString(36);
        // 事件时间戳（同一访问者的事件递进）
        const base = dayStart + Math.floor((v / visitors) * (dayEnd - dayStart));
        const src = combo.source === "google" ? "google" : combo.source === "meta" ? "facebook" : "x";

        const rows = [];
        rows.push({
          name: "visit", ts: base, visitor: visitorId, user: null,
          path: "/pricing", dwell: 1200 + Math.floor(rnd() * 5000),
        });

        const signupP = 0.18 + rnd() * 0.12;
        if (rnd() < signupP) {
          rows.push({
            name: "signup", ts: base + 60000, visitor: visitorId, user: userId,
            method: rnd() < 0.7 ? "email" : "google_oauth",
          });
          if (rnd() < 0.62) {
            rows.push({
              name: "key_created", ts: base + 120000, visitor: visitorId, user: userId,
              keyPrefix: ("sk-pt-" + n.toString(36)).slice(0, 8),
              keyHash: crypto.createHash("sha256").update("key" + n).digest("hex"),
              keyType: "private",
            });
            const calls = 2 + Math.floor(rnd() * 8);
            for (let c = 0; c < calls; c++) {
              const model = MODELS[Math.floor(rnd() * MODELS.length)];
              const lat = 280 + Math.floor(rnd() * 700);
              rows.push({
                name: "model_call", ts: base + 180000 + c * 30000, visitor: visitorId, user: userId,
                model, source: rnd() < 0.5 ? "playground" : "api",
                latency: lat, success: rnd() < 0.98,
                tokens: 300 + Math.floor(rnd() * 2000),
                cost: Math.round((0.001 + rnd() * 0.02) * 1e8) / 1e8,
                keyPrefix: ("sk-pt-" + n.toString(36)).slice(0, 8),
                keyHash: crypto.createHash("sha256").update("key" + n).digest("hex"),
              });
            }
            // 充值：由 combo.w 控制该素材的「充值倾向」
            if (combo.w > 0 && rnd() < 0.22 * combo.w * 2) {
              const ticket = [39, 99, 199, 299][Math.floor(rnd() * 4)];
              rows.push({
                name: "recharge", ts: base + 600000, visitor: visitorId, user: userId,
                rechargeId: "rch_" + n.toString(36),
                amount: ticket, currency: "USD", method: "card", status: "success",
              });
            }
          }
        }

        for (const r of rows) {
          counts[r.name] += 1;
          await insertEvent(pool, TENANT_ID, {
            eventId: detUuid("ev", n * 100 + rows.indexOf(r)),
            name: r.name, ts: r.ts, visitor: r.visitor, user: r.user,
            utmSource: combo.source, utmMedium: "cpc",
            utmCampaign: combo.campaign, utmContent: combo.content,
            utmTerm: null, country: combo.country,
            gclid: combo.source === "google" ? "gcl_" + n : null,
            fbclid: combo.source === "meta" ? "fbl_" + n : null,
            userAgent: "Mozilla/5.0 (seed)", deviceType: "desktop",
            os: "Windows", browser: "Chrome",
            pageUrl: "https://app.powertokens.ai" + (r.path || "/"),
            referrer: combo.source,
            pagePath: r.path || null, pageTitle: r.path ? "PowerTokens" : null,
            sessionId: "ses_" + n,
            dwellTimeMs: r.dwell || null,
            registrationMethod: r.method || null, emailVerified: r.method ? true : null,
            keyIdPrefix: r.keyPrefix || null, keyIdHash: r.keyHash || null,
            createPage: r.name === "key_created" ? "/keys" : null,
            keyType: r.keyType || null,
            model: r.model || null, source: r.source || null, caller: null,
            requestTime: r.ts, responseTime: r.ts + (r.latency || 0),
            latencyMs: r.latency || null, success: r.success ?? null,
            httpStatus: null, errorCode: null, requestId: null, responseId: null,
            provider: null, endpoint: null,
            promptTokens: r.tokens ? Math.round(r.tokens * 0.6) : null,
            completionTokens: r.tokens ? Math.round(r.tokens * 0.4) : null,
            totalTokens: r.tokens || null, cost: r.cost || null,
            rechargeId: r.rechargeId || null, amount: r.amount || null,
            currency: r.currency || null, paymentMethod: r.method || null,
            status: r.status || null, enabled: null,
          });
        }
      }
    }
  }
  log(
    `  行为事件已写入：visit ${counts.visit} / signup ${counts.signup} / ` +
      `key_created ${counts.key_created} / model_call ${counts.model_call} / recharge ${counts.recharge}`
  );

  // -------------------------------------------------------------------------
  // 5. 审计数据源：SS-GTM 日志（时间落「昨日」，对齐默认审计窗）+ GTM 配置发现
  // -------------------------------------------------------------------------
  const auditLogs = buildAuditLogs(todayStart, TENANT_ID);
  await insertAuditLogs(pool, TENANT_ID, auditLogs);
  await insertConfigFindings(pool, TENANT_ID, [
    {
      check: "MP api_secret 是否出现在前端可见的 GTM 标签里",
      detail: "未发现 api_secret 出现在浏览器可读标签中（交付版种子数据）。",
      severity: "low",
    },
    {
      check: "GA4 transport 是否被用于三事件",
      detail: "未发现三事件走 GA4 浏览器通道；transport 以 Measurement Protocol 为主。",
      severity: "low",
    },
  ]);
  log(`  审计侧已写入：${auditLogs.length} 条 SS-GTM 日志 + 2 条配置发现`);

  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    readToken: RO_TOKEN,
    webhookId: WEBHOOK_ID,
    webhookSecret: WEBHOOK_SECRET,
    counts,
  };
}

// ---------------------------------------------------------------------------
// pt_events 单条插入（事务 + set_config 双保险，与 ingest 同款写法）
// ---------------------------------------------------------------------------
async function insertEvent(pool, tenantId, e) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO pt_events (
         tenant_id, event_id, event_name, timestamp, visitor_id, user_id,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         gclid, fbclid, country, user_agent, device_type, os, browser,
         page_url, referrer, page_path, page_title, session_id, dwell_time_ms,
         registration_method, email_verified,
         key_id_prefix, key_id_hash, create_page, key_type,
         model, source, caller, request_time, response_time, latency_ms, success,
         http_status, error_code, request_id, response_id, provider, endpoint,
         prompt_tokens, completion_tokens, total_tokens, cost,
         recharge_id, amount, currency, payment_method, status, enabled
       ) VALUES (
         $1::uuid,$2::uuid,$3,$4::bigint,$5,$6,
         $7,$8,$9,$10,$11,
         $12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24::bigint,
         $25,$26,
         $27,$28,$29,$30,
         $31,$32,$33,$34::bigint,$35::bigint,$36::bigint,$37,
         $38,$39,$40,$41,$42,$43,
         $44::bigint,$45::bigint,$46::bigint,$47,
         $48,$49,$50,$51,$52,$53
       ) ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        tenantId, e.eventId, e.name, String(e.ts), e.visitor, e.user,
        e.utmSource, e.utmMedium, e.utmCampaign, e.utmTerm, e.utmContent,
        e.gclid, e.fbclid, e.country, e.userAgent, e.deviceType, e.os, e.browser,
        e.pageUrl, e.referrer, e.pagePath, e.pageTitle, e.sessionId,
        e.dwellTimeMs === null ? null : String(e.dwellTimeMs),
        e.registrationMethod, e.emailVerified,
        e.keyIdPrefix, e.keyIdHash, e.createPage, e.keyType,
        e.model, e.source, e.caller,
        e.requestTime === null ? null : String(e.requestTime),
        e.responseTime === null ? null : String(e.responseTime),
        e.latencyMs === null ? null : String(e.latencyMs),
        e.success,
        e.httpStatus, e.errorCode, e.requestId, e.responseId, e.provider, e.endpoint,
        e.promptTokens === null ? null : String(e.promptTokens),
        e.completionTokens === null ? null : String(e.completionTokens),
        e.totalTokens === null ? null : String(e.totalTokens),
        e.cost,
        e.rechargeId, e.amount, e.currency, e.paymentMethod, e.status, e.enabled,
      ]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 审计日志：37 服务端 / 3 来源未知 / 2 条 event_id 有问题 → 评分约为「健康」
// 时间必须落在昨日（默认审计窗 = 最近一个完整自然日 UTC）
// ---------------------------------------------------------------------------
function buildAuditLogs(todayStart, tenantId) {
  const base = todayStart - DAY_MS + 9 * 3600000; // 昨日 09:00 UTC
  const events = ["credit_purchase", "balance_recharge", "token_consume"];
  const logs = [];
  for (let i = 0; i < 37; i++) {
    logs.push({
      event_name: events[i % 3],
      event_id: detUuid("gtm", 1000 + i),
      timestamp: base - i * 60000,
      transport: i % 5 === 0 ? "custom" : "Measurement Protocol",
      user_agent: "python-requests/2.31.0",
      tenant_id: tenantId,
    });
  }
  for (let i = 0; i < 3; i++) {
    logs.push({
      event_name: events[i % 3],
      event_id: detUuid("gtm", 2000 + i),
      timestamp: base - (i + 40) * 60000,
      tenant_id: tenantId,
    });
  }
  logs.push({
    event_name: "token_consume",
    timestamp: base - 50 * 60000,
    transport: "Measurement Protocol",
    tenant_id: tenantId,
  });
  logs.push({
    event_name: "credit_purchase",
    event_id: "not-a-uuid",
    timestamp: base - 51 * 60000,
    transport: "Measurement Protocol",
    tenant_id: tenantId,
  });
  return logs;
}

module.exports = { seed, COMBOS, CREATIVE_DEFS };

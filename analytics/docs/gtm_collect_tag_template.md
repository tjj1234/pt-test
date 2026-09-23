# GTM Server 标签配置清单（→ collect 接口）

目标接口：`POST https://pt-test.skyjilygao.cn/api/v1/collect/wh_powertokens_001`

> 这是 sGTM 里一个 **HTTP 请求** 类型的标签。下面两部分（Headers / Body）照抄即可；
> 变量名按你容器里真实存在的变量名调整（见文末「变量映射提示」）。

---

## 1. 基本信息
| 项 | 值 |
|---|---|
| 标签类型 | HTTP 请求（HTTP Request / Custom Tag） |
| 方法 | `POST` |
| 网址 | `https://pt-test.skyjilygao.cn/api/v1/collect/wh_powertokens_001` |
| 触发条件 | 需要上报的事件（如 `All Pages` / 自定义 `event` / 你已有的触发器） |

---

## 2. Headers（请求标头）—— 只放这两个

| Key | Value | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 固定值 |
| `x-pt-webhook-secret` | `b376a8359e51cd4d5d3f1808f5df04d51a123fa76379642ce20725a5b5365d58` | **原始 secret（不是 sha256 哈希！也不是拼接表达式）** |

⚠️ 常见坑（已踩过）：
- 不要填 `7263ea80...` 那种哈希值——服务端会再算一次 sha256，等于双重哈希 → 403。
- 不要写 `"7263ea80..." + "060d08"` 这类拼接——发出去的值就错了。
- 这个 secret 就是 `.env` 里的 `PT_DASH_WEBHOOK_SECRET`，原样粘贴即可。

---

## 3. Body（请求正文）—— 必须有，且字段有硬性约束

把数据放在 **Body** 里（不要放 Headers，服务端只读 body）。模板：

```json
{
  "event_id": "{{Event Data.event_id}}",
  "event_name": "{{Event Data.event_name}}",
  "timestamp": "{{Event Data.timestamp}}",
  "client_id": "{{Event Data.client_id}}",
  "user_id": "{{Event Data.user_id}}",
  "trigger_from": "{{Event Data.trigger_from}}",
  "utm_source": "{{Event Data.utm_source}}",
  "utm_campaign": "{{Event Data.utm_campaign}}"
}
```

### ⛔ 服务端三件套硬性校验（不满足 → 400）
| 字段 | 约束 | 说明 |
|---|---|---|
| `event_id` | **必须是纯 UUID**（8-4-4-4-12 十六进制） | `playground_submit_126fc008-...` 这种带前缀的**不合格**，前缀部分要拆出去（比如放 `event_name` 或自定义字段），body 里只留纯 UUID `126fc008-e3a1-46ae-9904-6a2d33158cb8` |
| `event_name` | **必须在白名单内**：`visit` / `signup` / `key_created` / `model_call` / `recharge` / `auto_recharge_toggle` | `playground_submit` 不在名单里 → 400。要么加白名单（改 `analytics/backend/collect/validate.js` 的 `EVENT_WHITELIST`），要么在 GTM 里映射成相近的白名单事件 |
| `timestamp` | int64 毫秒时间戳（非负整数） | 如 `1758500000000` |

### ⚠️ Body 不能为空
只要 `Content-Type: application/json` 且 body 为空，服务端直接 400（`FST_ERR_CTP_EMPTY_JSON_BODY`）。
**数据全放 Headers、Body 留空 = 必挂**，这就是「请求头里带 client_id/event_id 但失败」的原因。

> sGTM 的 `{{Event Data.xxx}}` 取的是「入站事件里叫 xxx 的字段」。
> 字段名 `event_id / client_id / trigger_from / ...` 你可以自定义，只要服务端落库后你能对得上就行。

---

## 4. 变量映射提示（关键）

1. **`{{Event Data.xxx}}` 是否存在？**
   - 在 GTM 容器里「变量」→ 新建 **Event Data** 类型变量，填字段名 `event_id`、`client_id` 等。
   - 没有 → 标签发出去的是 `null`，日志里 event_id 就还是空的/静态值。

2. **`trigger_from` / `user_id` 是 `undefined`？**
   - 你之前贴的值就是 `undefined`，说明上游事件没带这俩字段。
   - 要么在 GA4 客户端 / 自定义事件里补齐，要么在 GTM 里用「默认值」兜底（如 `{{Event Data.trigger_from}}` 给默认 `"web"`）。

3. **`event_id` 要唯一**
   - 别写死成测试值 `3d6f7b1a-...`。用真实事件 ID 或 `{{Event Data.event_id}}`，否则所有事件会合并/重复。

---

## 5. 验收（改完怎么做）

1. GTM 预览模式触发一次 → 看「HTTP 请求」标签是否 `200`。
2. 我这边查日志：应出现 `event=<你的真实event_id> ... event accepted -> 200`。
3. 如果日志 event_id 仍是 `3d6f7b1a-...`，说明 body 还是静态模板，回去检查 Body 是否真的绑了变量。

---

## 配置速查（复制用）

```
Headers:
  Content-Type     = application/json
  x-pt-webhook-secret = b376a8359e51cd4d5d3f1808f5df04d51a123fa76379642ce20725a5b5365d58

Body (JSON):
  {
    "event_id":     "{{Event Data.event_id}}",
    "event_name":   "{{Event Data.event_name}}",
    "timestamp":    "{{Event Data.timestamp}}",
    "client_id":    "{{Event Data.client_id}}",
    "user_id":      "{{Event Data.user_id}}",
    "trigger_from": "{{Event Data.trigger_from}}",
    "utm_source":   "{{Event Data.utm_source}}",
    "utm_campaign": "{{Event Data.utm_campaign}}"
  }
```

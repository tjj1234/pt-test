"use strict";
/**
 * A20 · 五缺陷原始请求样例（对齐 diagnosis-baseline.json / §6）
 */
const TS = 1_725_000_000_000;
const UUID_D1 = "7f9c24a0-1111-4111-8111-111111111101";
const UUID_D2 = "7f9c24a0-1111-4111-8111-111111111102";
const UUID_D4 = "7f9c24a0-1111-4111-8111-111111111104";

const SCENARIOS = Object.freeze([
  {
    id: "D1_502_gateway",
    title: "502 网关",
    kind: "connection",
    // 连接探测用的「已合法」事件；故障来自 HTTP 层
    probeEvent: {
      event_id: UUID_D1,
      event_name: "visit",
      timestamp: TS,
      visitor_id: "ssgtm_d1",
    },
    simulateUpstream: { status: 502, body: "Bad Gateway" },
  },
  {
    id: "D2_event_name_case",
    title: "event_name 大小写不对",
    kind: "event",
    raw: {
      event_id: UUID_D2,
      event_name: "Visit",
      timestamp: TS,
      visitor_id: "ssgtm_d2",
      user_id: "usr_d2",
    },
    // 平台缓解：工作区映射
    mapping: { Visit: "visit" },
  },
  {
    id: "D3_event_id_non_uuid",
    title: "event_id 非 UUID",
    kind: "event",
    raw: {
      event_id: "gtm-client-id-not-uuid",
      event_name: "visit",
      timestamp: TS,
      visitor_id: "ssgtm_d3",
      user_id: "usr_d3",
    },
  },
  {
    id: "D4_missing_timestamp",
    title: "缺 timestamp",
    kind: "event",
    raw: {
      event_id: UUID_D4,
      event_name: "visit",
      visitor_id: "ssgtm_d4",
      user_id: "usr_d4",
    },
  },
  {
    id: "D5_missing_event_id",
    title: "缺 event_id",
    kind: "event",
    raw: {
      event_name: "visit",
      timestamp: TS,
      visitor_id: "ssgtm_d5",
      user_id: "usr_d5",
    },
  },
]);

module.exports = { SCENARIOS, TS };

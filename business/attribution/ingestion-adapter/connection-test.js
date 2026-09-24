"use strict";
/**
 * A17 · Collect 连接测试：把 HTTP/网络故障翻译成结构化人话诊断。
 * 不修改 collect/；通过 opts.fetch 注入便于单测。
 */

const DIAG = Object.freeze({
  OK: {
    code: "OK",
    title: "连接正常",
    hint: "密钥有效，Collect 已接受探测事件。",
  },
  SECRET_INVALID: {
    code: "SECRET_INVALID",
    title: "密钥错误",
    hint: "Webhook Secret 无效或已轮换。请到设置页核对 Collect 接入密钥后重试。",
  },
  SECRET_MISSING: {
    code: "SECRET_MISSING",
    title: "缺少密钥",
    hint: "请求未携带 Secret。请确认 Authorization / X-Webhook-Secret 头已配置。",
  },
  TARGET_BAD_GATEWAY: {
    code: "TARGET_BAD_GATEWAY",
    title: "目标地址 502",
    hint: "Collect 上游返回 502 Bad Gateway，目标服务不可用或网关错误。请检查看板/接收服务是否在线。",
  },
  TARGET_UNREACHABLE: {
    code: "TARGET_UNREACHABLE",
    title: "无法连接目标地址",
    hint: "网络连不上 Collect（连接拒绝或超时）。请检查 URL、端口与防火墙。",
  },
  INVALID_EVENT: {
    code: "INVALID_EVENT",
    title: "事件体未通过校验",
    hint: "探测事件未通过 Collect 三件套校验。请先走适配层归一化再测试。",
  },
  FORBIDDEN: {
    code: "FORBIDDEN",
    title: "无权限",
    hint: "Secret 已识别但无权访问该端点（403）。",
  },
  UNKNOWN: {
    code: "UNKNOWN",
    title: "未知故障",
    hint: "收到未归类的响应，请查看 detail 排查。",
  },
});

function diagnoseHttpStatus(status, bodyText) {
  const text = String(bodyText || "");
  if (status === 200 || status === 201 || status === 202) {
    return { ...DIAG.OK, httpStatus: status };
  }
  if (status === 401) {
    if (/MISSING_SECRET/i.test(text)) {
      return { ...DIAG.SECRET_MISSING, httpStatus: status };
    }
    return { ...DIAG.SECRET_INVALID, httpStatus: status };
  }
  if (status === 403) {
    if (/INVALID_SECRET|UNAUTHORIZED/i.test(text)) {
      return { ...DIAG.SECRET_INVALID, httpStatus: status };
    }
    return { ...DIAG.FORBIDDEN, httpStatus: status };
  }
  if (status === 400) {
    return { ...DIAG.INVALID_EVENT, httpStatus: status };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { ...DIAG.TARGET_BAD_GATEWAY, httpStatus: status, upstreamStatus: status };
  }
  return {
    ...DIAG.UNKNOWN,
    httpStatus: status,
    detail: text.slice(0, 500),
  };
}

function diagnoseNetworkError(err) {
  const msg = err && err.message ? err.message : String(err);
  const code = err && err.code ? err.code : null;
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    /fetch failed|network|socket/i.test(msg)
  ) {
    return { ...DIAG.TARGET_UNREACHABLE, networkCode: code, detail: msg };
  }
  return { ...DIAG.UNKNOWN, detail: msg, networkCode: code };
}

/**
 * @param {object} opts
 * @param {string} opts.collectUrl
 * @param {string} opts.secret
 * @param {object} opts.event 已通过适配层、可直送 Collect 的事件
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 */
async function runConnectionTest(opts = {}) {
  const collectUrl = opts.collectUrl;
  const secret = opts.secret;
  const event = opts.event;
  if (!collectUrl) {
    return {
      ok: false,
      diagnosis: {
        code: "BAD_REQUEST",
        title: "缺少 Collect URL",
        hint: "请提供 collectUrl。",
      },
    };
  }
  if (!secret) {
    return {
      ok: false,
      diagnosis: { ...DIAG.SECRET_MISSING, httpStatus: null },
    };
  }
  if (!event || typeof event !== "object") {
    return {
      ok: false,
      diagnosis: {
        code: "BAD_REQUEST",
        title: "缺少探测事件",
        hint: "请提供已适配的 event 对象。",
      },
    };
  }

  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw Object.assign(new Error("需要 fetch 实现（Node 18+ 或注入 opts.fetch）"), {
      code: "FETCH_REQUIRED",
    });
  }

  const timeoutMs = opts.timeoutMs || 8000;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchFn(collectUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(event),
      signal: controller ? controller.signal : undefined,
    });
    const bodyText = await res.text().catch(() => "");
    const diagnosis = diagnoseHttpStatus(res.status, bodyText);
    return {
      ok: diagnosis.code === "OK",
      diagnosis,
      httpStatus: res.status,
      responseSnippet: bodyText.slice(0, 300),
    };
  } catch (err) {
    const diagnosis = diagnoseNetworkError(err);
    return { ok: false, diagnosis, httpStatus: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  runConnectionTest,
  diagnoseHttpStatus,
  diagnoseNetworkError,
  DIAG,
};

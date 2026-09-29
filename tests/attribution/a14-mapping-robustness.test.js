"use strict";
/**
 * A14 · mapping 健壮性：未知平台 / 日期时区 / spend micros 死代码
 */
const {
  detectProvider,
  parseDate,
  normalizeSpend,
} = require("../../business/attribution/parsers/mapping");
const { parseExportFile } = require("../../business/attribution/parsers");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 修复前的时区敏感路径（对照用，勿再引入生产） */
function legacyParseDateViaLocalDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function run() {
  // ① 表头无任何平台特征 → PROVIDER_UNKNOWN，不再默默 meta
  const junkHeaders = ["foo", "bar", "baz", "widget count"];
  let code = null;
  let message = "";
  try {
    detectProvider(junkHeaders);
  } catch (e) {
    code = e.code;
    message = e.message || "";
  }
  assert(code === "PROVIDER_UNKNOWN", "detectProvider code got " + code);
  assert(/无法识别平台/.test(message), "detectProvider message: " + message);

  assert(detectProvider(junkHeaders, "meta") === "meta", "hint meta ok");
  assert(detectProvider(["Reporting starts", "Amount spent"], null) === "meta", "meta hints");
  assert(detectProvider(["Customer ID", "Cost micros"], null) === "google", "google hints");

  // import 校验同路径（parseExportFile）：无 provider + 怪表头 → 清楚失败，不入库
  let parseCode = null;
  let parseMsg = "";
  try {
    parseExportFile({
      buffer: Buffer.from("foo,bar,baz\n1,2,3\n"),
      filename: "mystery.csv",
      workspaceId: "ws_a14",
      sourceFileId: "sf_a14",
    });
  } catch (e) {
    parseCode = e.code;
    parseMsg = e.message || "";
  }
  assert(parseCode === "PROVIDER_UNKNOWN", "parseExportFile code " + parseCode);
  assert(/无法识别平台/.test(parseMsg), "parseExportFile msg");

  // ② 时区：未命中字面格式时旧实现可能错一天；修复后 null
  const ambiguous = "September 1, 2026";
  const legacy = legacyParseDateViaLocalDate(ambiguous);
  const fixedAmbiguous = parseDate(ambiguous);
  assert(fixedAmbiguous === null, "ambiguous must not Date-parse, got " + fixedAmbiguous);
  const offsetMin = -new Date(2026, 8, 1).getTimezoneOffset();
  if (offsetMin > 0) {
    assert(
      legacy === "2026-08-31",
      "legacy should shift in east-of-UTC TZ, got " + legacy + " offsetMin=" + offsetMin
    );
  } else if (offsetMin < 0) {
    assert(legacy === "2026-09-01" || /^\d{4}-\d{2}-\d{2}$/.test(String(legacy)), "legacy parsed");
  }
  assert(parseDate("2026-09-01T00:00:00") === "2026-09-01", "ISO prefix date stable");
  assert(parseDate("2026/09/01") === "2026-09-01", "slash ymd");
  assert(parseDate("9/1/2026") === "2026-09-01", "mdy");
  assert(parseDate("01 Sep 2026") === null, "day-mon-year text null");

  // ③ normalizeSpend：去掉大数值启发式；仅列名 micros 时 /1e6
  assert(normalizeSpend("150000", "google", false) === 150000, "no heuristic micros");
  assert(normalizeSpend("150000000", "google", true) === 150, "explicit micros");
  assert(normalizeSpend("12.5", "meta", false) === 12.5, "meta passthrough");

  console.log(
    JSON.stringify(
      {
        ok: true,
        providerUnknown: true,
        isoDate: parseDate("2026-09-01T00:00:00"),
        ambiguousRejected: true,
        legacyShiftDemo: legacy,
        tzOffsetMin: offsetMin,
      },
      null,
      2
    )
  );
}

run();

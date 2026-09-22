"use strict";
/**
 * A1 Parser 验收：三平台导出 → CanonicalAdRecord；workspaceId 来自 Context。
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  parseMetaExport,
  parseGoogleExport,
  parseXExport,
  parseExportFile,
} = require("../../business/attribution/parsers");
const { assertCanonicalAd, selfCheck } = require("../../business/attribution/contracts/validate");

const FIX = path.join(__dirname, "fixtures", "providers");
const CTX = {
  workspaceId: "ws_fixture_a1",
  sourceFileId: "file_fixture_a1",
};

function load(name) {
  return fs.readFileSync(path.join(FIX, name));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  const a0 = selfCheck();
  assert(a0.ok, "A0 selfCheck failed: " + a0.errors.join("; "));

  // Context 强制
  let threw = false;
  try {
    parseExportFile({ buffer: load("meta-ads.csv"), filename: "meta-ads.csv", sourceFileId: "x" });
  } catch (e) {
    threw = e.code === "CONTEXT_REQUIRED";
  }
  assert(threw, "缺少 workspaceId 必须抛 CONTEXT_REQUIRED");

  const meta = parseMetaExport({
    buffer: load("meta-ads.csv"),
    filename: "meta-ads.csv",
    ...CTX,
  });
  assert(meta.ok && !meta.partial, "meta parse failed: " + JSON.stringify(meta.errors));
  assert(meta.provider === "meta", "meta provider");
  assert(meta.records.length === 3, "meta row count");
  assert(meta.records[0].currency === "USD", "meta currency from header");
  assert(meta.records[0].spend === 120.5, "meta spend");
  assert(meta.records.every((r) => r.workspaceId === CTX.workspaceId), "workspace from context");
  for (const r of meta.records) {
    const errs = assertCanonicalAd(r, []);
    assert(errs.length === 0, "meta shape: " + errs.join("; "));
  }

  const google = parseGoogleExport({
    buffer: load("google-ads.csv"),
    filename: "google-ads.csv",
    ...CTX,
  });
  assert(google.ok && !google.partial, "google parse: " + JSON.stringify(google.errors));
  assert(google.provider === "google", "google provider");
  assert(google.records.length === 3, "google rows");
  assert(google.records[0].campaignId === "111", "google campaignId");
  assert(google.records[0].currency === "USD", "google currency");

  const x = parseXExport({
    buffer: load("x-ads.csv"),
    filename: "x-ads.csv",
    ...CTX,
  });
  assert(x.ok && !x.partial, "x parse: " + JSON.stringify(x.errors));
  assert(x.provider === "x", "x provider");
  assert(x.records.length === 2, "x rows");
  assert(x.records[0].creativeId === "tw_501", "x tweet id → creativeId");

  // 无官方 API：模块路径不得出现 oauth / ads.google
  const idxSrc = fs.readFileSync(
    path.join(__dirname, "../../business/attribution/parsers/index.js"),
    "utf8"
  );
  assert(!/oauth|ads\.google|graph\.facebook|api\.twitter/i.test(idxSrc), "no official API refs");

  console.log(
    JSON.stringify(
      {
        ok: true,
        metaRows: meta.successRows,
        googleRows: google.successRows,
        xRows: x.successRows,
        sample: meta.records[0],
      },
      null,
      2
    )
  );
}

run();

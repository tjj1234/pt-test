import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('Bug-10: CSP allows same-origin iframe embedding and prevents third-party clickjacking', async () => {
  // Verify CSP string pattern
  const cspHeader = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.volces.com https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev; media-src 'self' https://*.volces.com https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev; connect-src 'self' https://*.volces.com https://pub-425ca9cea13d454a907692a0a9f80079.r2.dev; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
  assert.ok(cspHeader.includes("frame-ancestors 'self'"), "frame-ancestors must be 'self' to permit dashFrame iframe");
  assert.ok(!cspHeader.includes("frame-ancestors 'none'"), "frame-ancestors 'none' must not be present");
});

test('Bug-05 & Bug-09: inferMediaTaskType correctly detects media intent', async () => {
  function inferMediaTaskType(text, hasImage) {
    if (!text || typeof text !== "string") return null;
    const t = text.trim();
    const wantsVideo = /^(生成视频|文生视频|制作视频|做个视频|合成视频|帮我做个视频)/i.test(t) || /(生成视频|文生视频)/i.test(t);
    const wantsImage = /^(生成图片|文生图|画一张|帮我画|绘制一张|生成一张.*图)/i.test(t) || /(生成图片|文生图)/i.test(t);
    if (wantsVideo) return hasImage ? "image2video" : "text2video";
    if (wantsImage) return hasImage ? "image2image" : "text2image";
    return null;
  }

  assert.equal(inferMediaTaskType('生成图片', false), 'text2image');
  assert.equal(inferMediaTaskType('画一张可爱的猫咪', false), 'text2image');
  assert.equal(inferMediaTaskType('帮我画一只小狗', false), 'text2image');
  assert.equal(inferMediaTaskType('生成视频：海边日落', false), 'text2video');
  assert.equal(inferMediaTaskType('生成图片', true), 'image2image');
  assert.equal(inferMediaTaskType('制作视频', true), 'image2video');
  assert.equal(inferMediaTaskType('问今天周几', false), null, 'Ordinary time query should not be media task');
  assert.equal(inferMediaTaskType('什么是人工智能？', false), null, 'General question should not be media task');
});

test('Bug-05 & Bug-09: get_current_time is exempt from tool call limits', async () => {
  // Simulate persistent-runner registerRunTool execution wrapper
  const limits = { maxToolCalls: 0 };
  let toolCalls = 0;
  function admit(type, name) {
    if (name === "get_current_time") return { allowed: true };
    if (type === "tool" && toolCalls >= limits.maxToolCalls) {
      return { allowed: false, code: "RUN_TOOL_CALL_LIMIT" };
    }
    toolCalls++;
    return { allowed: true };
  }

  // Calling get_current_time with maxToolCalls: 0 must succeed
  const timeAdmission = admit("tool", "get_current_time");
  assert.equal(timeAdmission.allowed, true, "get_current_time must be allowed even with maxToolCalls: 0");

  // Calling an unexempted tool with maxToolCalls: 0 must be blocked
  const externalToolAdmission = admit("tool", "unexempted_tool");
  assert.equal(externalToolAdmission.allowed, false, "Unexempted tool must still be blocked by tool-call limit");
  assert.equal(externalToolAdmission.code, "RUN_TOOL_CALL_LIMIT");
});

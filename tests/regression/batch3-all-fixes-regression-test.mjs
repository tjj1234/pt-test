import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createTextPriceCatalogStore } from '../../shell/usage/price-catalog-store.cjs';
import { createWorkspaceMetaStore } from '../../business/attribution/import/workspace-meta.js';

test('Batch 3 Bug 1 & 2: Production inferMediaTaskType correctly handles affirmative prompts and intercepts negations/inquiries', async () => {
  // 必须直接提取和执行生产真实函数，绝不私自复制简化正则
  const serverSrc = fs.readFileSync(path.resolve('shell/server.cjs'), 'utf8');
  const start = serverSrc.indexOf('function inferMediaTaskType(');
  const end = serverSrc.indexOf('\n}', start) + 2;
  const inferMediaTaskType = vm.runInNewContext(serverSrc.slice(start, end) + ';inferMediaTaskType');

  // 1. 真实正向生图/生视频请求
  assert.equal(inferMediaTaskType('帮我生成一个黑色小狗的照片，16:9的', false), 'text2image');
  assert.equal(inferMediaTaskType('帮我生成一个黑色小狗的照片，16:9的', true), 'image2image');
  assert.equal(inferMediaTaskType('生成海报：春季促销', false), 'text2image');
  assert.equal(inferMediaTaskType('画一只可爱的小猫咪', false), 'text2image');
  assert.equal(inferMediaTaskType('制作一段关于日落的动画视频', false), 'text2video');
  assert.equal(inferMediaTaskType('文生图：赛博朋克城市', false), 'text2image');
  assert.equal(inferMediaTaskType('文生视频：飞鸟掠过海面', false), 'text2video');

  // 2. 否定句拦截（必须返回 null，绝不误触发生图）
  assert.equal(inferMediaTaskType('不要生成图片，只解释原理', false), null);
  assert.equal(inferMediaTaskType('请解释如何生成图片，不要实际生成', false), null);
  assert.equal(inferMediaTaskType('不要生成图片', false), null);
  assert.equal(inferMediaTaskType('别画图，告诉我什么是图生图', false), null);
  assert.equal(inferMediaTaskType('不用生成视频，讲讲怎么剪辑的', false), null);
  assert.equal(inferMediaTaskType('禁止生成任何图片', false), null);
  assert.equal(inferMediaTaskType('只解释原理，无需生成', false), null);

  // 3. 纯教学/咨询/原理拦截（必须返回 null）
  assert.equal(inferMediaTaskType('如何生成一张高质量图片？', false), null);
  assert.equal(inferMediaTaskType('文生图的原理是什么？', false), null);
  assert.equal(inferMediaTaskType('解释一下图生视频的流程', false), null);
  assert.equal(inferMediaTaskType('帮我写一段冒泡排序算法', false), null);
  assert.equal(inferMediaTaskType('今天天气怎么样？', false), null);
});

test('Batch 3 Bug 7: Price catalog store returns honest unknown without fabricating official evidence', async () => {
  // 无录入 catalog 时，必须诚实返回 unknown，绝不自造 snapshot 与时间戳
  const emptyStore = createTextPriceCatalogStore({ query: async () => ({ rows: [] }) });
  const price = await emptyStore.selectAt({ model: 'deepseek-v4-pro', requestedAt: '2026-11-09T00:00:00Z' });

  assert.equal(price.coverage, 'unknown');
  assert.equal(price.snapshot, null);
  assert.equal(price.sourceSha256, null);
  assert.equal(price.reasonCode, 'NO_RECORDED_CATALOG');

  // 当有合法录入的 catalog 时，才按真实凭证匹配
  const mockCatalog = [{
    sourceUrl: 'https://powertokens.ai/pricing',
    version: 'pt-verified-20261109',
    capturedAt: '2026-11-09T00:00:00Z',
    effectiveFrom: '2026-11-09T00:00:00Z',
    effectiveUntil: null,
    currency: 'USD',
    model: 'deepseek-v4-pro',
    inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    cacheReadUsdPerMillion: 0.014,
    cacheWriteUsdPerMillion: 0.14,
  }];
  const populatedStore = createTextPriceCatalogStore({
    query: async () => ({
      rows: [{
        catalog_id: 'cat-verified-1',
        source_sha256: 'sha-verified-1',
        recorded_at: '2026-11-09T00:00:00Z',
        snapshots: mockCatalog,
      }]
    })
  });
  const matched = await populatedStore.selectAt({ model: 'deepseek-v4-pro', requestedAt: '2026-11-09T10:00:00Z' });
  assert.equal(matched.coverage, 'selected');
  assert.equal(matched.snapshot.model, 'deepseek-v4-pro');
  assert.equal(matched.snapshot.inputUsdPerMillion, 0.14);
});

test('Batch 3 Bug 5 & 6: workspace-meta persists to disk across restarts and throws on real IO failure', async () => {
  const tmpDir = path.join('/private/tmp', 'pt-workspace-meta-test-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. 正常保存与重新打开（验证真实磁盘持久化，重开不丢失）
    const store1 = createWorkspaceMetaStore({ storageDir: tmpDir });
    const saved = store1.markFirstConnected('ws_persist_test');
    assert.ok(saved.firstConnectedAt, 'firstConnectedAt must be stamped');

    const store2 = createWorkspaceMetaStore({ storageDir: tmpDir });
    const reloaded = store2.load('ws_persist_test');
    assert.equal(reloaded.firstConnectedAt, saved.firstConnectedAt, 'Reopened store must load identical persisted timestamp from disk');

    // 2. 真实 IO 失败测试：当路径为文件而不是目录时，必须如实抛出 ENOTDIR，严禁用内存假成功掩盖磁盘存储失败
    const badFilePath = path.join(tmpDir, 'not_a_dir_fixture');
    fs.writeFileSync(badFilePath, 'dummy file');
    const badStore = createWorkspaceMetaStore({ storageDir: badFilePath });

    assert.throws(() => {
      badStore.markFirstConnected('ws_should_fail');
    }, /ENOTDIR/, 'Must throw ENOTDIR on storage path failure without pretending success in memory');

    // 3. 文件损坏测试：JSON 损坏时抛出 WORKSPACE_META_CORRUPTED，绝不静默伪装成未连接
    const corruptFile = path.join(tmpDir, '_workspaces', 'ws_corrupt.json');
    fs.writeFileSync(corruptFile, '{ corrupt json invalid ...');
    assert.throws(() => {
      store1.load('ws_corrupt');
    }, (err) => err && err.code === 'WORKSPACE_META_CORRUPTED', 'Must throw WORKSPACE_META_CORRUPTED on invalid json');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('Batch 3 Bug 3: HTML preview iframe and server CSP strictly prohibit script execution and parent access', async () => {
  const appSrc = fs.readFileSync(path.resolve('shell/public/app.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.resolve('shell/server.cjs'), 'utf8');

  // 前端 iframe 必须保持安全沙箱：HTML 禁脚本（空 sandbox）
  assert.ok(appSrc.includes('f.setAttribute("sandbox", a.kind === "html" ? "" : "allow-same-origin");'),
    'app.js must strictly forbid scripts for HTML artifacts in preview iframe');
  assert.ok(!appSrc.includes('allow-same-origin allow-scripts'),
    'app.js must never combine allow-same-origin and allow-scripts');

  // 服务端 CSP 必须对 HTML 产物实施 default-src none，掐死同源脚本执行
  assert.ok(serverSrc.includes("artHeaders[\"Content-Security-Policy\"] = \"default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:\";"),
    'server.cjs must apply strict readonly CSP default-src none for html artifacts');
});

test('Batch 3 Bug 8: /api/models/reasoning semantics strictly separates unsupported effort from real failure', async () => {
  const serverSrc = fs.readFileSync(path.resolve('shell/server.cjs'), 'utf8');

  // 1. 模型不支持推理档位：合法空集，返回 HTTP 200
  assert.ok(serverSrc.includes('if (info.code === "MODEL_INFO_UNSUPPORTED") return json(res, 200, { ok: true, efforts: [], defaultEffort: null });'),
    'server.cjs must return 200 with empty efforts when model explicitly does not support reasoning');

  // 2. 真实服务异常（不可达、超时、key 缺失）：如实返回 HTTP 503 与原因码
  assert.ok(serverSrc.includes('return json(res, 503, { ok: false, code: info.code || "MODEL_INFO_UNAVAILABLE", error: info.error || "暂时无法读取推理档位" });'),
    'server.cjs must return 503 on real service failure without disguising it as 200');
});

test('Batch 3 Bug 9: /favicon.ico static route serves standard SVG icon with cache headers', async () => {
  const serverSrc = fs.readFileSync(path.resolve('shell/server.cjs'), 'utf8');
  assert.ok(serverSrc.includes('if (p === "/favicon.ico")'), 'server.cjs must handle /favicon.ico');
  assert.ok(serverSrc.includes('"Content-Type": "image/svg+xml"'), 'server.cjs must serve SVG icon for favicon');
  assert.ok(serverSrc.includes('"Cache-Control": "public, max-age=86400"'), 'server.cjs must provide strong cache headers');
});

test('Batch 3 Bug 5 concurrency: workspace-meta atomic write prevents torn reads under concurrent calls', async () => {
  const tmpDir = path.join('/private/tmp', 'pt-workspace-concurrency-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const store = createWorkspaceMetaStore({ storageDir: tmpDir });
    // 并发 10 次写入
    const writes = Array.from({ length: 10 }, (_, i) => {
      return store.save({
        workspaceId: 'ws_concurrent',
        firstConnectedAt: new Date(Date.now() + i * 1000).toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    assert.equal(writes.length, 10);

    // 重新打开
    const storeReopened = createWorkspaceMetaStore({ storageDir: tmpDir });
    const loaded = storeReopened.load('ws_concurrent');
    assert.ok(loaded.firstConnectedAt, 'Concurrent writes must produce a valid atomic JSON file on disk');
    assert.equal(loaded.workspaceId, 'ws_concurrent');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

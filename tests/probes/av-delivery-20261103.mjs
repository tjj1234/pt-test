import { createAvProcessor, verifyMagicBytes, sha256 } from '../../shell/candidates/av-20261103/index.cjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✔ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ✖ [FAIL] ${message}`);
    failed++;
  }
}

// 辅助构造真实 Magic Bytes 头部
function createWavBuffer(dataLen = 32) {
  const buf = Buffer.alloc(12 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(4 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

function createMp3Buffer(dataLen = 32) {
  const buf = Buffer.alloc(10 + dataLen);
  buf.write('ID3', 0, 'ascii'); // ID3v2
  buf[3] = 0x03; // version 2.3
  buf.fill(0xaa, 10);
  return buf;
}

function createMp4Buffer(dataLen = 32) {
  const buf = Buffer.alloc(16 + dataLen);
  buf.writeUInt32BE(16 + dataLen, 0); // box size
  buf.write('ftyp', 4, 'ascii');      // box type
  buf.write('isom', 8, 'ascii');      // major brand
  buf.fill(0x55, 16);
  return buf;
}

function createWebmBuffer(dataLen = 32) {
  const buf = Buffer.alloc(8 + dataLen);
  buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3; // EBML ID
  buf.fill(0x77, 8);
  return buf;
}

async function run() {
  console.log('\n=== AV 音视频内容与时间定位探针开始 ===\n');

  // [1] Magic Bytes 探测
  console.log('[1] Magic Bytes 探测');
  {
    const wav = createWavBuffer();
    assert(verifyMagicBytes(wav, 'audio/wav') === true, 'WAV magic bytes 识别通过');
    assert(verifyMagicBytes(wav, 'video/mp4') === false, 'WAV 匹配 MP4 mime 拒绝');

    const mp3 = createMp3Buffer();
    assert(verifyMagicBytes(mp3, 'audio/mp3') === true, 'MP3 ID3 magic bytes 识别通过');

    const mp4 = createMp4Buffer();
    assert(verifyMagicBytes(mp4, 'video/mp4') === true, 'MP4 ftyp magic bytes 识别通过');

    const webm = createWebmBuffer();
    assert(verifyMagicBytes(webm, 'video/webm') === true, 'WEBM EBML magic bytes 识别通过');

    const fakeMedia = Buffer.from('NOT_A_REAL_MEDIA_CONTENT_HEADER');
    assert(verifyMagicBytes(fakeMedia, 'audio/wav') === false, '伪造媒体数据校验拒绝');
  }

  const processor = createAvProcessor({ tenantId: 'tenant-prod' });

  // [2] 格式与非法输入拦截
  console.log('\n[2] 格式与非法输入拦截');
  {
    const badMedia = Buffer.from('FAKE_WAV_HEADER');
    const resBad = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: badMedia,
      mimeType: 'audio/wav',
    });
    assert(resBad.ok === false && resBad.code === 'UNSUPPORTED_FORMAT', '坏媒体返回 UNSUPPORTED_FORMAT');

    // 跨租户拦截
    const resTenant = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-other',
      buffer: createWavBuffer(),
      mimeType: 'audio/wav',
    });
    assert(resTenant.ok === false && resTenant.code === 'CROSS_TENANT_REJECTED', '跨租户拒绝 CROSS_TENANT_REJECTED');
  }

  // [3] 资源限制与取消中断
  console.log('\n[3] 资源限制与取消中断');
  {
    // 超字节上限
    const resByte = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: createWavBuffer(100),
      mimeType: 'audio/wav',
      maxBytes: 50,
    });
    assert(resByte.ok === false && resByte.code === 'BYTE_LIMIT_EXCEEDED', '超字节上限返回 BYTE_LIMIT_EXCEEDED');

    // 超时长上限
    const resDuration = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: createWavBuffer(),
      mimeType: 'audio/wav',
      durationHintMs: 400000,
      maxDurationMs: 300000,
    });
    assert(resDuration.ok === false && resDuration.code === 'DURATION_EXCEEDED', '超时长上限返回 DURATION_EXCEEDED');

    // 信号中断
    const controller = new AbortController();
    controller.abort();
    const resCancel = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: createWavBuffer(),
      mimeType: 'audio/wav',
      signal: controller.signal,
    });
    assert(resCancel.ok === false && resCancel.code === 'RUN_CANCELLED', '信号取消返回 RUN_CANCELLED');
  }

  // [4] 音频转写降级与确定性证据
  console.log('\n[4] 音频转写降级与确定性证据');
  {
    const wavBuf = createWavBuffer();
    const expectedSha = sha256(wavBuf);

    // 离线/原生无 ASR 状态
    const resAudioOffline = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: wavBuf,
      mimeType: 'audio/wav',
      durationHintMs: 15000,
    });
    assert(resAudioOffline.ok === true, '音频结构解析 ok=true');
    assert(resAudioOffline.type === 'audio', 'type=audio');
    assert(resAudioOffline.blocked === true, '原生无 ASR 标记 blocked=true');
    assert(resAudioOffline.blockedReason === 'BLOCKED_ASR_NATIVE', 'blockedReason=BLOCKED_ASR_NATIVE');
    assert(resAudioOffline.inputSha256 === expectedSha, 'inputSha256 与媒体精确匹配');

    // 挂载 ASR 模拟后端
    const asrProcessor = createAvProcessor({
      tenantId: 'tenant-prod',
      asrBackend: async () => [
        { startMs: 0, endMs: 2500, text: 'Hello deep learning', confidence: 0.95 },
        { startMs: 2600, endMs: 5000, text: 'This is an audio test', confidence: 0.92 },
      ],
    });

    const resAudioOnline = await asrProcessor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: wavBuf,
      mimeType: 'audio/wav',
      durationHintMs: 5000,
    });
    assert(resAudioOnline.ok === true, 'ASR 挂载转写 ok=true');
    assert(resAudioOnline.blocked === false, '转写成功 blocked=false');
    assert(resAudioOnline.segments.length === 2, '生成 2 个时间戳分段');
    assert(resAudioOnline.segments[0].startMs === 0 && resAudioOnline.segments[0].text === 'Hello deep learning', '分段内容与时间线对齐');
  }

  // [5] 视频抽帧降级与确定性证据
  console.log('\n[5] 视频抽帧降级与确定性证据');
  {
    const mp4Buf = createMp4Buffer();
    const expectedSha = sha256(mp4Buf);

    // 离线/无 ffmpeg 状态
    const resVideoOffline = await processor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: mp4Buf,
      mimeType: 'video/mp4',
      durationHintMs: 30000,
    });
    assert(resVideoOffline.ok === true, '视频解析 ok=true');
    assert(resVideoOffline.type === 'video', 'type=video');
    assert(resVideoOffline.blocked === true, '无 ffmpeg 标记 blocked=true');
    assert(resVideoOffline.blockedReason === 'BLOCKED_FFMPEG', 'blockedReason=BLOCKED_FFMPEG');
    assert(resVideoOffline.inputSha256 === expectedSha, 'inputSha256 精确匹配');

    // 挂载抽帧模拟后端
    const videoProcessor = createAvProcessor({
      tenantId: 'tenant-prod',
      frameExtractor: async () => [
        { timestampMs: 1000, frameBase64: 'data:image/jpeg;base64,frame1', width: 1280, height: 720 },
        { timestampMs: 5000, frameBase64: 'data:image/jpeg;base64,frame2', width: 1280, height: 720 },
      ],
    });

    const resVideoOnline = await videoProcessor.processMedia({
      runId: 'run-av-1',
      tenantId: 'tenant-prod',
      buffer: mp4Buf,
      mimeType: 'video/mp4',
    });
    assert(resVideoOnline.ok === true, '抽帧处理 ok=true');
    assert(resVideoOnline.blocked === false, '抽帧成功 blocked=false');
    assert(resVideoOnline.frames.length === 2, '成功获取 2 个时间戳关键帧');
    assert(resVideoOnline.frames[0].width === 1280 && resVideoOnline.frames[0].height === 720, '关键帧分辨率元信息完整');
  }

  console.log(`\n=== AV 探针完成：共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项 ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('AV probe fatal error:', err);
  process.exit(1);
});

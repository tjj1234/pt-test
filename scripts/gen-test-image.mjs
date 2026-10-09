"use strict";
/**
 * scripts/gen-test-image.mjs —— 生成一张合法、≥240x240 的 PNG 测试图（RGB 渐变）
 * 用途：media.route 图生视频 data URL 端到端验证需要一张合规输入图（坑：PT 要求 ≥240x240）。
 * 用法：node scripts/gen-test-image.mjs [输出路径] [宽] [高]
 * 纯 Node 实现（无第三方依赖）：PNG 签名 + IHDR + IDAT(zlib deflate) + IEND + CRC32。
 */
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const o = rowStart + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 255);
      raw[o + 2] = (x ^ y) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const out = process.argv[2] || "test-240.png";
const w = parseInt(process.argv[3] || "240", 10);
const h = parseInt(process.argv[4] || "240", 10);
const png = makePng(w, h);
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${w}x${h}，${png.length} 字节）`);

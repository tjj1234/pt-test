'use strict';
function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return null;
  let start = 0;
  // 跳过 UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  // 文本内容里不该出现 NUL 字节（二进制 / UTF-16 的特征），据此拒绝伪装成文本的文件
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0) return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(start));
  } catch (e) {
    return null;
  }
}
module.exports={decodeTextBuffer};

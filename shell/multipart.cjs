"use strict";
/**
 * 轻量 multipart/form-data 解析（零第三方依赖，只覆盖上传所需的文件 + 少量文本字段）。
 * 只解析「整个 body 已在内存里」的场景，配合 server.cjs 里的 readBodyBuffer 读取。
 * 不处理 chunked 流式、超大文件落盘等；上传大小限制仍由调用方在上游的 readBodyBuffer limit 兜底。
 */

// 判断是否为 multipart/form-data 请求
function isMultipart(req) {
  return String(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data");
}

// 解析 multipart/form-data 中的一段（headers + body），返回 { name, filename, contentType, data } 或 null
function parseMultipartPart(part) {
  const sep = part.indexOf("\r\n\r\n");
  if (sep < 0) return null;
  const headerBlock = part.subarray(0, sep).toString("utf8");
  const data = part.subarray(sep + 4);
  const nameM = /name="([^"]*)"/i.exec(headerBlock);
  const fileM = /filename="([^"]*)"/i.exec(headerBlock);
  const ctM = /content-type:\s*([^\r\n]+)/i.exec(headerBlock);
  return {
    name: nameM ? nameM[1] : "",
    filename: fileM ? fileM[1] : null,
    contentType: ctM ? ctM[1].trim() : null,
    data,
  };
}

// 解析 multipart/form-data 请求体，返回 { fields: {name->string}, files: {name->{filename,contentType,data}} } 或 null
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  const boundary = bm ? (bm[1] || bm[2] || "").trim() : "";
  if (!boundary || !buf || !buf.length) return null;
  const first = Buffer.from("--" + boundary);
  const sep = Buffer.from("\r\n--" + boundary);
  const result = { fields: {}, files: {} };

  let idx = buf.indexOf(first);
  if (idx < 0) return result;
  let cursor = idx + first.length;
  // 边界后紧跟 "--" 表示空表单；紧跟 CRLF 表示开始第一部分
  if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) return result;
  if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2;

  while (cursor < buf.length) {
    const next = buf.indexOf(sep, cursor);
    const partEnd = next < 0 ? buf.length : next;
    const parsed = parseMultipartPart(buf.subarray(cursor, partEnd));
    if (parsed) {
      if (parsed.filename != null) {
        result.files[parsed.name] = { filename: parsed.filename, contentType: parsed.contentType, data: parsed.data };
      } else {
        result.fields[parsed.name] = parsed.data.toString("utf8");
      }
    }
    if (next < 0) break;
    cursor = next + sep.length;
    // 分隔符后紧跟 "--" 表示结束
    if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) break;
    if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2;
  }
  return result;
}

module.exports = { isMultipart, parseMultipart, parseMultipartPart };

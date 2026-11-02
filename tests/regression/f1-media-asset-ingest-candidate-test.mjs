import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ReadableStream } from "node:stream/web";
import {
  ingestMediaAssetCandidate,
  validateSafeUrl,
  validateMimeType,
  resolveMaxBytes,
  resolveTimeoutMs,
  ALLOWED_MIME_TYPES,
  HARD_CEILING_IMAGE_MAX_BYTES,
  HARD_CEILING_VIDEO_MAX_BYTES,
  HARD_CEILING_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from "../../shell/media/asset-ingest-candidate.cjs";

/**
 * 构造模拟的 Response 对象，支持 Headers 与 Web ReadableStream
 */
function createMockResponse({
  status = 200,
  headers = {},
  chunks = [],
  streamError = null,
  cancelError = null,
  hangOnRead = false,
  body = undefined,
  arrayBufferSpy = null,
}) {
  const headerMap = new Map();
  for (const [k, v] of Object.entries(headers)) {
    headerMap.set(k.toLowerCase(), String(v));
  }

  const responseHeaders = {
    get: (k) => headerMap.get(k.toLowerCase()) || null,
  };

  if (body !== undefined) {
    return {
      status,
      headers: responseHeaders,
      body,
      arrayBuffer: arrayBufferSpy || (async () => Buffer.concat(chunks.map(Buffer.from))),
    };
  }

  let chunkIndex = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (hangOnRead) {
        // 故意返回永远不决议的 Promise，模拟不配合的 stream reader
        return new Promise(() => {});
      }
      if (streamError) {
        controller.error(streamError);
        return;
      }
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[chunkIndex++];
      controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    cancel() {
      if (cancelError) throw cancelError;
    },
  });

  return {
    status,
    headers: responseHeaders,
    body: stream,
    arrayBuffer: arrayBufferSpy || (async () => {
      throw new Error("arrayBuffer should not be called when streaming is required");
    }),
  };
}

describe("F1 媒体资产持久化候选模块 (asset-ingest-candidate.cjs) - 2026-10-26 加固测试", () => {
  const ALLOWED_HOSTS = ["api.powertokens.ai", "cdn.powertokens.ai"];

  describe("1. 正向成功用例", () => {
    it("正常拉取合法主机的图片资产并精确计算哈希", async () => {
      const sampleData = Buffer.from("fake-jpeg-binary-image-data-payload-12345");
      const expectedSha256 = crypto.createHash("sha256").update(sampleData).digest("hex");

      const mockFetch = async (url, init) => {
        assert.equal(init.redirect, "manual");
        return createMockResponse({
          status: 200,
          headers: {
            "content-type": "image/jpeg; charset=binary",
            "content-length": String(sampleData.length),
          },
          chunks: [sampleData.subarray(0, 10), sampleData.subarray(10)],
        });
      };

      const result = await ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/v1/assets/generated-image-001.jpg?token=secret123",
        expectedKind: "image",
        allowedHosts: ALLOWED_HOSTS,
        fetchImpl: mockFetch,
        maxBytes: 1024 * 1024,
      });

      assert.equal(result.mime, "image/jpeg");
      assert.equal(result.byteCount, sampleData.length);
      assert.equal(result.sha256, expectedSha256);
      assert.deepEqual(result.buffer, sampleData);
    });

    it("正常拉取合法主机的视频资产（流式读取）", async () => {
      const videoChunk1 = Buffer.from("mp4-moov-atom-header-");
      const videoChunk2 = Buffer.from("mp4-mdat-media-payload-stream");
      const totalBuffer = Buffer.concat([videoChunk1, videoChunk2]);
      const expectedSha256 = crypto.createHash("sha256").update(totalBuffer).digest("hex");

      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: {
            "content-type": "video/mp4",
          },
          chunks: [videoChunk1, videoChunk2],
        });
      };

      const result = await ingestMediaAssetCandidate({
        resultUrl: "https://cdn.powertokens.ai/videos/output-wan27.mp4",
        expectedKind: "video",
        allowedHosts: ALLOWED_HOSTS,
        fetchImpl: mockFetch,
      });

      assert.equal(result.mime, "video/mp4");
      assert.equal(result.byteCount, totalBuffer.length);
      assert.equal(result.sha256, expectedSha256);
      assert.deepEqual(result.buffer, totalBuffer);
    });
  });

  describe("2. URL 安全防御与 SSRF 防护", () => {
    it("拒绝域名后缀伪造 (domain suffix spoofing)", async () => {
      const spoofUrls = [
        "https://api.powertokens.ai.attacker.com/image.jpg",
        "https://api.powertokens.ai-evil.com/image.jpg",
        "https://not-api.powertokens.ai/image.jpg",
      ];
      for (const url of spoofUrls) {
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: url,
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
            });
          },
          (err) => err.code === "HOST_NOT_ALLOWED"
        );
      }
    });

    it("拒绝 IP 字面量（IPv4 与 IPv6）", async () => {
      const ipUrls = [
        "https://127.0.0.1/image.png",
        "https://192.168.1.1/video.mp4",
        "https://10.0.0.1/test.jpg",
        "https://169.254.169.254/metadata",
        "https://[::1]/image.jpg",
      ];
      for (const url of ipUrls) {
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: url,
              expectedKind: "image",
              allowedHosts: [...ALLOWED_HOSTS, "127.0.0.1"],
            });
          },
          (err) => err.code === "IP_LITERAL_DISALLOWED"
        );
      }
    });

    it("拒绝 localhost 及内部域名", async () => {
      const localUrls = [
        "https://localhost/image.png",
        "https://foo.localhost/image.png",
        "https://service.local/image.png",
        "https://internal.host.internal/image.png",
      ];
      for (const url of localUrls) {
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: url,
              expectedKind: "image",
              allowedHosts: [...ALLOWED_HOSTS, "localhost"],
            });
          },
          (err) => err.code === "LOCAL_HOST_DISALLOWED"
        );
      }
    });

    it("拒绝非 HTTPS 协议（如 plain HTTP / ftp 等）", async () => {
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "http://api.powertokens.ai/image.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
          });
        },
        (err) => err.code === "DISALLOWED_PROTOCOL"
      );
    });

    it("拒绝在 URL 中携带用户名或密码凭据", async () => {
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://admin:password123@api.powertokens.ai/image.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
          });
        },
        (err) => err.code === "URL_CREDENTIALS_DISALLOWED"
      );
    });

    it("拒绝空 allowedHosts 白名单", async () => {
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/image.png",
            expectedKind: "image",
            allowedHosts: [],
          });
        },
        (err) => err.code === "EMPTY_ALLOWED_HOSTS"
      );
    });
  });

  describe("3. HTTP 状态码与重定向防御 (Fail-Closed)", () => {
    it("遇到 301/302/307/308 重定向立即拒绝", async () => {
      const redirectStatuses = [301, 302, 307, 308];
      for (const status of redirectStatuses) {
        const mockFetch = async () => {
          return createMockResponse({
            status,
            headers: { location: "https://inner-service.internal/secret" },
          });
        };
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: "https://api.powertokens.ai/redirect-test",
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
              fetchImpl: mockFetch,
            });
          },
          (err) => err.code === "REDIRECT_NOT_ALLOWED"
        );
      }
    });

    it("遇到非 2xx HTTP 状态码（如 404, 403, 500）拒绝", async () => {
      const errorStatuses = [400, 403, 404, 500, 502];
      for (const status of errorStatuses) {
        const mockFetch = async () => createMockResponse({ status });
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: "https://api.powertokens.ai/image.png",
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
              fetchImpl: mockFetch,
            });
          },
          (err) => err.code === "HTTP_ERROR"
        );
      }
    });
  });

  describe("4. MIME 类型审查与错配拒绝", () => {
    it("期望 image 但返回 HTML 或 JSON 时拒绝", async () => {
      const invalidMimes = ["text/html", "application/json", "application/octet-stream", "video/mp4"];
      for (const mime of invalidMimes) {
        const mockFetch = async () => {
          return createMockResponse({
            status: 200,
            headers: { "content-type": mime },
            chunks: [Buffer.from("invalid-payload")],
          });
        };
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: "https://api.powertokens.ai/test",
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
              fetchImpl: mockFetch,
            });
          },
          (err) => err.code === "MIME_TYPE_MISMATCH"
        );
      }
    });

    it("缺少 Content-Type 响应头时拒绝", async () => {
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: {},
          chunks: [Buffer.from("payload")],
        });
      };
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/test",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
          });
        },
        (err) => err.code === "MISSING_CONTENT_TYPE"
      );
    });

    it("上游在 Content-Type 中带 token 或异常内容时不泄露至错误信息", async () => {
      const SECRET_IN_HEADER = "header-token-secret-999";
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": `image/png?token=${SECRET_IN_HEADER}` },
          chunks: [Buffer.from("payload")],
        });
      };

      try {
        await ingestMediaAssetCandidate({
          resultUrl: "https://api.powertokens.ai/test",
          expectedKind: "image",
          allowedHosts: ALLOWED_HOSTS,
          fetchImpl: mockFetch,
        });
        assert.fail("应抛出 MIME_TYPE_MISMATCH");
      } catch (err) {
        assert.equal(err.code, "MIME_TYPE_MISMATCH");
        assert.equal(err.message.includes(SECRET_IN_HEADER), false, "错误信息泄露了 Content-Type 中的敏感 token");
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.equal(serialized.includes(SECRET_IN_HEADER), false, "错误属性泄露了敏感 token");
      }
    });
  });

  describe("5. 容量与流式超限拦截", () => {
    it("Content-Length 头部声明超限时立即拦截，不拉取 Body", async () => {
      let bodyReadAttempted = false;
      const mockFetch = async () => {
        return {
          status: 200,
          headers: {
            get: (k) => {
              if (k.toLowerCase() === "content-type") return "image/png";
              if (k.toLowerCase() === "content-length") return "10485760"; // 10MB
              return null;
            },
          },
          get body() {
            bodyReadAttempted = true;
            return null;
          },
        };
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/big.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            maxBytes: 1024 * 1024, // 1MB 限制
          });
        },
        (err) => err.code === "CONTENT_LENGTH_OVERSIZE"
      );
      assert.equal(bodyReadAttempted, false, "不应触发对 body 的读取");
    });

    it("流式读取过程中累计大小超过上限时立即中断并报错", async () => {
      const chunk = Buffer.alloc(200 * 1024, 0x61); // 200KB chunk
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          chunks: [chunk, chunk, chunk], // 总共 600KB
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/stream-overflow.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            maxBytes: 300 * 1024, // 限制 300KB
          });
        },
        (err) => err.code === "ASSET_OVERSIZE"
      );
    });

    it("空 Body (0 字节) 拒绝", async () => {
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/png" },
          chunks: [],
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/empty.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
          });
        },
        (err) => err.code === "EMPTY_RESPONSE_BODY"
      );
    });
  });

  describe("6. 参数边界与受控上界校验 (maxBytes / timeoutMs)", () => {
    it("maxBytes 拒绝 Infinity, NaN, 负数, 零, 非安全整数或非数字", async () => {
      const invalidValues = [Infinity, -Infinity, NaN, -100, 0, "100", 10.5, true, null, {}];
      for (const val of invalidValues) {
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: "https://api.powertokens.ai/test.jpg",
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
              maxBytes: val,
            });
          },
          (err) => err.code === "INVALID_MAX_BYTES",
          `值 ${val} 应被拒绝为 INVALID_MAX_BYTES`
        );
      }
    });

    it("maxBytes 超过硬上限时拒绝 (MAX_BYTES_EXCEEDS_CEILING)", async () => {
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/test.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            maxBytes: HARD_CEILING_IMAGE_MAX_BYTES + 1,
          });
        },
        (err) => err.code === "MAX_BYTES_EXCEEDS_CEILING"
      );

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/test.mp4",
            expectedKind: "video",
            allowedHosts: ALLOWED_HOSTS,
            maxBytes: HARD_CEILING_VIDEO_MAX_BYTES + 1,
          });
        },
        (err) => err.code === "MAX_BYTES_EXCEEDS_CEILING"
      );
    });

    it("宿主传入合法较小 maxBytes 时严格保留生效", async () => {
      const chunk = Buffer.alloc(2048, 0x7a); // 2048 bytes
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          chunks: [chunk],
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/small-limit.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            maxBytes: 1024, // 严格限制为 1024 字节
          });
        },
        (err) => err.code === "ASSET_OVERSIZE"
      );
    });

    it("timeoutMs 拒绝 Infinity, NaN, 负数, 零, 非安全整数或超出硬上限", async () => {
      const invalidTimeouts = [Infinity, -Infinity, NaN, -100, 0, "60000", 10.5, true, null, {}];
      for (const val of invalidTimeouts) {
        await assert.rejects(
          async () => {
            await ingestMediaAssetCandidate({
              resultUrl: "https://api.powertokens.ai/test.jpg",
              expectedKind: "image",
              allowedHosts: ALLOWED_HOSTS,
              timeoutMs: val,
            });
          },
          (err) => err.code === "INVALID_TIMEOUT",
          `值 ${val} 应被拒绝为 INVALID_TIMEOUT`
        );
      }

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/test.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            timeoutMs: HARD_CEILING_TIMEOUT_MS + 1,
          });
        },
        (err) => err.code === "TIMEOUT_EXCEEDS_CEILING"
      );
    });
  });

  describe("7. 流式强制约束与禁止整块 arrayBuffer()", () => {
    it("若响应体不是 readable stream，立即失败关闭 (UNSUPPORTED_RESPONSE_BODY)", async () => {
      const mockFetchNoStream = async () => {
        return {
          status: 200,
          headers: { get: () => "image/png" },
          body: null, // 无流
          arrayBuffer: async () => Buffer.from("payload"),
        };
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/no-stream.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetchNoStream,
          });
        },
        (err) => err.code === "UNSUPPORTED_RESPONSE_BODY"
      );
    });

    it("有流式响应体时，绝不调用不受限的 arrayBuffer()", async () => {
      let arrayBufferCalled = false;
      const sample = Buffer.from("streaming-payload-data");
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/png" },
          chunks: [sample],
          arrayBufferSpy: async () => {
            arrayBufferCalled = true;
            return sample;
          },
        });
      };

      const result = await ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/verify-no-array-buffer.png",
        expectedKind: "image",
        allowedHosts: ALLOWED_HOSTS,
        fetchImpl: mockFetch,
      });

      assert.equal(result.byteCount, sample.length);
      assert.equal(arrayBufferCalled, false, "不应调用 response.arrayBuffer()");
    });

    it("头部伪报小尺寸但实际流中超限时，仍被 ASSET_OVERSIZE 截断", async () => {
      const chunk = Buffer.alloc(10 * 1024, 0x41); // 10KB
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "100", // 伪报为 100 字节
          },
          chunks: [chunk], // 实际发送 10KB
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/fake-header.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            maxBytes: 1024, // 限制 1KB
          });
        },
        (err) => err.code === "ASSET_OVERSIZE"
      );
    });
  });

  describe("8. 超时、挂起防御与流异常", () => {
    it("fetch 调用不响应 AbortSignal 并无限挂起时，在 timeoutMs 内有界拒绝", async () => {
      const mockHangingFetch = () => {
        // 故意返回永远挂起的 Promise，且不监听 signal
        return new Promise(() => {});
      };

      const startedAt = Date.now();
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/hang-fetch.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockHangingFetch,
            timeoutMs: 35, // 35ms 超时
          });
        },
        (err) => err.code === "INGEST_TIMEOUT"
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 300, `应在有界时间内超时退出，实际耗时 ${elapsed}ms`);
    });

    it("reader.read() 不响应 AbortSignal 并无限挂起时，在 timeoutMs 内有界拒绝", async () => {
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/png" },
          hangOnRead: true, // 故意挂起 read()
        });
      };

      const startedAt = Date.now();
      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/hang-stream.png",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            timeoutMs: 35,
          });
        },
        (err) => err.code === "INGEST_TIMEOUT"
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 300, `应在有界时间内超时退出，实际耗时 ${elapsed}ms`);
    });

    it("中途流读取中断时抛出 STREAM_READ_ERROR", async () => {
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          chunks: [Buffer.from("partial-data")],
          streamError: new Error("Premature socket closed"),
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/broken-stream.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
          });
        },
        (err) => err.code === "STREAM_READ_ERROR"
      );
    });

    it("释放 reader.cancel() 报错时不得遮盖原始固定错误码", async () => {
      const chunk = Buffer.alloc(5000, 0x61);
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          chunks: [chunk],
          cancelError: new Error("Reader cancel socket failure"), // cancel 时报错
        });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/cancel-error.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            maxBytes: 100, // 触发 ASSET_OVERSIZE
          });
        },
        (err) => err.code === "ASSET_OVERSIZE", // 原始错误码必须保留，不被 cancelError 覆盖
        "原始错误码必须保持为 ASSET_OVERSIZE"
      );
    });

    it("reader.cancel() 永不结算也不阻塞超限错误", async () => {
      const startedAt = Date.now();
      const response = {
        status: 200,
        headers: { get: (name) => name === "content-type" ? "image/png" : null },
        body: { getReader: () => ({
          read: async () => ({ done: false, value: Buffer.alloc(2) }),
          cancel: () => new Promise(() => {}),
          releaseLock() {},
        }) },
      };
      await assert.rejects(ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/oversize.png",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
        fetchImpl: async () => response, maxBytes: 1, timeoutMs: 1000,
      }), (error) => error.code === "ASSET_OVERSIZE");
      assert.ok(Date.now() - startedAt < 300);
    });

    it("流超时后中止底层 fetch 信号", async () => {
      let fetchSignal;
      const response = {
        status: 200,
        headers: { get: (name) => name === "content-type" ? "image/png" : null },
        body: { getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
          releaseLock() {},
        }) },
      };
      await assert.rejects(ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/hang.png",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
        fetchImpl: async (_url, init) => { fetchSignal = init.signal; return response; },
        timeoutMs: 25,
      }), (error) => error.code === "INGEST_TIMEOUT");
      assert.equal(fetchSignal.aborted, true);
    });

    it("fetch 网络错误被脱敏封装为 FETCH_NETWORK_ERROR", async () => {
      const mockFetch = async () => {
        throw new Error("getaddrinfo ENOTFOUND api.powertokens.ai");
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/network-error.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
          });
        },
        (err) => err.code === "FETCH_NETWORK_ERROR"
      );
    });

    it("外部 AbortSignal 触发时抛出 INGEST_ABORTED", async () => {
      const controller = new AbortController();
      controller.abort();

      const mockFetch = async (_url, init) => {
        if (init.signal.aborted) {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        return createMockResponse({ status: 200 });
      };

      await assert.rejects(
        async () => {
          await ingestMediaAssetCandidate({
            resultUrl: "https://api.powertokens.ai/aborted.jpg",
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: mockFetch,
            signal: controller.signal,
          });
        },
        (err) => err.code === "INGEST_ABORTED"
      );
    });
  });

  describe("9. 敏感信息脱敏与零泄露 (Zero Secret Disclosure)", () => {
    it("无论何种异常，错误信息与错误属性中均不得包含 URL Query 中的签名 Token", async () => {
      const SENSITIVE_SECRET = "super-secret-presigned-token-xyz-987654321";
      const sensitiveUrl = `https://api.powertokens.ai/fail?token=${SENSITIVE_SECRET}&sig=abcdef`;

      const testCases = [
        {
          name: "HTTP 500 报错",
          fetch: async () => createMockResponse({ status: 500 }),
        },
        {
          name: "重定向 302 报错",
          fetch: async () => createMockResponse({ status: 302 }),
        },
        {
          name: "MIME 错配报错",
          fetch: async () =>
            createMockResponse({
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
        },
        {
          name: "超限报错",
          fetch: async () =>
            createMockResponse({
              status: 200,
              headers: { "content-type": "image/png" },
              chunks: [Buffer.alloc(200)],
            }),
          maxBytes: 100,
        },
      ];

      for (const tc of testCases) {
        try {
          await ingestMediaAssetCandidate({
            resultUrl: sensitiveUrl,
            expectedKind: "image",
            allowedHosts: ALLOWED_HOSTS,
            fetchImpl: tc.fetch,
            maxBytes: tc.maxBytes,
          });
          assert.fail(`Case '${tc.name}' 应抛错但未抛错`);
        } catch (err) {
          const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.equal(
            serialized.includes(SENSITIVE_SECRET),
            false,
            `错误对象泄露了敏感 Query: ${tc.name}`
          );
          assert.equal(
            err.message.includes(SENSITIVE_SECRET),
            false,
            `错误 message 泄露了敏感 Query: ${tc.name}`
          );
        }
      }
    });

    it("异常状态值不进入错误消息", async () => {
      const marker = "secret-in-status";
      await assert.rejects(ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/status",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
        fetchImpl: async () => ({ status: `500-${marker}` }),
      }), (error) => error.code === "INVALID_RESPONSE" && !error.message.includes(marker));
    });

    it("上游伪造的错误码和消息不能穿透 fetch 或 stream 边界", async () => {
      const secret = "secret-in-upstream-error";
      const injected = Object.assign(new Error(secret), { code: "INGEST_TIMEOUT" });
      const base = {
        resultUrl: "https://api.powertokens.ai/pic.png",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
      };
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => { throw injected; } }),
        (error) => error.code === "FETCH_NETWORK_ERROR" && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret));
      const body = { getReader: () => ({
        read: async () => { throw injected; },
        cancel: async () => {}, releaseLock: () => {},
      }) };
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => createMockResponse({
        headers: { "content-type": "image/png" }, body,
      }) }), (error) => error.code === "STREAM_READ_ERROR" && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret));
    });

    it("响应头和 reader 获取阶段的上游异常被固定错误替代", async () => {
      const secret = "secret-in-response-accessor";
      const base = {
        resultUrl: "https://api.powertokens.ai/pic.png",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
      };
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => ({
        status: 200, headers: { get: () => { throw new Error(secret); } },
      }) }), (error) => error.code === "INVALID_RESPONSE_HEADERS" && !error.message.includes(secret));
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => ({
        status: 200, headers: { get: () => "image/png" },
        body: { getReader: () => { throw new Error(secret); } },
      }) }), (error) => error.code === "UNSUPPORTED_RESPONSE_BODY" && !error.message.includes(secret));
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => ({
        get status() { throw new Error(secret); },
      }) }), (error) => error.code === "INVALID_RESPONSE" && !error.message.includes(secret));
      await assert.rejects(ingestMediaAssetCandidate({ ...base, fetchImpl: async () => ({
        status: 200, headers: { get: () => "image/png" },
        get body() { throw new Error(secret); },
      }) }), (error) => error.code === "UNSUPPORTED_RESPONSE_BODY" && !error.message.includes(secret));
    });

    it("非二进制 stream chunk 以固定错误拒绝", async () => {
      const body = { getReader: () => ({
        read: async () => ({ done: false, value: { length: 1, secret: "chunk-secret" } }),
        cancel: async () => {}, releaseLock: () => {},
      }) };
      await assert.rejects(ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/pic.png",
        expectedKind: "image", allowedHosts: ALLOWED_HOSTS,
        fetchImpl: async () => createMockResponse({ headers: { "content-type": "image/png" }, body }),
      }), (error) => error.code === "INVALID_STREAM_CHUNK" && !error.message.includes("chunk-secret"));
    });

    it("成功返回的对象中只包含安全元数据与 Buffer，不包含原 URL 或请求头", async () => {
      const sample = Buffer.from("clean-test-data");
      const mockFetch = async () => {
        return createMockResponse({
          status: 200,
          headers: { "content-type": "image/png" },
          chunks: [sample],
        });
      };

      const result = await ingestMediaAssetCandidate({
        resultUrl: "https://api.powertokens.ai/pic.png?secret_access_key=PRIVATE",
        expectedKind: "image",
        allowedHosts: ALLOWED_HOSTS,
        fetchImpl: mockFetch,
      });

      const keys = Object.keys(result);
      assert.deepEqual(keys.sort(), ["buffer", "byteCount", "mime", "sha256"]);
      assert.equal(result.url, undefined);
      assert.equal(result.headers, undefined);
    });
  });
});

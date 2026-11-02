import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const packageRoot = new URL("../../shell/node_modules/@deepseek-ai/dsh-llm-pi-ai/", import.meta.url);
const adapterPackage = JSON.parse(fs.readFileSync(new URL("package.json", packageRoot), "utf8"));
const piAiPackage = JSON.parse(fs.readFileSync(new URL("../../@earendil-works/pi-ai/package.json", packageRoot), "utf8"));
const lock = JSON.parse(fs.readFileSync(new URL("../../shell/package-lock.json", import.meta.url), "utf8"));
const adapterLock = lock.packages["node_modules/@deepseek-ai/dsh-llm-pi-ai"];
const piAiLock = lock.packages["node_modules/@earendil-works/pi-ai"];
const { apply } = await import(new URL("lib/index.js", packageRoot));

test("installed DSH pi-ai adapter and pi-ai match exact lock provenance", () => {
  assert.equal(adapterPackage.version, "0.1.1-rc.2");
  assert.equal(adapterLock.version, adapterPackage.version);
  assert.match(adapterLock.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(adapterLock.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);

  assert.equal(adapterPackage.dependencies["@earendil-works/pi-ai"], "^0.82.1");
  assert.equal(piAiPackage.version, "0.82.1");
  assert.equal(piAiLock.version, piAiPackage.version);
  assert.match(piAiLock.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(piAiLock.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
});

test("hand-declared provider without an endpoint fails with provider and model context", () => {
  const apiKey = "synthetic-do-not-log-api-key";
  const config = {
    providers: {
      "pt-gateway": {
        api: "openai-completions",
        apiKey,
        models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  };

  assert.throws(() => apply({}, config), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /provider "pt-gateway" model "fixture-model" needs a baseURL/);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(apiKey));
    return true;
  });
});

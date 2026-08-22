import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const bridge = readFileSync(join(root, "extension/content/chatgpt-usage.js"), "utf8");
const pageBridge = readFileSync(join(root, "extension/content/chatgpt-usage-page.js"), "utf8");
const popup = readFileSync(join(root, "extension/popup/popup.js"), "utf8");
const source = [
  "src/chatgpt-containers.js",
  "src/codex-usage.js",
  "content/chatgpt-usage-page.js",
  "content/chatgpt-usage.js",
  "usage/usage.js"
].map((file) => readFileSync(join(root, "extension", file), "utf8")).join("\n");

describe("ChatGPT usage security boundaries", () => {
  it("keeps the bridge on one fixed endpoint and message shape", () => {
    assert.equal((bridge.match(/https:\/\/chatgpt\.com\/backend-api\/wham\/usage/g) || []).length, 1);
    assert.equal((pageBridge.match(/https:\/\/chatgpt\.com\/backend-api\/wham\/usage/g) || []).length, 1);
    assert.equal((pageBridge.match(/https:\/\/chatgpt\.com\/api\/auth\/session/g) || []).length, 1);
    assert.match(bridge, /message\.type !== MESSAGE_TYPE/);
    assert.match(bridge, /method: "GET"/);
    assert.match(bridge, /credentials: "include"/);
    assert.doesNotMatch(bridge, /message\.(url|method|headers|body)/);
    assert.doesNotMatch(bridge, /fetch\(\s*message/);
    assert.doesNotMatch(pageBridge, /browser\.|chrome\.|message\.(url|method|headers|body)|document\.cookie|localStorage|sessionStorage/);
    assert.match(bridge, /isolatedResult\.status !== 401/);
  });

  it("declares the fixed page fallback in MAIN world without broader permissions", () => {
    const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    assert.deepEqual(mainScript.js, ["content/chatgpt-usage-page.js"]);
    assert.deepEqual(mainScript.matches, ["https://chatgpt.com/*"]);
    for (const forbidden of ["scripting", "tabs", "webRequest", "tabHide"]) {
      assert.equal(manifest.permissions.includes(forbidden), false);
    }
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, [
      "authenticationInfo",
      "personallyIdentifyingInfo",
      "websiteContent"
    ]);
  });

  it("keeps ChatGPT access-token handling inside the page bridge", () => {
    assert.doesNotMatch(source, /cookies\.(get|getAll|remove)/i);
    assert.doesNotMatch(bridge, /accessToken|authorization\s*:/i);
    assert.doesNotMatch(readFileSync(join(root, "extension/src/chatgpt-containers.js"), "utf8"), /accessToken|authorization\s*:/i);
    assert.match(pageBridge, /authorization: `Bearer \$\{accessToken\}`/);
    assert.doesNotMatch(pageBridge, /storage\.|browser\.|chrome\.|console\.|localStorage|sessionStorage|document\.cookie/);
  });

  it("caps streamed usage payloads before retaining their full body", () => {
    const isolated = readFileSync(join(root, "extension/content/chatgpt-usage.js"), "utf8");
    const pageBridge = readFileSync(join(root, "extension/content/chatgpt-usage-page.js"), "utf8");
    for (const source of [isolated, pageBridge]) {
      assert.match(source, /response\.body\.getReader\(\)/);
      assert.match(source, /total > MAX_RESPONSE_BYTES/);
      assert.match(source, /reader\.cancel\(\)/);
    }
  });

  it("renders popup usage from local snapshots without another ChatGPT request", () => {
    assert.match(popup, /getSetting\(CHATGPT_ACCOUNTS_KEY/);
    assert.match(popup, /normalizeChatGptAccounts/);
    assert.match(popup, /Next allowance refresh/);
    assert.match(popup, /Last update/);
    assert.doesNotMatch(popup, /chatgpt-containers|backend-api\/wham\/usage|api\/auth\/session/);
  });

  it("keeps fixtures redacted and avoids raw identity fields in normalized data", () => {
    const fixture = readFileSync(join(root, "test/codex-usage.test.js"), "utf8");
    assert.match(fixture, /example\.invalid/);
    assert.match(fixture, /redacted-(user|account)-id/);
    assert.doesNotMatch(fixture, /@(?:gmail|outlook|yahoo)\./i);
  });
});

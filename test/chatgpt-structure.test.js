import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const service = readFileSync(join(root, "extension/src/chatgpt-usage-service.js"), "utf8");
const popup = readFileSync(join(root, "extension/popup/popup.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));

describe("ChatGPT usage security boundaries", () => {
  it("uses only the fixed session and usage endpoints", () => {
    assert.equal((service.match(/https:\/\/chatgpt\.com\/backend-api\/wham\/usage/g) || []).length, 1);
    assert.equal((service.match(/https:\/\/chatgpt\.com\/api\/auth\/session/g) || []).length, 1);
    assert.match(service, /method: "GET"/);
    assert.match(service, /credentials: "include"/);
    assert.doesNotMatch(service, /fetch\(\s*(message|url)/);
  });

  it("declares no ChatGPT content scripts, container permission, or cookie permission", () => {
    assert.equal("content_scripts" in manifest, false);
    for (const forbidden of ["contextualIdentities", "cookies", "scripting", "tabs", "webRequest", "tabHide"]) {
      assert.equal(manifest.permissions.includes(forbidden), false);
    }
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, [
      "authenticationInfo",
      "personallyIdentifyingInfo",
      "websiteContent"
    ]);
  });

  it("keeps access-token handling inside the direct service and out of durable state", () => {
    assert.match(service, /authorization: `Bearer \$\{accessToken\}`/);
    assert.doesNotMatch(service, /console\.|localStorage|sessionStorage|document\.cookie|cookies\.(get|getAll|remove)/i);
    assert.doesNotMatch(service, /snapshot:\s*\{[^}]*accessToken/s);
    assert.doesNotMatch(popup, /accessToken|authorization\s*:/i);
  });

  it("caps responses before parsing and stores normalized snapshots", () => {
    assert.match(service, /MAX_RESPONSE_BYTES/);
    assert.match(service, /TextEncoder\(\)\.encode\(text\)\.byteLength/);
    assert.match(service, /normalizeUsageResponse/);
    assert.doesNotMatch(service, /rawBody|raw_response/);
  });

  it("renders both popup windows from one local snapshot and refreshes directly on open", () => {
    assert.match(popup, /getChatGptUsageState/);
    assert.match(popup, /label: "5h"/);
    assert.match(popup, /label: "Week"/);
    assert.match(popup, /refreshChatGptUsage/);
    assert.match(popup, /chatgpt-usage-refresh/);
    assert.doesNotMatch(popup, /backend-api\/wham\/usage|api\/auth\/session|queryChatGptTabs|createTab/);
  });

  it("keeps fixtures redacted", () => {
    const fixtures = [
      readFileSync(join(root, "test/codex-usage.test.js"), "utf8"),
      readFileSync(join(root, "test/chatgpt-usage-service.test.js"), "utf8")
    ].join("\n");
    assert.match(fixtures, /example\.invalid|redacted-account-id/);
    assert.doesNotMatch(fixtures, /@(?:gmail|outlook|yahoo)\./i);
  });
});

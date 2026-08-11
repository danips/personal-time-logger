import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeChatGptAccounts } from "../src/chatgpt-account-cache.js";

describe("ChatGPT account cache", () => {
  it("preserves valid account records while ignoring malformed cache values", () => {
    const first = { id: "first", label: "First" };
    const second = { id: "second", label: "Second" };

    assert.deepEqual(normalizeChatGptAccounts([first, null, "invalid", [], second]), [first, second]);
    assert.deepEqual(normalizeChatGptAccounts({}), []);
    assert.deepEqual(normalizeChatGptAccounts(null), []);
  });
});

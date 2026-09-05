import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readBoundedJson } from "../extension/src/bounded-json.js";

const boundaryError = (reason) => Object.assign(new Error(reason), { code: "BOUNDED_JSON" });

describe("bounded JSON reader", () => {
  it("rejects an oversized declared body before reading it", async () => {
    let read = false;
    const response = {
      headers: new Headers({ "Content-Length": "11" }),
      async text() { read = true; return "{}"; }
    };

    await assert.rejects(() => readBoundedJson(response, 10, boundaryError), { code: "BOUNDED_JSON" });
    assert.equal(read, false);
  });

  it("cancels a chunked response after it crosses the byte limit", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too large"}'));
      },
      cancel() { cancelled = true; }
    }));

    await assert.rejects(() => readBoundedJson(response, 10, boundaryError), { code: "BOUNDED_JSON" });
    assert.equal(cancelled, true);
  });
});

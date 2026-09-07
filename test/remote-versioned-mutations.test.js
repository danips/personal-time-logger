import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEntry } from "../extension/src/entries.js";
import { createVersionedMutationOperations } from "../extension/src/remote-versioned-mutations.js";

const fixture = (id) => normalizeEntry({
  id, project: "Project", task: "Task", description: "Description",
  start_at: "2026-09-07T09:00:00.000Z", end_at: "2026-09-07T10:00:00.000Z",
  duration_seconds: 3600, status: "ok", created_at: "2026-09-07T09:00:00.000Z",
  updated_at: "2026-09-07T10:00:00.000Z", deleted_at: "", device_id: "device", revision: 1, multiply: ""
});

describe("versioned provider mutations", () => {
  it("does not create a client for empty entry batches", async () => {
    let clientCalls = 0;
    const operations = createVersionedMutationOperations({
      configuredClient: async () => { clientCalls += 1; return {}; },
      chunkOptions: { maxBytes: 1024 }, entryRefKind: "test-row"
    });
    assert.deepEqual(await operations.appendEntries([]), []);
    await operations.updateEntries([]);
    await operations.deleteEntries([]);
    assert.equal(clientCalls, 0);
  });

  it("preserves acknowledgement order after chunking", async () => {
    const entries = [fixture("first"), fixture("second")];
    const operations = createVersionedMutationOperations({
      configuredClient: async () => ({
        async append(values) {
          return { entries: [...values].reverse().map((entry, index) => ({ id: entry.id, version: index + 1 })) };
        }
      }),
      chunkOptions: { maxBytes: 10_000 }, entryRefKind: "test-row"
    });
    const acknowledgements = await operations.appendEntries(entries);
    assert.deepEqual(acknowledgements.map(({ id }) => id), ["first", "second"]);
  });
});

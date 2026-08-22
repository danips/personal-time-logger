import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { entryFingerprint, normalizeReconciliationCommand } from "../extension/src/reconcile.js";
import { normalizeEntry } from "../extension/src/entries.js";

const code = readFileSync(join(process.cwd(), "extension/src/reconcile.js"), "utf8");
const remote = normalizeEntry({
  id: "remote",
  project: "Project",
  task: "Task",
  start_at: "2026-08-08T09:00:00.000Z",
  end_at: "2026-08-08T10:00:00.000Z",
  duration_seconds: 3600,
  created_at: "2026-08-08T09:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
  revision: 3
});

describe("reconciliation command model", () => {
  it("represents present and absent expectations without undefined overloading", () => {
    const localChoice = normalizeReconciliationCommand({
      action: "keepLocal",
      id: "remote",
      expectedRevision: 2,
      remoteEntry: remote
    });
    assert.deepEqual(localChoice.local, { kind: "present", revision: 2 });
    assert.deepEqual(localChoice.remote, { kind: "present", fingerprint: entryFingerprint(remote) });

    const remoteOnlyDelete = normalizeReconciliationCommand({
      action: "deleteEverywhere",
      id: "remote",
      remoteEntry: remote
    });
    assert.deepEqual(remoteOnlyDelete.local, { kind: "absent" });
    assert.deepEqual(remoteOnlyDelete.remote, { kind: "present", fingerprint: entryFingerprint(remote) });

    const localOnlyDelete = normalizeReconciliationCommand({
      action: "deleteEverywhere",
      id: "local",
      expectedLocalRevision: 4
    });
    assert.deepEqual(localOnlyDelete.local, { kind: "present", revision: 4 });
    assert.deepEqual(localOnlyDelete.remote, { kind: "absent" });
  });

  it("routes both entrypoints through one local transition owner", () => {
    assert.equal((code.match(/function applyReconciliationCommand/g) || []).length, 1);
    assert.match(code, /return applyReconciliationCommand\(command/);
    assert.match(code, /applyReconciliationCommand\(resolution/);
    assert.match(code, /function replaceReconciliationIntent/);
  });
});

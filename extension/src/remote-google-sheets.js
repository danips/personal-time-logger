import {
  appendRemoteEntries,
  deleteRemoteRows,
  ensureAppMarker,
  getDriveGateDiagnostics,
  getRemoteModifiedTime,
  getSpreadsheetBinding,
  isSpreadsheetGone,
  provisionSpreadsheet,
  readySpreadsheetBinding,
  readRemoteSnapshot,
  updateRemoteConfig,
  updateRemoteEntries
} from "./sheets.js";
import { SETTING_KEY } from "./setting-keys.js";

const ENTRY_REF_KIND = "google-sheet-row";
const CONFIG_REF_KIND = "google-config-row";

function entryRef(rowIndex, fingerprint = "") {
  return { kind: ENTRY_REF_KIND, rowIndex, fingerprint };
}

function configRef(rowIndex, fingerprint = "") {
  return { kind: CONFIG_REF_KIND, rowIndex, fingerprint };
}

function toEntryPrecondition({ entry, expectedRef }) {
  return {
    rowIndex: expectedRef?.rowIndex || 0,
    id: entry.id,
    expectedFingerprint: expectedRef?.fingerprint || ""
  };
}

function toDeletePrecondition({ id, expectedRef, rowIndex, expectedFingerprint }) {
  return {
    rowIndex: expectedRef?.rowIndex || rowIndex || 0,
    id,
    expectedFingerprint: expectedRef?.fingerprint || expectedFingerprint || ""
  };
}

function mapSnapshot(snapshot) {
  const entryRefs = new Map();
  for (const entry of snapshot.entries) {
    const rowIndex = snapshot.rowMap.get(entry.id);
    if (rowIndex) entryRefs.set(entry.id, entryRef(rowIndex, snapshotEntryFingerprint(entry)));
  }

  const duplicates = (snapshot.duplicates || []).map((duplicate) => {
    const keepRow = duplicate.keepRow
      ? { ...duplicate.keepRow, ref: entryRef(duplicate.keepRow.rowIndex, duplicate.keepRow.expectedFingerprint) }
      : null;
    const extraRows = (duplicate.extraRows || []).map((row) => ({
      ...row,
      ref: entryRef(row.rowIndex, row.expectedFingerprint)
    }));
    return {
      ...duplicate,
      keepRow,
      extraRows,
      keepRef: keepRow?.ref || null,
      extraRefs: extraRows.map((row) => row.ref),
      records: [keepRow, ...extraRows].map((row) => ({
      entry: row.entry || duplicate.entry,
        ref: row.ref
      }))
    };
  });

  const configRefs = new Map();
  for (const [key, row] of snapshot.configRows) {
    configRefs.set(key, configRef(row.rowIndex, row.expectedFingerprint));
  }

  return {
    entries: snapshot.entries,
    entryRefs,
    duplicates,
    quarantined: snapshot.quarantined,
    config: snapshot.config,
    configRefs,
    changeToken: ""
  };
}

export const googleSheetsProvider = Object.freeze({
  id: "google-sheets",
  label: "Google Sheets",
  capabilities: Object.freeze({
    duplicateRemoteRecords: true
  }),

  async ensureReady({ interactiveAuth = false, lease, reseed } = {}) {
    const binding = await getSpreadsheetBinding();
    if (binding.state === "ready") return null;
    await lease?.assert();
    const provisioned = await provisionSpreadsheet({ interactiveAuth });
    await lease?.assert();
    await reseed?.(provisioned.spreadsheetId);
    return provisioned;
  },

  async tryRecoverMissingRemote(error, { interactiveAuth = false, lease, reseed } = {}) {
    if (error?.code !== "API_ERROR" && error?.code !== "SHEET_MISSING") return null;
    if (!await isSpreadsheetGone({ interactiveAuth })) return null;
    await lease?.assert();
    const provisioned = await provisionSpreadsheet({ interactiveAuth });
    await lease?.assert();
    await reseed?.(provisioned.spreadsheetId);
    return provisioned;
  },

  async getChangeToken({ interactiveAuth = false } = {}) {
    return getRemoteModifiedTime({ interactiveAuth });
  },

  getChangeTokenDiagnostics() {
    return getDriveGateDiagnostics();
  },

  async readSnapshot({ interactiveAuth = false } = {}) {
    return mapSnapshot(await readRemoteSnapshot({ interactiveAuth }));
  },

  async appendEntries(entries, { interactiveAuth = false } = {}) {
    const mappings = await appendRemoteEntries(entries, { interactiveAuth });
    return mappings.map(({ id, rowIndex }) => ({ id, ref: entryRef(rowIndex) }));
  },

  async updateEntries(updates, { interactiveAuth = false } = {}) {
    return updateRemoteEntries(updates.map(toEntryPrecondition).map((precondition, index) => ({
      ...precondition,
      entry: updates[index].entry
    })), { interactiveAuth });
  },

  async deleteEntries(preconditions, { interactiveAuth = false } = {}) {
    return deleteRemoteRows(preconditions.map((precondition) => toDeletePrecondition(precondition)), { interactiveAuth });
  },

  async updateConfig(key, value, updatedAt, { expectedRef, interactiveAuth = false } = {}) {
    return updateRemoteConfig(key, value, updatedAt, {
      rowIndex: expectedRef?.rowIndex || 0,
      expectedFingerprint: expectedRef?.fingerprint || "",
      interactiveAuth
    });
  },

  async ensureAppMarker(config, configRefs, { interactiveAuth = false } = {}) {
    const configRows = new Map();
    for (const [key, ref] of configRefs) {
      configRows.set(key, {
        rowIndex: ref.rowIndex,
        expectedFingerprint: ref.fingerprint
      });
    }
    return ensureAppMarker(config, configRows, { interactiveAuth });
  },

  applyReseedSettings(settings, spreadsheetId) {
    if (!spreadsheetId) return;
    const binding = settings.get(SETTING_KEY.SPREADSHEET_ID);
    settings.set(SETTING_KEY.SPREADSHEET_ID, readySpreadsheetBinding(binding, spreadsheetId));
  }
});

function snapshotEntryFingerprint(entry) {
  return [
    entry.id,
    entry.project,
    entry.task,
    entry.description,
    entry.start_at,
    entry.end_at,
    entry.duration_seconds,
    entry.status,
    entry.created_at,
    entry.updated_at,
    entry.deleted_at,
    entry.device_id,
    entry.revision,
    entry.multiply
  ].join("\u0000");
}

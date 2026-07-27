import { getSetting, setSetting } from "./db.js";
import { getAccessToken } from "./auth.js";
import { getConfig } from "./config-loader.js";
import { SHEET_HEADERS, entryToRow, rowToEntry } from "./entries.js";
import { platform } from "./platform.js";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEET_NAME = "time_entries";
const FULL_RANGE = `${SHEET_NAME}!A:Q`;
const HEADER_RANGE = `${SHEET_NAME}!A1:Q1`;
const CONFIG_SHEET_NAME = "config";
const CONFIG_FULL_RANGE = `${CONFIG_SHEET_NAME}!A:C`;
const CONFIG_HEADER_RANGE = `${CONFIG_SHEET_NAME}!A1:C1`;
const CONFIG_HEADERS = ["key", "value", "updated_at"];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeRange(range) {
  return encodeURIComponent(range);
}

function headersMatch(row) {
  return SHEET_HEADERS.length === row.length && SHEET_HEADERS.every((header, index) => row[index] === header);
}

// Sheet layout rarely changes, so the tab check and its numeric id are cached
// per spreadsheet instead of costing a metadata request on every read or delete.
let ensuredSpreadsheetId = "";
let ensuredConfigSpreadsheetId = "";
let cachedSheetIdSpreadsheet = "";
let cachedSheetId = null;
// Set once Drive refuses the metadata lookup. Without it a permanent refusal
// would cost a wasted request on every cycle on top of the read it fails to
// avoid. Cleared when the spreadsheet changes, and on the next context load.
let driveGateUnavailable = false;

function resetSheetCache() {
  ensuredSpreadsheetId = "";
  ensuredConfigSpreadsheetId = "";
  cachedSheetIdSpreadsheet = "";
  cachedSheetId = null;
  driveGateUnavailable = false;
}

async function apiFetch(path, options = {}, { interactiveAuth = false, baseUrl = API_BASE } = {}) {
  if (!platform.isOnline()) throw codedError("OFFLINE", "Network is offline");
  const token = await getAccessToken({ interactive: interactiveAuth });
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? (() => {
    try {
      return JSON.parse(text);
    } catch (error) {
      return { error: { message: text } };
    }
  })() : {};

  if (response.status === 401) throw codedError("AUTH_EXPIRED", "Google auth expired");
  if (response.status === 429) throw codedError("RATE_LIMIT", "Google API quota or rate limit");
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : `Google API error ${response.status}`;
    if (response.status === 403) {
      if (/quota|rate|limit/i.test(message)) throw codedError("RATE_LIMIT", "Google API quota or rate limit");
      if (/insufficient|scope/i.test(message)) throw codedError("SCOPE_MISSING", message);
      throw codedError("API_ERROR", `Google Sheets permission error: ${message}`);
    }
    if (/Unable to parse range|not found/i.test(message) && /time_entries/i.test(message)) {
      throw codedError("SHEET_MISSING", "Sheet tab time_entries is missing");
    }
    throw codedError("API_ERROR", message);
  }

  return data;
}

export async function getSpreadsheetId() {
  return getSetting("spreadsheet_id", "");
}

export async function setSpreadsheetId(spreadsheetId) {
  resetSheetCache();
  return setSetting("spreadsheet_id", String(spreadsheetId || "").trim());
}

export async function createOrInitializeSpreadsheet({ interactiveAuth = true } = {}) {
  let spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) {
    const created = await apiFetch("", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: "Personal Time Logger" },
        sheets: [{ properties: { title: SHEET_NAME } }]
      })
    }, { interactiveAuth });
    spreadsheetId = created.spreadsheetId;
    await setSpreadsheetId(spreadsheetId);
  }

  await ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth });
  await ensureConfigSheet(spreadsheetId, { interactiveAuth }).catch(() => {});
  return { spreadsheetId };
}

async function ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth = false } = {}) {
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  if (ensuredSpreadsheetId === spreadsheetId) return;

  const metadata = await apiFetch(`/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`, {}, { interactiveAuth });
  const existingSheet = (metadata.sheets || []).find((sheet) => sheet.properties && sheet.properties.title === SHEET_NAME);
  let sheetId = existingSheet && existingSheet.properties ? existingSheet.properties.sheetId : null;

  if (sheetId == null) {
    const added = await apiFetch(`/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
      })
    }, { interactiveAuth });
    sheetId = added.replies && added.replies[0] && added.replies[0].addSheet
      ? added.replies[0].addSheet.properties.sheetId
      : null;
  }

  const headerData = await apiFetch(`/${spreadsheetId}/values/${encodeRange(HEADER_RANGE)}`, {}, { interactiveAuth })
    .catch((error) => {
      if (error.code === "SHEET_MISSING") return { values: [] };
      throw error;
    });
  const headerRow = headerData.values && headerData.values[0] ? headerData.values[0] : [];

  if (!headersMatch(headerRow)) {
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(HEADER_RANGE)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [SHEET_HEADERS] })
    }, { interactiveAuth });
  }

  if (sheetId != null) {
    cachedSheetIdSpreadsheet = spreadsheetId;
    cachedSheetId = sheetId;
  }
  ensuredSpreadsheetId = spreadsheetId;
}

async function ensureConfigSheet(spreadsheetId, { interactiveAuth = false } = {}) {
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  if (ensuredConfigSpreadsheetId === spreadsheetId) return;

  const metadata = await apiFetch(`/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`, {}, { interactiveAuth });
  const existingSheet = (metadata.sheets || []).find((sheet) => sheet.properties && sheet.properties.title === CONFIG_SHEET_NAME);

  if (!existingSheet) {
    await apiFetch(`/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: CONFIG_SHEET_NAME } } }]
      })
    }, { interactiveAuth });
  }

  const headerData = await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_HEADER_RANGE)}`, {}, { interactiveAuth })
    .catch((error) => {
      if (error.code === "SHEET_MISSING") return { values: [] };
      throw error;
    });
  const headerRow = headerData.values && headerData.values[0] ? headerData.values[0] : [];

  if (JSON.stringify(headerRow) !== JSON.stringify(CONFIG_HEADERS)) {
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_HEADER_RANGE)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [CONFIG_HEADERS] })
    }, { interactiveAuth });
  }

  ensuredConfigSpreadsheetId = spreadsheetId;
}

function rowsToConfig(rows) {
  const config = {};
  const configRows = new Map();
  (rows || []).slice(1).forEach((row, index) => {
    const key = row[0] == null ? "" : String(row[0]);
    if (!key) return;
    config[key] = {
      value: row[1] == null ? "" : String(row[1]),
      updated_at: row[2] == null ? "" : String(row[2])
    };
    configRows.set(key, index + 2);
  });
  return { config, configRows };
}

/**
 * Writes one config key. `rowIndex` comes from the snapshot, so no extra read is
 * needed; 0 means the key is not in the sheet yet and the row is appended.
 */
export async function updateRemoteConfig(key, value, updatedAt, { rowIndex = 0, interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return;

  await ensureConfigSheet(spreadsheetId, { interactiveAuth });

  if (rowIndex > 0) {
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A${rowIndex}:C${rowIndex}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [[key, value, updatedAt]] })
    }, { interactiveAuth });
    return;
  }

  await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A:C`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [[key, value, updatedAt]] })
  }, { interactiveAuth });
}

/**
 * Last modification time of the spreadsheet file, used to skip reads when
 * nothing changed remotely. Returns "" whenever Drive cannot answer: token
 * issued before the drive.file scope (403), a spreadsheet the extension did not
 * create so drive.file does not cover it (404), or the Drive API not enabled on
 * the project. Callers must then read unconditionally.
 */
export async function getRemoteModifiedTime({ interactiveAuth = false } = {}) {
  if (driveGateUnavailable) return "";
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  try {
    const data = await apiFetch(
      `/files/${spreadsheetId}?fields=modifiedTime&supportsAllDrives=true`,
      {},
      { interactiveAuth, baseUrl: DRIVE_API_BASE }
    );
    return data && data.modifiedTime ? String(data.modifiedTime) : "";
  } catch (error) {
    if (error.code === "AUTH_EXPIRED" || error.code === "OFFLINE" || error.code === "RATE_LIMIT") throw error;
    // Missing scope, a spreadsheet drive.file does not cover, a disabled Drive
    // API, or an unexpected shape. Stop asking and read unconditionally instead
    // of failing the sync.
    driveGateUnavailable = true;
    return "";
  }
}

const MAX_COPY_ROWS_PER_REQUEST = 2000;

/**
 * Appends rows in chunks and returns how many rows Google reports writing.
 * Append is used rather than a plain update because it grows the grid, which a
 * freshly created spreadsheet (1000 rows by default) needs for a long history.
 */
async function appendRows(spreadsheetId, range, rows, { interactiveAuth }) {
  let written = 0;
  for (let index = 0; index < rows.length; index += MAX_COPY_ROWS_PER_REQUEST) {
    const chunk = rows.slice(index, index + MAX_COPY_ROWS_PER_REQUEST);
    const data = await apiFetch(
      `/${spreadsheetId}/values/${encodeRange(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: chunk }) },
      { interactiveAuth }
    );
    written += data && data.updates ? Number(data.updates.updatedRows || 0) : 0;
  }
  return written;
}

/**
 * Copies the current spreadsheet's contents into a brand new spreadsheet created
 * by this extension, then points the stored ID at the copy.
 *
 * The point is ownership: drive.file only covers files the extension created, and
 * there is no way to claim an existing file, so a spreadsheet whose ID was pasted
 * in by hand can never answer the modifiedTime check used to skip reads.
 *
 * The source spreadsheet is never modified, and the stored ID is switched only
 * after Google confirms every row was written, so a failure part way through
 * leaves the existing setup working.
 */
export async function copyToOwnedSpreadsheet({ interactiveAuth = true } = {}) {
  const sourceId = await getSpreadsheetId();
  if (!sourceId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  const readSource = async (ranges) => {
    const query = [
      ...ranges.map((range) => `ranges=${encodeRange(range)}`),
      "valueRenderOption=UNFORMATTED_VALUE",
      "fields=valueRanges(range,values)"
    ].join("&");
    return apiFetch(`/${sourceId}/values:batchGet?${query}`, {}, { interactiveAuth });
  };

  // A spreadsheet set up before the config tab existed has no config range, and
  // batchGet rejects the whole request for an unknown range.
  const source = await readSource([FULL_RANGE, CONFIG_FULL_RANGE])
    .catch(() => readSource([FULL_RANGE]));

  const asText = (rows) => (rows || []).map((row) => (row || []).map((cell) => (cell == null ? "" : String(cell))));
  const entryRows = asText(valuesForRange(source.valueRanges, SHEET_NAME));
  const configRows = asText(valuesForRange(source.valueRanges, CONFIG_SHEET_NAME));
  if (!headersMatch(entryRows[0] || [])) {
    throw codedError("SHEET_MISSING", "The current time_entries tab header row is missing or invalid, so it cannot be copied.");
  }

  const entryBody = entryRows.slice(1).filter((row) => row[0]);
  const configBody = configRows.slice(1).filter((row) => row[0]);

  const created = await apiFetch("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: `Personal Time Logger (${new Date().toISOString().slice(0, 10)})` },
      sheets: [
        { properties: { title: SHEET_NAME } },
        { properties: { title: CONFIG_SHEET_NAME } }
      ]
    })
  }, { interactiveAuth });

  const targetId = created.spreadsheetId;
  if (!targetId) throw codedError("API_ERROR", "Google did not return an ID for the new spreadsheet");

  await apiFetch(`/${targetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        { range: HEADER_RANGE, values: [SHEET_HEADERS] },
        { range: CONFIG_HEADER_RANGE, values: [CONFIG_HEADERS] }
      ]
    })
  }, { interactiveAuth });

  const copiedEntries = await appendRows(targetId, FULL_RANGE, entryBody, { interactiveAuth });
  const copiedConfig = await appendRows(targetId, CONFIG_FULL_RANGE, configBody, { interactiveAuth });

  if (copiedEntries !== entryBody.length || copiedConfig !== configBody.length) {
    throw codedError(
      "API_ERROR",
      `Copy incomplete: ${copiedEntries} of ${entryBody.length} entry rows written to spreadsheet ${targetId}. The current spreadsheet is unchanged and still in use.`
    );
  }

  await setSpreadsheetId(targetId);
  return { spreadsheetId: targetId, previousSpreadsheetId: sourceId, rowCount: copiedEntries };
}

export async function testConnection({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  await ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth });
  await ensureConfigSheet(spreadsheetId, { interactiveAuth }).catch(() => {});
  return { ok: true };
}

function valuesForRange(valueRanges, sheetName) {
  const match = (valueRanges || []).find((valueRange) => String(valueRange.range || "").startsWith(`${sheetName}!`)
    || String(valueRange.range || "").startsWith(`'${sheetName}'!`));
  return match && match.values ? match.values : [];
}

/**
 * Reads entries and config in one batchGet: two ranges, one request. Returns the
 * entries, their sheet rows, the config map, and the config row of each key.
 */
export async function readRemoteSnapshot({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  await ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth });
  await ensureConfigSheet(spreadsheetId, { interactiveAuth }).catch(() => {});

  const query = [
    `ranges=${encodeRange(FULL_RANGE)}`,
    `ranges=${encodeRange(CONFIG_FULL_RANGE)}`,
    "valueRenderOption=UNFORMATTED_VALUE",
    "fields=valueRanges(range,values)"
  ].join("&");
  const data = await apiFetch(`/${spreadsheetId}/values:batchGet?${query}`, {}, { interactiveAuth });

  try {
    const { entries, rowMap } = rowsToEntries(valuesForRange(data.valueRanges, SHEET_NAME));
    const { config, configRows } = rowsToConfig(valuesForRange(data.valueRanges, CONFIG_SHEET_NAME));
    return { entries, rowMap, config, configRows };
  } catch (error) {
    // The cached tab check is no longer trustworthy if the header went missing.
    resetSheetCache();
    throw error;
  }
}

function rowsToEntries(rows) {
  // UNFORMATTED_VALUE can hand back numbers or booleans for cells a user edited
  // by hand, so every cell is coerced back to the string form entries expect.
  const asText = (row) => (row || []).map((cell) => (cell == null ? "" : String(cell)));
  const header = asText(rows[0] || []);
  if (!headersMatch(header)) throw codedError("SHEET_MISSING", "The time_entries tab header row is missing or invalid. Use Create/Initialize Spreadsheet.");

  const entries = [];
  const rowMap = new Map();
  rows.slice(1).forEach((row, index) => {
    const cells = asText(row);
    if (!cells[0]) return;
    const entry = rowToEntry(cells);
    entries.push(entry);
    rowMap.set(entry.id, index + 2);
  });

  return { entries, rowMap };
}

function appendedRowIndex(data) {
  const range = data && data.updates ? data.updates.updatedRange : "";
  const match = /![A-Z]+(\d+)/.exec(String(range || ""));
  return match ? Number(match[1]) : 0;
}

/**
 * Appends entries in one request and returns the 1-based row of each, in the
 * order given. Returns an empty array when the response carried no usable
 * range; callers must not guess rows.
 */
export async function appendRemoteEntries(entries, { interactiveAuth = false } = {}) {
  if (!entries.length) return [];
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(FULL_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: entries.map((entry) => entryToRow(entry)) })
  }, { interactiveAuth });

  const firstRow = appendedRowIndex(data);
  if (!firstRow) return [];
  return entries.map((entry, index) => ({ id: entry.id, rowIndex: firstRow + index }));
}

async function getSheetId({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  if (cachedSheetIdSpreadsheet === spreadsheetId && cachedSheetId != null) return cachedSheetId;

  const metadata = await apiFetch(`/${spreadsheetId}?fields=sheets.properties`, {}, { interactiveAuth });
  const existing = (metadata.sheets || []).find((s) => s.properties && s.properties.title === SHEET_NAME);
  if (!existing) throw codedError("SHEET_MISSING", "time_entries sheet not found");
  cachedSheetIdSpreadsheet = spreadsheetId;
  cachedSheetId = existing.properties.sheetId;
  return cachedSheetId;
}

/**
 * Deletes rows in a single batchUpdate. Rows are removed highest-first because
 * each deleteDimension shifts everything below it up.
 */
export async function deleteRemoteRows(rowIndexes, { interactiveAuth = false } = {}) {
  const rows = [...new Set(rowIndexes)].filter((rowIndex) => rowIndex > 1).sort((a, b) => b - a);
  if (!rows.length) return;

  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  const sheetId = await getSheetId({ interactiveAuth });

  await apiFetch(`/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: rows.map((rowIndex) => ({
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowIndex - 1, endIndex: rowIndex }
        }
      }))
    })
  }, { interactiveAuth });
}

/**
 * Rewrites existing rows in one values:batchUpdate call.
 * `updates` is a list of { rowIndex, entry }.
 */
export async function updateRemoteEntries(updates, { interactiveAuth = false } = {}) {
  if (!updates.length) return;
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  await apiFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: updates.map(({ rowIndex, entry }) => ({
        range: `${SHEET_NAME}!A${rowIndex}:Q${rowIndex}`,
        values: [entryToRow(entry)]
      }))
    })
  }, { interactiveAuth });
}

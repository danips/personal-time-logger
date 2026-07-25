import { getSetting, setSetting } from "./db.js";
import { getAccessToken } from "./auth.js";
import { getConfig } from "./config-loader.js";
import { SHEET_HEADERS, entryToRow, rowToEntry } from "./entries.js";
import { platform } from "./platform.js";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
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

async function apiFetch(path, options = {}, { interactiveAuth = false } = {}) {
  if (!platform.isOnline()) throw codedError("OFFLINE", "Network is offline");
  const token = await getAccessToken({ interactive: interactiveAuth });
  const response = await fetch(`${API_BASE}${path}`, {
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
}

async function ensureConfigSheet(spreadsheetId, { interactiveAuth = false } = {}) {
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

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
}

function rowsToConfig(rows) {
  const config = {};
  (rows || []).slice(1).forEach((row) => {
    if (row[0]) {
      config[row[0]] = { value: row[1] || "", updated_at: row[2] || "" };
    }
  });
  return config;
}

export async function readRemoteConfig({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return {};

  await ensureConfigSheet(spreadsheetId, { interactiveAuth });
  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_FULL_RANGE)}`, {}, { interactiveAuth });
  return rowsToConfig(data.values || []);
}

export async function updateRemoteConfig(key, value, updatedAt, { interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return;

  await ensureConfigSheet(spreadsheetId, { interactiveAuth });

  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_FULL_RANGE)}`, {}, { interactiveAuth });
  const rows = data.values || [CONFIG_HEADERS];
  const existingIndex = rows.findIndex((r, i) => i > 0 && r[0] === key);

  if (existingIndex >= 0) {
    const rowIndex = existingIndex + 1;
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A${rowIndex}:C${rowIndex}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [[key, value, updatedAt]] })
    }, { interactiveAuth });
  } else {
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A:C`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: [[key, value, updatedAt]] })
    }, { interactiveAuth });
  }
}

export async function testConnection({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  await ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth });
  await ensureConfigSheet(spreadsheetId, { interactiveAuth }).catch(() => {});
  return { ok: true };
}

export async function readRemoteEntries({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  await ensureTimeEntriesSheet(spreadsheetId, { interactiveAuth });
  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(FULL_RANGE)}`, {}, { interactiveAuth });
  return rowsToEntries(data.values || []);
}

function rowsToEntries(rows) {
  const header = rows[0] || [];
  if (!headersMatch(header)) throw codedError("SHEET_MISSING", "The time_entries tab header row is missing or invalid. Use Create/Initialize Spreadsheet.");

  const entries = [];
  const rowMap = new Map();
  rows.slice(1).forEach((row, index) => {
    if (!row[0]) return;
    const entry = rowToEntry(row);
    entries.push(entry);
    rowMap.set(entry.id, index + 2);
  });

  return { entries, rowMap };
}

export async function appendRemoteEntry(entry, { interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  await apiFetch(`/${spreadsheetId}/values/${encodeRange(FULL_RANGE)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [entryToRow(entry)] })
  }, { interactiveAuth });
}

export async function updateRemoteEntry(rowIndex, entry, { interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  const range = `${SHEET_NAME}!A${rowIndex}:Q${rowIndex}`;
  await apiFetch(`/${spreadsheetId}/values/${encodeRange(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [entryToRow(entry)] })
  }, { interactiveAuth });
}

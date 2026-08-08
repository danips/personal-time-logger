import { getSetting, setSetting } from "./db.js";
import { getAccessToken } from "./auth.js";
import { SHEET_HEADERS, entryToRow, rowToEntry } from "./entries.js";
import { nowIso } from "./time.js";
import { platform } from "./platform.js";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const SHEET_NAME = "time_entries";
const LAST_COLUMN = "N";
const FULL_RANGE = `${SHEET_NAME}!A:${LAST_COLUMN}`;
const HEADER_RANGE = `${SHEET_NAME}!A1:${LAST_COLUMN}1`;
const CONFIG_SHEET_NAME = "config";
const CONFIG_FULL_RANGE = `${CONFIG_SHEET_NAME}!A:C`;
const CONFIG_HEADER_RANGE = `${CONFIG_SHEET_NAME}!A1:C1`;
const CONFIG_HEADERS = ["key", "value", "updated_at"];
const SPREADSHEET_TITLE = "Personal Time Logger";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const APP_MARKER_KEY = "app";
const APP_MARKER_VALUE = "personal-time-logger";
// Validating a candidate costs one read each, so a Drive full of app-created
// files cannot turn setup into a long serial crawl.
const MAX_CANDIDATES = 5;
const API_TIMEOUT_MS = 30_000;

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

const SHEET_ID_SETTING = "time_entries_sheet_id";

const TABS = [
  { title: SHEET_NAME, headers: SHEET_HEADERS, headerRange: HEADER_RANGE },
  { title: CONFIG_SHEET_NAME, headers: CONFIG_HEADERS, headerRange: CONFIG_HEADER_RANGE }
];

// Cells come back unformatted, so a hand-edited numeric or boolean cell has to be
// coerced back to the string form entries and config expect.
function rowsAsText(rows) {
  return (rows || []).map((row) => (row || []).map((cell) => (cell == null ? "" : String(cell))));
}

function decodeRemoteRow(row, rowIndex) {
  const values = Object.fromEntries(SHEET_HEADERS.map((header, index) => [header, row[index] || ""]));
  const validDate = (value) => Boolean(value) && Number.isFinite(new Date(value).getTime());
  const validOptionalDate = (value) => !value || Number.isFinite(new Date(value).getTime());
  const revision = Number(values.revision);
  const duration = Number(values.duration_seconds);
  if (!values.id || !validDate(values.start_at) || !validDate(values.created_at) || !validDate(values.updated_at)
    || !validOptionalDate(values.end_at) || !validOptionalDate(values.deleted_at)
    || !Number.isInteger(revision) || revision < 1 || !Number.isFinite(duration) || duration < 0) {
    return { entry: null, quarantine: { rowIndex, id: values.id, reason: "invalid_entry", row } };
  }
  return { entry: rowToEntry(row), quarantine: null };
}

// The numeric sheet id is needed to delete rows. It is cached in memory and in
// settings, so it costs one metadata request per spreadsheet rather than one per
// extension context.
let cachedSheetIdSpreadsheet = "";
let cachedSheetId = null;
// Set once Drive refuses the metadata lookup. Without it a permanent refusal
// would cost a wasted request on every cycle on top of the read it fails to
// avoid. Cleared when the spreadsheet changes, and on the next context load.
let driveGateUnavailable = false;

function resetSheetCache() {
  cachedSheetIdSpreadsheet = "";
  cachedSheetId = null;
  driveGateUnavailable = false;
}

function isIdempotentRequest(options) {
  return ["GET", "PUT", "DELETE"].includes(String(options.method || "GET").toUpperCase());
}

async function apiFetch(path, options = {}, { interactiveAuth = false, baseUrl = API_BASE } = {}) {
  if (!platform.isOnline()) throw codedError("OFFLINE", "Network is offline");
  let token = await getAccessToken({ interactive: interactiveAuth });
  let response;
  let data;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
    } catch (error) {
      if (controller.signal.aborted) throw codedError("API_TIMEOUT", "Google API request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    data = text ? (() => {
      try {
        return JSON.parse(text);
      } catch (error) {
        return { error: { message: text } };
      }
    })() : {};

    if (response.status !== 401 || !isIdempotentRequest(options) || attempt === 1) break;
    token = await getAccessToken({ interactive: interactiveAuth, forceRefresh: true });
  }

  if (response.status === 401) throw codedError("AUTH_EXPIRED", "Google auth expired after refreshing credentials");
  if (response.status === 429) throw codedError("RATE_LIMIT", "Google API quota or rate limit");
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : `Google API error ${response.status}`;
    if (response.status === 403) {
      if (/quota|rate|limit/i.test(message)) throw codedError("RATE_LIMIT", "Google API quota or rate limit");
      if (/insufficient|scope/i.test(message)) throw codedError("SCOPE_MISSING", message);
      throw codedError("API_ERROR", `Google Sheets permission error: ${message}`);
    }
    // Either tab going missing is repairable, and a read is how we find out.
    if (/Unable to parse range|not found/i.test(message)
      && new RegExp(`${SHEET_NAME}|${CONFIG_SHEET_NAME}`, "i").test(message)) {
      throw codedError("SHEET_MISSING", `A required sheet tab is missing: ${message}`);
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

/**
 * Lists the spreadsheets this extension created. Under drive.file, Drive only
 * reports files the app created or opened, so the result is already scoped to our
 * own files and no filtering by name is needed.
 *
 * Errors propagate on purpose. A failed listing must never be mistaken for "no
 * spreadsheet exists", because that would create a duplicate alongside a
 * perfectly good sheet the caller simply could not see.
 */
async function listOwnedSpreadsheets({ interactiveAuth = false } = {}) {
  const query = [
    `q=${encodeURIComponent(`mimeType='${SPREADSHEET_MIME}' and trashed=false`)}`,
    "fields=files(id,name,modifiedTime)",
    `orderBy=${encodeURIComponent("modifiedTime desc")}`,
    "pageSize=25"
  ].join("&");
  const data = await apiFetch(`/files?${query}`, {}, { interactiveAuth, baseUrl: DRIVE_API_BASE });
  return (data.files || []).filter((file) => file && file.id);
}

/**
 * Cheapest possible identity check for a candidate: one header row.
 *
 * Only the entries header is required. A spreadsheet from an earlier version may
 * predate both the marker and the config tab, and rejecting it over a missing
 * config tab would create a duplicate and orphan real data. The regular sync path
 * repairs the layout and backfills the marker once the sheet is adopted.
 */
async function readHeaderRow(spreadsheetId, range, { interactiveAuth = false } = {}) {
  const data = await apiFetch(
    `/${spreadsheetId}/values/${encodeRange(range)}?fields=values`,
    {},
    { interactiveAuth }
  );
  const [header = []] = rowsAsText(data.values || []);
  return header;
}

async function hasTimeEntriesHeader(spreadsheetId, { interactiveAuth = false } = {}) {
  try {
    return headersMatch(await readHeaderRow(spreadsheetId, HEADER_RANGE, { interactiveAuth }));
  } catch (error) {
    if (error.code === "AUTH_EXPIRED" || error.code === "OFFLINE" || error.code === "RATE_LIMIT") throw error;
    return false;
  }
}

async function createOwnedSpreadsheet({ interactiveAuth = false } = {}) {
  const created = await apiFetch("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: SPREADSHEET_TITLE },
      sheets: TABS.map((tab) => ({ properties: { title: tab.title } }))
    })
  }, { interactiveAuth });

  const spreadsheetId = created.spreadsheetId;
  if (!spreadsheetId) throw codedError("API_ERROR", "Google did not return an ID for the new spreadsheet");

  await apiFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        ...TABS.map((tab) => ({ range: tab.headerRange, values: [tab.headers] })),
        { range: `${CONFIG_SHEET_NAME}!A2:C2`, values: [[APP_MARKER_KEY, APP_MARKER_VALUE, nowIso()]] }
      ]
    })
  }, { interactiveAuth });

  return spreadsheetId;
}

/**
 * Finds the spreadsheet to use, or creates one, and stores its ID.
 *
 * Candidates are tried newest first and the first readable one wins. A successful
 * read means the time_entries header is intact, which is the signal that a
 * spreadsheet from an earlier version, created before the marker existed, is still
 * recognised as ours.
 */
export async function provisionSpreadsheet({ interactiveAuth = false } = {}) {
  const candidates = await listOwnedSpreadsheets({ interactiveAuth });

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (!await hasTimeEntriesHeader(candidate.id, { interactiveAuth })) continue;
    await setSpreadsheetId(candidate.id);
    return { spreadsheetId: candidate.id, name: candidate.name || "", adopted: true };
  }

  const spreadsheetId = await createOwnedSpreadsheet({ interactiveAuth });
  await setSpreadsheetId(spreadsheetId);
  return { spreadsheetId, name: SPREADSHEET_TITLE, adopted: false };
}

/**
 * Writes the marker identifying this spreadsheet as ours, if it is not already
 * there. Backfills spreadsheets created before the marker existed, once.
 */
export async function ensureAppMarker(config, configRows, { interactiveAuth = false } = {}) {
  const existing = config[APP_MARKER_KEY];
  if (existing && String(existing.value) === APP_MARKER_VALUE) return false;

  await updateRemoteConfig(APP_MARKER_KEY, APP_MARKER_VALUE, nowIso(), {
    rowIndex: configRows.get(APP_MARKER_KEY) || 0,
    interactiveAuth
  });
  return true;
}

/**
 * Confirms with Drive that the stored spreadsheet is really gone, either deleted
 * or in the trash.
 *
 * A 404 from the Sheets API alone is not enough to act on: it can also mean the
 * file exists but is no longer reachable with this token, and reprovisioning on
 * that would strand the user on a second spreadsheet while the first still holds
 * their data. Anything other than a definite answer returns false, leaving the
 * original error to surface.
 */
export async function isSpreadsheetGone({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return false;

  try {
    const data = await apiFetch(
      `/files/${spreadsheetId}?fields=trashed,explicitlyTrashed&supportsAllDrives=true`,
      {},
      { interactiveAuth, baseUrl: DRIVE_API_BASE }
    );
    return Boolean(data && (data.trashed || data.explicitlyTrashed));
  } catch (error) {
    return /not found|notFound|File not found/i.test(String(error.message || ""));
  }
}

export function spreadsheetUrl(spreadsheetId) {
  return spreadsheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit` : "";
}

/**
 * Adds any missing tab and rewrites both header rows, in three requests at most.
 *
 * This is the repair path, not a precondition. A read proves the layout is sound
 * far more cheaply than checking it first does, so this only runs once a read has
 * actually failed, or when the user asks to initialize the spreadsheet.
 */
async function repairSheetLayout(spreadsheetId, { interactiveAuth = false } = {}) {
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  const metadata = await apiFetch(`/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`, {}, { interactiveAuth });
  const sheetIdsByTitle = new Map((metadata.sheets || [])
    .filter((sheet) => sheet.properties)
    .map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));

  const missing = TABS.filter((tab) => !sheetIdsByTitle.has(tab.title));
  if (missing.length) {
    const added = await apiFetch(`/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.title } } }))
      })
    }, { interactiveAuth });
    for (const reply of added.replies || []) {
      const properties = reply && reply.addSheet ? reply.addSheet.properties : null;
      if (properties) sheetIdsByTitle.set(properties.title, properties.sheetId);
    }
  }

  const sheetId = sheetIdsByTitle.get(SHEET_NAME);
  if (sheetId != null) await rememberSheetId(spreadsheetId, sheetId);

  await assertHeaderIsSafeToWrite(spreadsheetId, { interactiveAuth });

  await apiFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: TABS.map((tab) => ({ range: tab.headerRange, values: [tab.headers] }))
    })
  }, { interactiveAuth });

  return sheetId;
}

/**
 * Refuses to rewrite the header when the existing one is a different width.
 *
 * Repairing a header assumes the data below it is still aligned, which holds for a
 * renamed or cleared header row but not for a layout with extra columns, such as a
 * pre-migration backup restored from Drive. Rewriting in that case would silently
 * misalign every row, so it reports the problem instead.
 *
 * Reads past the current range on purpose: within A:N a wider sheet looks the
 * right width.
 */
async function assertHeaderIsSafeToWrite(spreadsheetId, { interactiveAuth = false } = {}) {
  const header = await readHeaderRow(spreadsheetId, `${SHEET_NAME}!A1:Z1`, { interactiveAuth })
    .catch(() => []);
  const width = header.filter((cell) => cell !== "").length;
  if (width === 0 || width === SHEET_HEADERS.length) return;

  throw codedError(
    "SHEET_MISSING",
    `The time_entries tab has ${width} columns where ${SHEET_HEADERS.length} are expected, so its rows are not aligned with the current layout. Fix the columns in the spreadsheet, or let the extension create a new one.`
  );
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

  // No layout check: this only runs after a successful snapshot read, which
  // already proved the config tab exists.
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

function valuesForRange(valueRanges, sheetName) {
  const match = (valueRanges || []).find((valueRange) => String(valueRange.range || "").startsWith(`${sheetName}!`)
    || String(valueRange.range || "").startsWith(`'${sheetName}'!`));
  return match && match.values ? match.values : [];
}

/**
 * Reads entries and config in one batchGet: two ranges, one request. Returns the
 * entries, their sheet rows, the config map, and the config row of each key.
 */
async function readSnapshotOnce(spreadsheetId, { interactiveAuth }) {
  const query = [
    `ranges=${encodeRange(FULL_RANGE)}`,
    `ranges=${encodeRange(CONFIG_FULL_RANGE)}`,
    "valueRenderOption=UNFORMATTED_VALUE",
    "fields=valueRanges(range,values)"
  ].join("&");
  const data = await apiFetch(`/${spreadsheetId}/values:batchGet?${query}`, {}, { interactiveAuth });

  const { entries, rowMap, duplicates } = rowsToEntries(valuesForRange(data.valueRanges, SHEET_NAME));
  const { config, configRows } = rowsToConfig(valuesForRange(data.valueRanges, CONFIG_SHEET_NAME));
  return { entries, rowMap, duplicates, config, configRows };
}

/**
 * Reads entries and config in one batchGet: two ranges, one request.
 *
 * No layout check runs first. The response carries the header row and
 * rowsToEntries validates it, so the read proves what a precheck would have, for
 * one request instead of five. A missing tab or broken header surfaces as
 * SHEET_MISSING, which triggers a repair and a single retry.
 */
export async function readRemoteSnapshot({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  try {
    return await readSnapshotOnce(spreadsheetId, { interactiveAuth });
  } catch (error) {
    if (error.code !== "SHEET_MISSING") throw error;
    resetSheetCache();
    await repairSheetLayout(spreadsheetId, { interactiveAuth });
    return readSnapshotOnce(spreadsheetId, { interactiveAuth });
  }
}

/**
 * Turns sheet rows into entries, one per id.
 *
 * The same id can appear in several rows, from a duplicated append or a hand
 * edit. Where it does, the row with the newest updated_at wins rather than
 * whichever happens to come last, so a stale duplicate below a fresh one cannot
 * overwrite newer data. The losing rows are reported as duplicates so they can be
 * cleaned up deliberately.
 */
export function rowsToEntries(rows) {
  const cells = rowsAsText(rows);
  if (!headersMatch(cells[0] || [])) {
    throw codedError("SHEET_MISSING", "The time_entries tab header row is missing or invalid.");
  }

  const byId = new Map();
  cells.slice(1).forEach((row, index) => {
    if (!row[0]) return;
    const rowIndex = index + 2;
    const entry = rowToEntry(row);
    const existing = byId.get(entry.id);

    if (!existing) {
      byId.set(entry.id, { entry, rowIndex, rowIndexes: [rowIndex] });
      return;
    }

    existing.rowIndexes.push(rowIndex);
    if (String(entry.updated_at || "") > String(existing.entry.updated_at || "")) {
      existing.entry = entry;
      existing.rowIndex = rowIndex;
    }
  });

  const entries = [];
  const rowMap = new Map();
  const duplicates = [];
  const quarantined = [];
  for (const record of byId.values()) {
    const decoded = decodeRemoteRow(cells[record.rowIndex - 1], record.rowIndex);
    if (!decoded.entry) {
      quarantined.push(decoded.quarantine);
      continue;
    }
    entries.push(decoded.entry);
    rowMap.set(decoded.entry.id, record.rowIndex);
    if (record.rowIndexes.length > 1) {
      duplicates.push({
        id: record.entry.id,
        entry: decoded.entry,
        keepRowIndex: record.rowIndex,
        extraRowIndexes: record.rowIndexes.filter((rowIndex) => rowIndex !== record.rowIndex)
      });
    }
  }

  return { entries, rowMap, duplicates, quarantined };
}

function appendedRowIndex(data) {
  const range = data && data.updates ? data.updates.updatedRange : "";
  const match = /![A-Z]+(\d+)/.exec(String(range || ""));
  return match ? Number(match[1]) : 0;
}

async function verifyRemoteRowIds(spreadsheetId, rows, { interactiveAuth = false } = {}) {
  const expected = rows.filter((row) => row && row.id && row.rowIndex > 1);
  if (!expected.length) return;
  const query = expected.map((row) => `ranges=${encodeRange(`${SHEET_NAME}!A${row.rowIndex}:A${row.rowIndex}`)}`)
    .concat("fields=valueRanges(range,values)")
    .join("&");
  const data = await apiFetch(`/${spreadsheetId}/values:batchGet?${query}`, {}, { interactiveAuth });
  const values = data.valueRanges || [];
  for (let index = 0; index < expected.length; index += 1) {
    const actual = values[index]?.values?.[0]?.[0] == null ? "" : String(values[index].values[0][0]);
    if (actual !== expected[index].id) {
      throw codedError("REMOTE_ROW_STALE", "A spreadsheet row changed before it could be updated. Sync will retry from a fresh snapshot.");
    }
  }
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

async function rememberSheetId(spreadsheetId, sheetId) {
  cachedSheetIdSpreadsheet = spreadsheetId;
  cachedSheetId = sheetId;
  await setSetting(SHEET_ID_SETTING, { spreadsheetId, sheetId });
}

async function getSheetId({ interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  if (cachedSheetIdSpreadsheet === spreadsheetId && cachedSheetId != null) return cachedSheetId;

  // Stored alongside its spreadsheet id, so a stale entry from a previous
  // spreadsheet is ignored rather than trusted.
  const stored = await getSetting(SHEET_ID_SETTING, null);
  if (stored && stored.spreadsheetId === spreadsheetId && Number.isFinite(stored.sheetId)) {
    cachedSheetIdSpreadsheet = spreadsheetId;
    cachedSheetId = stored.sheetId;
    return cachedSheetId;
  }

  const metadata = await apiFetch(`/${spreadsheetId}?fields=sheets.properties`, {}, { interactiveAuth });
  const existing = (metadata.sheets || []).find((s) => s.properties && s.properties.title === SHEET_NAME);
  if (!existing) throw codedError("SHEET_MISSING", "time_entries sheet not found");
  await rememberSheetId(spreadsheetId, existing.properties.sheetId);
  return cachedSheetId;
}

/**
 * Deletes rows in a single batchUpdate. Rows are removed highest-first because
 * each deleteDimension shifts everything below it up.
 */
export async function deleteRemoteRows(rowIndexes, { interactiveAuth = false } = {}) {
  const requested = rowIndexes.map((row) => typeof row === "number" ? { rowIndex: row, id: "" } : row);
  const rows = [...new Map(requested
    .filter((row) => row && row.rowIndex > 1)
    .map((row) => [row.rowIndex, row])).values()]
    .sort((a, b) => b.rowIndex - a.rowIndex);
  if (!rows.length) return;

  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  await verifyRemoteRowIds(spreadsheetId, rows, { interactiveAuth });
  const sheetId = await getSheetId({ interactiveAuth });

  await apiFetch(`/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
    requests: rows.map(({ rowIndex }) => ({
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
  await verifyRemoteRowIds(spreadsheetId, updates.map(({ rowIndex, entry }) => ({ rowIndex, id: entry.id })), { interactiveAuth });

  await apiFetch(`/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: updates.map(({ rowIndex, entry }) => ({
        range: `${SHEET_NAME}!A${rowIndex}:${LAST_COLUMN}${rowIndex}`,
        values: [entryToRow(entry)]
      }))
    })
  }, { interactiveAuth });
}

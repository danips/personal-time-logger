import { getSetting, mutateSettings, setSetting } from "./db.js";
import { getAccessToken } from "./auth.js";
import { SHEET_HEADERS, entryToRow, rowToEntry } from "./entries.js";
import { nowIso } from "./time.js";
import { platform } from "./platform.js";
import { recordDiagnostic } from "./diagnostics.js";
import { ERROR_CODE } from "./error-codes.js";
import { SETTING_KEY } from "./setting-keys.js";

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
const MAX_CANDIDATES = 25;
const API_TIMEOUT_MS = 30_000;
const DRIVE_GATE_RETRY_MS = 60_000;
const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODE));

function codedError(code, message) {
  if (!KNOWN_ERROR_CODES.has(code)) throw new TypeError(`Unknown extension error code: ${code}`);
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeRange(range) {
  return encodeURIComponent(range);
}

function headersMatch(row) {
  return headersMatchFor(SHEET_HEADERS, row);
}

function headersMatchFor(expected, row) {
  return expected.length === row.length && expected.every((header, index) => row[index] === header);
}

const SHEET_ID_SETTING = SETTING_KEY.TIME_ENTRIES_SHEET_ID;
const PROVISION_PENDING_SETTING = SETTING_KEY.SPREADSHEET_PROVISION_PENDING;

async function setProvisioningState(spreadsheetId, pendingSpreadsheetId) {
  return mutateSettings([SETTING_KEY.SPREADSHEET_ID, PROVISION_PENDING_SETTING], (settings) => {
    settings.set(SETTING_KEY.SPREADSHEET_ID, String(spreadsheetId || "").trim());
    settings.set(PROVISION_PENDING_SETTING, String(pendingSpreadsheetId || "").trim());
  });
}

const TABS = [
  { title: SHEET_NAME, headers: SHEET_HEADERS, headerRange: HEADER_RANGE },
  { title: CONFIG_SHEET_NAME, headers: CONFIG_HEADERS, headerRange: CONFIG_HEADER_RANGE }
];

// Cells come back unformatted, so a hand-edited numeric or boolean cell has to be
// coerced back to the string form entries and config expect.
function rowsAsText(rows) {
  return (rows || []).map((row) => (row || []).map((cell) => (cell == null ? "" : String(cell))));
}

export function rowFingerprint(row) {
  return rowsAsText([row])[0].slice(0, SHEET_HEADERS.length).join("\u0000");
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
// Set only when Drive confirms this context cannot use the metadata gate. A
// transient failure merely pauses metadata requests for a short cooldown.
let driveGateUnavailable = false;
let driveGateRetryAt = 0;
let driveGateLastError = null;

function resetSheetCache() {
  cachedSheetIdSpreadsheet = "";
  cachedSheetId = null;
  driveGateUnavailable = false;
  driveGateRetryAt = 0;
  driveGateLastError = null;
}

/** The current Drive-gate state, for diagnostics and recovery UI. */
export function getDriveGateDiagnostics() {
  return {
    unavailable: driveGateUnavailable,
    retryAt: driveGateRetryAt,
    lastError: driveGateLastError && { ...driveGateLastError }
  };
}

function isIdempotentRequest(options) {
  return ["GET", "PUT", "DELETE"].includes(String(options.method || "GET").toUpperCase());
}

async function apiFetch(path, options = {}, context = {}) {
  try {
    return await apiFetchUnsafe(path, options, context);
  } catch (error) {
    try {
      await recordDiagnostic({
        subsystem: "sheets",
        phase: "api_request",
        error,
        recovery: error?.code === "AUTH_EXPIRED" || error?.code === "SCOPE_MISSING"
          ? "Open Options and sign in again."
          : "Retry the sync. Open Options diagnostics if it continues."
      });
    } catch {
      // Do not replace an API error with a local diagnostics failure.
    }
    throw error;
  }
}

async function apiFetchUnsafe(path, options = {}, { interactiveAuth = false, baseUrl = API_BASE } = {}) {
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
      const text = await response.text();
      data = text ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          if (response.ok) throw codedError("API_ERROR", "Google API returned malformed JSON");
          return { error: { message: text } };
        }
      })() : {};
    } catch (error) {
      if (controller.signal.aborted) throw codedError("API_TIMEOUT", "Google API request timed out");
      if (error && error.code) throw error;
      throw codedError("API_NETWORK", error.message || "Google API network request failed");
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok && (!data || typeof data !== "object" || Array.isArray(data))) {
      throw codedError("API_ERROR", "Google API returned an invalid response shape");
    }

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
  return getSetting(SETTING_KEY.SPREADSHEET_ID, "");
}

export async function setSpreadsheetId(spreadsheetId) {
  resetSheetCache();
  return setSetting(SETTING_KEY.SPREADSHEET_ID, String(spreadsheetId || "").trim());
}

/** Clears only the selected remote binding; local time entries remain intact. */
export async function resetSpreadsheetBinding() {
  resetSheetCache();
  return setProvisioningState("", "");
}

/**
 * Selects an existing compatible spreadsheet after proving that its entries
 * tab uses the expected schema. The following sync repairs or initializes the
 * config tab when it is safe to do so, then re-seeds the local backup.
 */
export async function adoptSpreadsheet(spreadsheetId, { interactiveAuth = false } = {}) {
  const selectedSpreadsheetId = String(spreadsheetId || "").trim();
  if (!selectedSpreadsheetId) {
    throw codedError("SPREADSHEET_MISSING", "Enter a spreadsheet ID to connect it.");
  }
  if (!await hasTimeEntriesHeader(selectedSpreadsheetId, { interactiveAuth })) {
    throw codedError("SHEET_SCHEMA_UNSUPPORTED", "That spreadsheet does not contain a compatible time_entries tab.");
  }

  resetSheetCache();
  // Pending makes the next sync repair the full layout if required and re-seed
  // the local backup. Without it, clean entries would be left only on the old
  // destination after an explicit recovery choice.
  await setProvisioningState(selectedSpreadsheetId, selectedSpreadsheetId);
  return selectedSpreadsheetId;
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
  if (!Array.isArray(data.files)) throw codedError("API_ERROR", "Google Drive returned an invalid file list");
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
  if (!Array.isArray(data.values)) throw codedError("API_ERROR", "Google Sheets returned an invalid header row");
  const [header = []] = rowsAsText(data.values || []);
  return header;
}

async function hasTimeEntriesHeader(spreadsheetId, { interactiveAuth = false } = {}) {
  return headersMatch(await readHeaderRow(spreadsheetId, HEADER_RANGE, { interactiveAuth }));
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

  // Record the ID before initialization. If the following write is interrupted,
  // the next provisioning attempt repairs this same file instead of making a
  // second, empty spreadsheet.
  await setProvisioningState(spreadsheetId, spreadsheetId);

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

  await setProvisioningState(spreadsheetId, "");
  return spreadsheetId;
}

/**
 * Creates a fresh remote destination on explicit user request. This never
 * searches for or silently adopts another spreadsheet, which makes recovery
 * from an inaccessible former destination deliberate and predictable.
 */
export async function createReplacementSpreadsheet({ interactiveAuth = false } = {}) {
  resetSheetCache();
  await setProvisioningState("", "");
  const spreadsheetId = await createOwnedSpreadsheet({ interactiveAuth });
  // Creation initialized the remote headers, but a new destination still needs
  // the same one-time local re-seed as an adopted destination.
  await setProvisioningState(spreadsheetId, spreadsheetId);
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
  const storedSpreadsheetId = await getSpreadsheetId();
  const pendingSpreadsheetId = await getSetting(PROVISION_PENDING_SETTING, "");
  if (storedSpreadsheetId && pendingSpreadsheetId === storedSpreadsheetId) {
    await repairSheetLayout(storedSpreadsheetId, { interactiveAuth });
    await setProvisioningState(storedSpreadsheetId, "");
    return { spreadsheetId: storedSpreadsheetId, name: SPREADSHEET_TITLE, adopted: false, recovered: true };
  }

  const candidates = await listOwnedSpreadsheets({ interactiveAuth });

  let candidateError = null;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      if (!await hasTimeEntriesHeader(candidate.id, { interactiveAuth })) continue;
      await setSpreadsheetId(candidate.id);
      return { spreadsheetId: candidate.id, name: candidate.name || "", adopted: true };
    } catch (error) {
      // A single stale or inaccessible Drive result must not hide a later
      // candidate the extension can still read.
      candidateError = candidateError || error;
    }
  }

  if (candidateError) throw candidateError;

  const spreadsheetId = await createOwnedSpreadsheet({ interactiveAuth });
  return { spreadsheetId, name: SPREADSHEET_TITLE, adopted: false };
}

/**
 * Writes the marker identifying this spreadsheet as ours, if it is not already
 * there. Backfills spreadsheets created before the marker existed, once.
 */
export async function ensureAppMarker(config, configRows, { interactiveAuth = false } = {}) {
  const existing = config[APP_MARKER_KEY];
  if (existing && String(existing.value) === APP_MARKER_VALUE) return false;

  const row = configRows.get(APP_MARKER_KEY) || {};
  await updateRemoteConfig(APP_MARKER_KEY, APP_MARKER_VALUE, nowIso(), {
    rowIndex: row.rowIndex || 0,
    expectedFingerprint: row.expectedFingerprint || "",
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
  } catch {
    // Drive can use an indistinguishable 404 for a file the current token can
    // no longer see. Only an explicit `trashed` response is enough evidence to
    // replace a spreadsheet; otherwise retain the configured ID and surface the
    // original sync failure.
    return false;
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
  if (!Array.isArray(metadata.sheets)) throw codedError("API_ERROR", "Google Sheets returned invalid spreadsheet metadata");
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

  const headersToWrite = [];
  for (const tab of TABS) {
    if (await assertHeaderIsSafeToWrite(spreadsheetId, tab, { interactiveAuth })) headersToWrite.push(tab);
  }

  if (headersToWrite.length) {
    await apiFetch(`/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: headersToWrite.map((tab) => ({ range: tab.headerRange, values: [tab.headers] }))
      })
    }, { interactiveAuth });
  }

  return sheetId;
}

/**
 * Only an entirely empty tab can receive a fresh header automatically. A
 * populated tab must already use the exact known schema; otherwise a repair
 * could reinterpret its rows under new column names.
 */
async function assertHeaderIsSafeToWrite(spreadsheetId, tab, { interactiveAuth = false } = {}) {
  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${tab.title}!A:Z`)}?fields=values`, {}, { interactiveAuth });
  const rows = rowsAsText(data.values || []);
  const header = rows[0] || [];
  if (headersMatchFor(tab.headers, header)) return false;
  if (!rows.some((row) => row.some((cell) => cell !== ""))) return true;

  throw codedError(
    "SHEET_SCHEMA_UNSUPPORTED",
    `The ${tab.title} tab has a populated, unrecognized schema. No data was changed. Restore the exact header or move the data to a new spreadsheet before syncing.`
  );
}

function rowsToConfig(rows) {
  const cells = rowsAsText(rows);
  if (!headersMatchFor(CONFIG_HEADERS, cells[0] || [])) {
    throw codedError("SHEET_SCHEMA_UNSUPPORTED", "The config tab header is missing or invalid. No config values were changed.");
  }
  const config = {};
  const configRows = new Map();
  cells.slice(1).forEach((row, index) => {
    const key = row[0];
    if (!key) return;
    if (configRows.has(key)) {
      throw codedError("CONFIG_CONFLICT", `The config tab has duplicate rows for ${key}. Resolve the duplicate before syncing.`);
    }
    const updatedAt = row[2];
    if (!updatedAt || !Number.isFinite(new Date(updatedAt).getTime())) {
      throw codedError("CONFIG_CONFLICT", `The config value ${key} has an invalid updated_at timestamp.`);
    }
    config[key] = {
      value: row[1],
      updated_at: updatedAt
    };
    configRows.set(key, { rowIndex: index + 2, expectedFingerprint: row.slice(0, 3).join("\u0000") });
  });
  return { config, configRows };
}

/**
 * Writes one config key. `rowIndex` comes from the snapshot, so no extra read is
 * needed; 0 means the key is not in the sheet yet and the row is appended.
 */
export async function updateRemoteConfig(key, value, updatedAt, { rowIndex = 0, expectedFingerprint = "", interactiveAuth = false } = {}) {
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) return;
  const beforeData = await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_FULL_RANGE)}?valueRenderOption=UNFORMATTED_VALUE`, {}, { interactiveAuth });
  const beforeRows = rowsAsText(beforeData.values || []);
  const nextFingerprint = [key, value, updatedAt].join("\u0000");

  if (rowIndex > 0) {
    const current = beforeRows[rowIndex - 1] || [];
    if (current[0] !== key || current.slice(0, 3).join("\u0000") !== expectedFingerprint) {
      throw codedError("REMOTE_ROW_STALE", "A config row changed before it could be updated.");
    }
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A${rowIndex}:C${rowIndex}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [[key, value, updatedAt]] })
    }, { interactiveAuth });
  } else {
    if (beforeRows.slice(1).some((row) => row[0] === key)) {
      throw codedError("CONFIG_CONFLICT", `The config key ${key} appeared before it could be added.`);
    }
    await apiFetch(`/${spreadsheetId}/values/${encodeRange(`${CONFIG_SHEET_NAME}!A:C`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: [[key, value, updatedAt]] })
    }, { interactiveAuth });
  }
  const afterData = await apiFetch(`/${spreadsheetId}/values/${encodeRange(CONFIG_FULL_RANGE)}?valueRenderOption=UNFORMATTED_VALUE`, {}, { interactiveAuth });
  if (!rowsAsText(afterData.values || []).slice(1).some((row) => row.slice(0, 3).join("\u0000") === nextFingerprint)) {
    throw codedError("REMOTE_ROW_STALE", "The config write could not be verified.");
  }
}

/**
 * Last modification time of the spreadsheet file, used to skip reads when
 * nothing changed remotely. Returns "" whenever Drive cannot answer: token
 * issued before the drive.file scope (403), a spreadsheet the extension did not
 * create so drive.file does not cover it (404), or the Drive API not enabled on
 * the project. Callers must then read unconditionally.
 */
export async function getRemoteModifiedTime({ interactiveAuth = false } = {}) {
  if (driveGateUnavailable || driveGateRetryAt > Date.now()) return "";
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");

  try {
    const data = await apiFetch(
      `/files/${spreadsheetId}?fields=modifiedTime&supportsAllDrives=true`,
      {},
      { interactiveAuth, baseUrl: DRIVE_API_BASE }
    );
    driveGateLastError = null;
    driveGateRetryAt = 0;
    return data && data.modifiedTime ? String(data.modifiedTime) : "";
  } catch (error) {
    driveGateLastError = {
      code: error.code || "API_ERROR",
      message: error.message || "Drive metadata lookup failed",
      at: nowIso()
    };
    if (error.code === "AUTH_EXPIRED" || error.code === "OFFLINE" || error.code === "RATE_LIMIT") throw error;
    // A scope refusal or the disabled-API response are stable capabilities of
    // this context. Other errors can be transient (including 5xx, timeout,
    // malformed JSON, or an inaccessible file) and get another chance later.
    if (error.code === "SCOPE_MISSING" || /(?:drive\s+api.*(?:disabled|not\s+enabled)|api\s+has\s+not\s+been\s+used|access\s+not\s+configured)/i.test(error.message || "")) {
      driveGateUnavailable = true;
      driveGateRetryAt = 0;
      return "";
    }
    driveGateRetryAt = Date.now() + DRIVE_GATE_RETRY_MS;
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
  if (!Array.isArray(data.valueRanges)) throw codedError("API_ERROR", "Google Sheets returned an invalid snapshot");

  const { entries, rowMap, duplicates, quarantined } = rowsToEntries(valuesForRange(data.valueRanges, SHEET_NAME));
  const { config, configRows } = rowsToConfig(valuesForRange(data.valueRanges, CONFIG_SHEET_NAME));
  return { entries, rowMap, duplicates, quarantined, config, configRows };
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
  const quarantined = [];
  cells.slice(1).forEach((row, index) => {
    if (!row[0]) return;
    const rowIndex = index + 2;
    const decoded = decodeRemoteRow(row, rowIndex);
    if (!decoded.entry) {
      quarantined.push(decoded.quarantine);
      return;
    }
    const existing = byId.get(decoded.entry.id) || [];
    existing.push({ entry: decoded.entry, rowIndex });
    byId.set(decoded.entry.id, existing);
  });

  const entries = [];
  const rowMap = new Map();
  const duplicates = [];
  for (const records of byId.values()) {
    const winner = records.reduce((best, candidate) => (
      String(candidate.entry.updated_at || "") > String(best.entry.updated_at || "") ? candidate : best
    ));
    entries.push(winner.entry);
    rowMap.set(winner.entry.id, winner.rowIndex);
    if (records.length > 1) {
      const rows = records.map(({ rowIndex }) => ({
        id: winner.entry.id,
        rowIndex,
        expectedFingerprint: rowFingerprint(cells[rowIndex - 1])
      }));
      duplicates.push({
        id: winner.entry.id,
        entry: winner.entry,
        keepRowIndex: winner.rowIndex,
        keepRow: rows.find((row) => row.rowIndex === winner.rowIndex),
        extraRows: rows.filter((row) => row.rowIndex !== winner.rowIndex),
        extraRowIndexes: records.filter((record) => record.rowIndex !== winner.rowIndex).map((record) => record.rowIndex)
      });
    }
  }

  return { entries, rowMap, duplicates, quarantined };
}

function appendedRowSpan(data) {
  const range = data && data.updates ? data.updates.updatedRange : "";
  const match = /![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/.exec(String(range || ""));
  if (!match) return null;
  const firstRow = Number(match[1]);
  const lastRow = Number(match[2] || match[1]);
  if (!Number.isInteger(firstRow) || !Number.isInteger(lastRow) || lastRow < firstRow) return null;
  return { firstRow, rowCount: lastRow - firstRow + 1 };
}

function remoteRowPreconditions(rows) {
  const requested = [...new Map(rows.map((row) => [row?.rowIndex, row])).values()]
    .sort((first, second) => first.rowIndex - second.rowIndex);
  for (const row of requested) {
    if (!row || !Number.isInteger(row.rowIndex) || row.rowIndex <= 1
      || !row.id || typeof row.expectedFingerprint !== "string" || !row.expectedFingerprint) {
      throw codedError("REMOTE_ROW_PRECONDITION_REQUIRED", "Remote mutations require a row index, id, and full row fingerprint from a fresh snapshot.");
    }
  }
  return requested;
}

async function readRowsForMutation(spreadsheetId, { interactiveAuth = false } = {}) {
  const data = await apiFetch(`/${spreadsheetId}/values/${encodeRange(FULL_RANGE)}?valueRenderOption=UNFORMATTED_VALUE`, {}, { interactiveAuth });
  const rows = rowsAsText(data.values);
  if (!headersMatch(rows[0] || [])) {
    throw codedError("REMOTE_ROW_STALE", "The spreadsheet header changed before the mutation could be applied.");
  }
  return rows;
}

function verifyRemoteRows(rows, expected) {
  for (const row of expected) {
    const actual = rows[row.rowIndex - 1] || [];
    if (String(actual[0] || "") !== row.id || rowFingerprint(actual) !== row.expectedFingerprint) {
      throw codedError("REMOTE_ROW_STALE", "A spreadsheet row changed before it could be updated. Refresh reconciliation and try again.");
    }
  }
}

function fingerprintCounts(rows) {
  const counts = new Map();
  for (const row of rows.slice(1)) {
    const fingerprint = rowFingerprint(row);
    counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
  }
  return counts;
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

  const span = appendedRowSpan(data);
  if (!span) return [];
  return entries.slice(0, span.rowCount).map((entry, index) => ({
    id: entry.id,
    rowIndex: span.firstRow + index
  }));
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
export async function deleteRemoteRows(preconditions, { interactiveAuth = false } = {}) {
  const rows = remoteRowPreconditions(preconditions).sort((first, second) => second.rowIndex - first.rowIndex);
  if (!rows.length) return;

  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  const before = await readRowsForMutation(spreadsheetId, { interactiveAuth });
  verifyRemoteRows(before, rows);
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

  const after = await readRowsForMutation(spreadsheetId, { interactiveAuth });
  const beforeCounts = fingerprintCounts(before);
  const afterCounts = fingerprintCounts(after);
  for (const row of rows) {
    const expectedCount = (beforeCounts.get(row.expectedFingerprint) || 0)
      - rows.filter((candidate) => candidate.expectedFingerprint === row.expectedFingerprint).length;
    if ((afterCounts.get(row.expectedFingerprint) || 0) !== expectedCount) {
      throw codedError("REMOTE_ROW_STALE", "The spreadsheet changed while duplicate rows were being deleted. Refresh reconciliation and verify the result.");
    }
  }
}

/**
 * Rewrites existing rows in one values:batchUpdate call.
 * `updates` is a list of { rowIndex, entry }.
 */
export async function updateRemoteEntries(updates, { interactiveAuth = false } = {}) {
  if (!updates.length) return;
  const spreadsheetId = await getSpreadsheetId();
  if (!spreadsheetId) throw codedError("SPREADSHEET_MISSING", "Set a Google Spreadsheet ID");
  const rows = remoteRowPreconditions(updates.map(({ rowIndex, entry, expectedFingerprint }) => ({
    rowIndex,
    id: entry.id,
    expectedFingerprint
  })));
  const before = await readRowsForMutation(spreadsheetId, { interactiveAuth });
  verifyRemoteRows(before, rows);

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

  const after = await readRowsForMutation(spreadsheetId, { interactiveAuth });
  verifyRemoteRows(after, updates.map(({ rowIndex, entry }) => ({
    rowIndex,
    id: entry.id,
    expectedFingerprint: rowFingerprint(entryToRow(entry))
  })));
}

import { allocateEntry } from "./time-allocation.js";
import { ERROR_CODE } from "./error-codes.js";
import { localDateKey } from "./time.js";

export const TEMPO_API_URL = "https://api.tempo.io/4";
export const TEMPO_BULK_LIMIT = 50;
export const TEMPO_HOST_PERMISSION = "https://api.tempo.io/*";
export const TEMPO_UPLOAD_MESSAGE = "UPLOAD_TEMPO_WORKLOGS";

function tempoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeTempoIssueId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return "";
  try {
    return BigInt(text) > 0n ? text.replace(/^0+(?=\d)/, "") : "";
  } catch {
    return "";
  }
}

export function normalizeTempoTaskIssueIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [task, issueId] of Object.entries(value)) {
    const validIssueId = normalizeTempoIssueId(issueId);
    if (validIssueId) normalized[String(task).trim()] = validIssueId;
  }
  return normalized;
}

/** Accepts any iterable of local civil-date keys, ignoring unusable members. */
export function normalizeTempoDayKeys(value) {
  if (!value || typeof value === "string" || typeof value[Symbol.iterator] !== "function") return new Set();
  return new Set([...value].map((key) => String(key).trim()).filter(Boolean));
}

function dayIncluded(days, value) {
  if (!days) return true;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? false : days.has(localDateKey(date));
}

/**
 * Converts completed displayed-week allocations into Tempo bulk payloads.
 * `includedDays` narrows the send to specific local civil dates: omitting it
 * sends every day in the period, while an empty iterable sends none, so an
 * empty calendar day selection can never fall back to the whole week.
 */
export function prepareTempoWeek(entries, {
  periodStart,
  periodEnd,
  authorAccountId,
  taskIssueIds,
  includedDays,
  now = new Date()
} = {}) {
  const author = String(authorAccountId ?? "").trim();
  const mappings = normalizeTempoTaskIssueIds(taskIssueIds);
  const days = includedDays === undefined || includedDays === null
    ? null
    : normalizeTempoDayKeys(includedDays);
  const grouped = new Map();
  const missingTasks = new Set();
  let skippedRunning = 0;
  let skippedZeroDuration = 0;
  let skippedExcludedDays = 0;

  for (const entry of entries) {
    if (!entry || entry.deleted_at) continue;
    if (!entry.end_at) {
      // A running timer on an unselected day is out of scope, so counting it
      // would warn about a skip this send was never going to make.
      if (dayIncluded(days, entry.start_at)) skippedRunning += 1;
      continue;
    }

    const allocation = allocateEntry(entry, periodStart, periodEnd, { now });
    if (!allocation) continue;
    const startDate = localDateKey(allocation.start);
    // Excluded days drop out before the mapping check so the calendar never
    // prompts for a Jira issue ID belonging to a day nobody asked to send.
    if (days && !days.has(startDate)) {
      skippedExcludedDays += 1;
      continue;
    }
    const timeSpentSeconds = Math.ceil(Number(allocation.effectiveSeconds) || 0);
    if (timeSpentSeconds < 1) {
      skippedZeroDuration += 1;
      continue;
    }

    const task = String(entry.task ?? "").trim();
    const issueId = mappings[task];
    if (!issueId) {
      missingTasks.add(task);
      continue;
    }

    if (!grouped.has(issueId)) grouped.set(issueId, []);
    grouped.get(issueId).push({
      authorAccountId: author,
      description: String(entry.description ?? ""),
      startDate,
      timeSpentSeconds
    });
  }

  const groups = [...grouped].map(([issueId, worklogs]) => ({ issueId, worklogs }));
  return {
    groups,
    missingTasks: [...missingTasks],
    skippedRunning,
    skippedZeroDuration,
    skippedExcludedDays,
    totalWorklogs: groups.reduce((total, group) => total + group.worklogs.length, 0)
  };
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function responseDetail(response) {
  try {
    const data = await response.clone().json();
    const detail = data?.message || data?.error || data?.errors || data;
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    return text.slice(0, 500);
  } catch {
    try {
      return (await response.text()).slice(0, 500);
    } catch {
      return "";
    }
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Uses the background page's privileged XMLHttpRequest implementation. With a
 * granted Tempo host permission Firefox omits the web-page CORS preflight that
 * blocks the same authenticated request when made from an ordinary page world.
 */
export function tempoXhrRequest(url, init = {}, XMLHttpRequestImpl = globalThis.XMLHttpRequest) {
  if (typeof XMLHttpRequestImpl !== "function") {
    return Promise.reject(tempoError(ERROR_CODE.TEMPO_NETWORK, "Background XMLHttpRequest is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequestImpl();
    request.open(init.method || "GET", url, true);
    request.timeout = 20_000;
    for (const [name, value] of Object.entries(init.headers || {})) {
      request.setRequestHeader(name, value);
    }
    request.onload = () => {
      const responseText = String(request.responseText || "");
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        clone() {
          return { json: async () => JSON.parse(responseText) };
        },
        text: async () => responseText
      });
    };
    request.onerror = () => reject(tempoError(ERROR_CODE.TEMPO_NETWORK, "Tempo background request failed"));
    request.ontimeout = () => reject(tempoError(ERROR_CODE.TEMPO_NETWORK, "Tempo background request timed out"));
    request.send(init.body ?? null);
  });
}

/** Sends groups sequentially and spaces requests below Tempo's 5 req/s limit. */
export async function sendTempoWorklogs(groups, {
  token,
  fetchImpl = globalThis.fetch,
  requestIntervalMs = 210,
  wait = pause
} = {}) {
  const bearerToken = String(token ?? "").trim();
  if (!bearerToken) throw tempoError(ERROR_CODE.TEMPO_CONFIG_MISSING, "Enter a Tempo API token in Options");
  if (typeof fetchImpl !== "function") throw tempoError(ERROR_CODE.TEMPO_NETWORK, "Network requests are unavailable");

  let sentWorklogs = 0;
  let requestCount = 0;
  for (const group of groups) {
    const issueId = normalizeTempoIssueId(group?.issueId);
    if (!issueId) throw tempoError(ERROR_CODE.TEMPO_API_ERROR, "A cached Tempo issue ID is invalid");
    for (const worklogs of chunks(group.worklogs || [], TEMPO_BULK_LIMIT)) {
      if (!worklogs.length) continue;
      if (requestCount && requestIntervalMs > 0) await wait(requestIntervalMs);
      let response;
      try {
        response = await fetchImpl(`${TEMPO_API_URL}/worklogs/issue/${issueId}/bulk`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${bearerToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(worklogs)
        });
      } catch (error) {
        if (error?.code === ERROR_CODE.TEMPO_NETWORK) throw error;
        throw tempoError(ERROR_CODE.TEMPO_NETWORK, "Tempo request could not complete");
      }
      requestCount += 1;
      if (!response.ok) {
        const detail = await responseDetail(response);
        const partial = sentWorklogs
          ? ` ${sentWorklogs} worklog${sentWorklogs === 1 ? " was" : "s were"} already sent; do not retry the whole week.`
          : "";
        throw tempoError(
          sentWorklogs ? ERROR_CODE.TEMPO_PARTIAL : ERROR_CODE.TEMPO_API_ERROR,
          `Tempo rejected issue ${issueId} (HTTP ${response.status})${detail ? `: ${detail}` : "."}${partial}`
        );
      }
      sentWorklogs += worklogs.length;
    }
  }
  return { sentWorklogs, requestCount };
}

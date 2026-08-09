import { allocateEntry } from "./time-allocation.js";
import { localDateKey } from "./time.js";

export const TEMPO_API_URL = "https://api.tempo.io/4";
export const TEMPO_BULK_LIMIT = 50;

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

/** Converts completed displayed-week allocations into Tempo bulk payloads. */
export function prepareTempoWeek(entries, {
  periodStart,
  periodEnd,
  authorAccountId,
  taskIssueIds,
  now = new Date()
} = {}) {
  const author = String(authorAccountId ?? "").trim();
  const mappings = normalizeTempoTaskIssueIds(taskIssueIds);
  const grouped = new Map();
  const missingTasks = new Set();
  let skippedRunning = 0;
  let skippedZeroDuration = 0;

  for (const entry of entries) {
    if (!entry || entry.deleted_at) continue;
    if (!entry.end_at) {
      skippedRunning += 1;
      continue;
    }

    const allocation = allocateEntry(entry, periodStart, periodEnd, { now });
    if (!allocation) continue;
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
      startDate: localDateKey(allocation.start),
      timeSpentSeconds
    });
  }

  const groups = [...grouped].map(([issueId, worklogs]) => ({ issueId, worklogs }));
  return {
    groups,
    missingTasks: [...missingTasks],
    skippedRunning,
    skippedZeroDuration,
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

/** Sends groups sequentially and spaces requests below Tempo's 5 req/s limit. */
export async function sendTempoWorklogs(groups, {
  token,
  fetchImpl = globalThis.fetch,
  requestIntervalMs = 210,
  wait = pause
} = {}) {
  const bearerToken = String(token ?? "").trim();
  if (!bearerToken) throw new Error("Enter a Tempo API token in Options");
  if (typeof fetchImpl !== "function") throw new Error("Network requests are unavailable");

  let sentWorklogs = 0;
  let requestCount = 0;
  for (const group of groups) {
    const issueId = normalizeTempoIssueId(group?.issueId);
    if (!issueId) throw new Error("A cached Tempo issue ID is invalid");
    for (const worklogs of chunks(group.worklogs || [], TEMPO_BULK_LIMIT)) {
      if (!worklogs.length) continue;
      if (requestCount && requestIntervalMs > 0) await wait(requestIntervalMs);
      const response = await fetchImpl(`${TEMPO_API_URL}/worklogs/issue/${issueId}/bulk`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(worklogs)
      });
      requestCount += 1;
      if (!response.ok) {
        const detail = await responseDetail(response);
        const partial = sentWorklogs
          ? ` ${sentWorklogs} worklog${sentWorklogs === 1 ? " was" : "s were"} already sent; do not retry the whole week.`
          : "";
        throw new Error(`Tempo rejected issue ${issueId} (HTTP ${response.status})${detail ? `: ${detail}` : "."}${partial}`);
      }
      sentWorklogs += worklogs.length;
    }
  }
  return { sentWorklogs, requestCount };
}

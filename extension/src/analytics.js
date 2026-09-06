import { allocateEntry, entryInterval } from "./time-allocation.js";
import { addDays, localDateKey, startOfLocalDay } from "./time.js";

export const SHORT_ANOMALY_SECONDS = 60;
export const LONG_SESSION_SECONDS = 6 * 60 * 60;
export const STALE_ACTIVE_SECONDS = 8 * 60 * 60;
export const SWITCH_GAP_SECONDS = 30 * 60;
export const SHORT_FRAGMENT_SESSION_SECONDS = 15 * 60;

const NO_PROJECT = "No project";
const NO_TASK = "No task";
const ANOMALY_ORDER = Object.freeze({
  stale_active: 0,
  overlap: 1,
  needs_review: 2,
  missing_project: 3,
  missing_task: 4,
  very_long: 5,
  very_short: 6
});

function text(value) {
  return String(value || "").trim();
}

function identity(entry) {
  return String(entry?.id || "");
}

function label(value, fallback) {
  return text(value) || fallback;
}

function identityKey(value, missingKey) {
  const normalized = text(value);
  return normalized ? `value:${normalized}` : missingKey;
}

function compareLabels(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" }) || left.localeCompare(right);
}

function compareSessions(left, right) {
  return left.start - right.start || left.end - right.end || identity(left.entry).localeCompare(identity(right.entry));
}

function maximum(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, Number(value) || 0);
  return result;
}

export function comparisonDelta(current, previous) {
  const currentValue = Number.isFinite(Number(current)) ? Number(current) : 0;
  const previousValue = Number.isFinite(Number(previous)) ? Number(previous) : 0;
  if (previousValue === 0) {
    return currentValue === 0
      ? { kind: "percent", percent: 0 }
      : { kind: "new", percent: null };
  }
  return { kind: "percent", percent: ((currentValue - previousValue) / previousValue) * 100 };
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sessionsForPeriod(entries, period, { now = new Date() } = {}) {
  return (entries || [])
    .map((entry) => allocateEntry(entry, period.start, period.end, { now }))
    .filter(Boolean)
    .sort(compareSessions);
}

function loggedDays(entries, period, now) {
  const days = new Set();
  const periodStart = startOfLocalDay(period.start);
  const periodEndDay = startOfLocalDay(period.end);
  const periodEnd = period.end > periodEndDay ? addDays(periodEndDay, 1) : periodEndDay;
  for (const entry of entries || []) {
    const interval = entryInterval(entry, { now });
    if (!interval) continue;
    let dayStart = interval.start > periodStart ? startOfLocalDay(interval.start) : periodStart;
    const lastDay = interval.end < periodEnd ? interval.end : periodEnd;
    for (; dayStart < lastDay; dayStart = addDays(dayStart, 1)) {
      const allocation = allocateEntry(entry, dayStart, addDays(dayStart, 1), { now });
      if (!allocation) continue;
      const start = allocation.start > period.start ? allocation.start : period.start;
      const end = allocation.end < period.end ? allocation.end : period.end;
      if (end > start) days.add(localDateKey(start));
    }
  }
  return days.size;
}

export function aggregatePeriod(sessions, { entries = [], period, now = new Date() } = {}) {
  const actual = sessions.map(({ actualSeconds }) => actualSeconds);
  const totalEffectiveSeconds = sessions.reduce((sum, session) => sum + session.effectiveSeconds, 0);
  const dayCount = period ? loggedDays(entries, period, now) : 0;
  return {
    totalEffectiveSeconds,
    loggedDays: dayCount,
    averageEffectiveSecondsPerLoggedDay: dayCount ? totalEffectiveSeconds / dayCount : 0,
    sessionCount: sessions.length,
    averageActualSessionSeconds: actual.length ? actual.reduce((sum, value) => sum + value, 0) / actual.length : 0,
    medianActualSessionSeconds: median(actual),
    longestActualSessionSeconds: maximum(actual)
  };
}

function pairedRows(currentRows, previousRows, decorate) {
  const keys = new Set([...currentRows.keys(), ...previousRows.keys()]);
  return [...keys].map((key) => {
    const current = currentRows.get(key);
    const previous = previousRows.get(key);
    return decorate(key, current, previous);
  });
}

function projectMaps(sessions) {
  const projects = new Map();
  for (const session of sessions) {
    const projectKey = identityKey(session.entry.project, "missing-project");
    const taskKey = identityKey(session.entry.task, "missing-task");
    const projectLabel = label(session.entry.project, NO_PROJECT);
    const taskLabel = label(session.entry.task, NO_TASK);
    let project = projects.get(projectKey);
    if (!project) {
      project = { label: projectLabel, seconds: 0, tasks: new Map() };
      projects.set(projectKey, project);
    }
    project.seconds += session.effectiveSeconds;
    const task = project.tasks.get(taskKey) || { label: taskLabel, seconds: 0 };
    task.seconds += session.effectiveSeconds;
    project.tasks.set(taskKey, task);
  }
  return projects;
}

export function aggregateProjects(currentSessions, previousSessions, totalEffectiveSeconds) {
  const currentProjects = projectMaps(currentSessions);
  const previousProjects = projectMaps(previousSessions);
  return pairedRows(currentProjects, previousProjects, (projectKey, current, previous) => {
    const currentSeconds = current?.seconds || 0;
    const previousSeconds = previous?.seconds || 0;
    const tasks = pairedRows(current?.tasks || new Map(), previous?.tasks || new Map(),
      (taskKey, taskCurrent, taskPrevious) => ({
        label: taskCurrent?.label || taskPrevious?.label || (taskKey === "missing-task" ? NO_TASK : taskKey.slice(6)),
        currentSeconds: taskCurrent?.seconds || 0,
        previousSeconds: taskPrevious?.seconds || 0,
        share: totalEffectiveSeconds ? (taskCurrent?.seconds || 0) / totalEffectiveSeconds : 0,
        delta: comparisonDelta(taskCurrent?.seconds || 0, taskPrevious?.seconds || 0)
      }))
      .sort((left, right) => right.currentSeconds - left.currentSeconds || compareLabels(left.label, right.label));
    return {
      label: current?.label || previous?.label || (projectKey === "missing-project" ? NO_PROJECT : projectKey.slice(6)),
      currentSeconds,
      previousSeconds,
      share: totalEffectiveSeconds ? currentSeconds / totalEffectiveSeconds : 0,
      delta: comparisonDelta(currentSeconds, previousSeconds),
      tasks
    };
  }).sort((left, right) => right.currentSeconds - left.currentSeconds || compareLabels(left.label, right.label));
}

function descriptionMap(sessions) {
  const descriptions = new Map();
  for (const session of sessions) {
    const spelling = text(session.entry.description);
    if (!spelling) continue;
    const key = spelling.replace(/\s+/g, " ").toLowerCase();
    let row = descriptions.get(key);
    if (!row) {
      row = { seconds: 0, sessions: 0, spellings: new Map() };
      descriptions.set(key, row);
    }
    row.seconds += session.effectiveSeconds;
    row.sessions += 1;
    row.spellings.set(spelling, (row.spellings.get(spelling) || 0) + 1);
  }
  return descriptions;
}

function representative(row) {
  if (!row) return "";
  return [...row.spellings]
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || (left < right ? -1 : left > right ? 1 : 0))[0]?.[0] || "";
}

export function aggregateDescriptions(currentSessions, previousSessions, totalEffectiveSeconds) {
  const current = descriptionMap(currentSessions);
  const previous = descriptionMap(previousSessions);
  return pairedRows(current, previous, (key, currentRow, previousRow) => {
    const currentSeconds = currentRow?.seconds || 0;
    const previousSeconds = previousRow?.seconds || 0;
    const sessionCount = currentRow?.sessions || 0;
    return {
      key,
      description: representative(currentRow) || representative(previousRow),
      sessionCount,
      currentSeconds,
      averageSeconds: sessionCount ? currentSeconds / sessionCount : 0,
      share: totalEffectiveSeconds ? currentSeconds / totalEffectiveSeconds : 0,
      previousSeconds,
      delta: comparisonDelta(currentSeconds, previousSeconds)
    };
  }).sort((left, right) => right.currentSeconds - left.currentSeconds || compareLabels(left.description, right.description));
}

function bucketFor(seconds) {
  if (seconds < 15 * 60) return "under15";
  if (seconds < 30 * 60) return "15to30";
  if (seconds < 60 * 60) return "30to60";
  if (seconds < 2 * 60 * 60) return "1to2";
  if (seconds < 4 * 60 * 60) return "2to4";
  return "over4";
}

export function fragmentationMetrics(sessions) {
  const sorted = [...sessions].sort(compareSessions);
  const buckets = { under15: 0, "15to30": 0, "30to60": 0, "1to2": 0, "2to4": 0, over4: 0 };
  let switchEligibleTransitions = 0;
  let projectSwitches = 0;
  let taskSwitches = 0;
  for (const session of sorted) buckets[bucketFor(session.actualSeconds)] += 1;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gapSeconds = Math.max(0, (current.start - previous.end) / 1000);
    if (gapSeconds > SWITCH_GAP_SECONDS) continue;
    switchEligibleTransitions += 1;
    const previousProject = identityKey(previous.entry.project, "missing-project");
    const currentProject = identityKey(current.entry.project, "missing-project");
    const previousTask = identityKey(previous.entry.task, "missing-task");
    const currentTask = identityKey(current.entry.task, "missing-task");
    if (previousProject !== currentProject) projectSwitches += 1;
    if (previousProject !== currentProject || previousTask !== currentTask) taskSwitches += 1;
  }
  const actual = sorted.map(({ actualSeconds }) => actualSeconds);
  return {
    sessionCount: sorted.length,
    averageActualSessionSeconds: actual.length ? actual.reduce((sum, value) => sum + value, 0) / actual.length : 0,
    medianActualSessionSeconds: median(actual),
    longestActualSessionSeconds: maximum(actual),
    switchEligibleTransitions,
    projectSwitches,
    taskSwitches,
    shortSessionCount: actual.filter((seconds) => seconds < SHORT_FRAGMENT_SESSION_SECONDS).length,
    buckets
  };
}

function anomaly(session, type, message, relatedEntryId = "") {
  return {
    type,
    entryId: identity(session.entry),
    relatedEntryId,
    start: session.start,
    actualSeconds: session.actualSeconds,
    project: label(session.entry.project, NO_PROJECT),
    task: label(session.entry.task, NO_TASK),
    message
  };
}

export function detectAnomalies(sessions, { now = new Date() } = {}) {
  const anomalies = [];
  const sorted = [...sessions].sort(compareSessions);
  for (const session of sorted) {
    const { entry } = session;
    if (entry.status === "needs_review") anomalies.push(anomaly(session, "needs_review", "Entry is marked for review."));
    if (!text(entry.project)) anomalies.push(anomaly(session, "missing_project", "Project is missing."));
    if (!text(entry.task)) anomalies.push(anomaly(session, "missing_task", "Task is missing."));
    if (session.actualSeconds <= SHORT_ANOMALY_SECONDS) anomalies.push(anomaly(session, "very_short", "Session is 60 seconds or shorter."));
    if (entry.end_at && session.actualSeconds >= LONG_SESSION_SECONDS) anomalies.push(anomaly(session, "very_long", "Completed session is at least 6 hours long."));
    const activeSeconds = (new Date(now).getTime() - new Date(entry.start_at).getTime()) / 1000;
    if (!entry.end_at && activeSeconds >= STALE_ACTIVE_SECONDS) anomalies.push(anomaly(session, "stale_active", "Active timer has been running for at least 8 hours."));
  }

  let overlapCount = 0;
  if (sorted.length <= 100) {
    const active = [];
    for (const session of sorted) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (active[index].end <= session.start) active.splice(index, 1);
      }
      overlapCount += active.length;
      for (const other of active) {
        const ids = [identity(other.entry), identity(session.entry)].sort();
        const first = ids[0] === identity(other.entry) ? other : session;
        anomalies.push(anomaly(first, "overlap", "Session overlaps another entry.", ids[1]));
      }
      active.push(session);
    }
  } else {
    // For dense reports count overlaps with an event sweep; do not create
    // O(n²) pair records merely to render a list.
    const events = sorted.flatMap((session) => [[session.start, 1], [session.end, -1]])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let active = 0;
    for (const [, type] of events) { if (type < 0) active -= 1; else { overlapCount += active; active += 1; } }
  }
  const rows = anomalies.sort((left, right) => (ANOMALY_ORDER[left.type] ?? 99) - (ANOMALY_ORDER[right.type] ?? 99)
    || right.start - left.start || left.entryId.localeCompare(right.entryId)
    || left.relatedEntryId.localeCompare(right.relatedEntryId));
  const omittedOverlapCount = sorted.length > 100 ? overlapCount : 0;
  return {
    rows,
    totalCount: rows.length + omittedOverlapCount,
    overlapCount,
    omittedOverlapCount
  };
}

export function buildAnalyticsReport(entries, { primary, comparison, now = new Date() } = {}) {
  if (!primary?.start || !primary?.end || !comparison?.start || !comparison?.end) {
    throw new TypeError("Primary and comparison analytics periods are required");
  }
  const primarySessions = sessionsForPeriod(entries, primary, { now });
  const comparisonSessions = sessionsForPeriod(entries, comparison, { now });
  const primaryMetrics = aggregatePeriod(primarySessions, { entries, period: primary, now });
  const comparisonMetrics = aggregatePeriod(comparisonSessions, { entries, period: comparison, now });
  const fragmentation = fragmentationMetrics(primarySessions);
  const anomalies = detectAnomalies(primarySessions, { now });
  return {
    primary: primaryMetrics,
    comparison: comparisonMetrics,
    deltas: {
      totalEffectiveSeconds: comparisonDelta(primaryMetrics.totalEffectiveSeconds, comparisonMetrics.totalEffectiveSeconds),
      loggedDays: comparisonDelta(primaryMetrics.loggedDays, comparisonMetrics.loggedDays),
      sessionCount: comparisonDelta(primaryMetrics.sessionCount, comparisonMetrics.sessionCount)
    },
    projects: aggregateProjects(primarySessions, comparisonSessions, primaryMetrics.totalEffectiveSeconds),
    descriptions: aggregateDescriptions(primarySessions, comparisonSessions, primaryMetrics.totalEffectiveSeconds),
    fragmentation,
    anomalies
  };
}

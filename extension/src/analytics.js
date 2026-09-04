import { allocateEntry, allocateEntryByLocalDay } from "./time-allocation.js";
import { localDateKey } from "./time.js";

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

function compareLabels(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" }) || left.localeCompare(right);
}

function compareSessions(left, right) {
  return left.start - right.start || left.end - right.end || identity(left.entry).localeCompare(identity(right.entry));
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
  for (const entry of entries || []) {
    for (const allocation of allocateEntryByLocalDay(entry, { now })) {
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
    longestActualSessionSeconds: actual.length ? Math.max(...actual) : 0
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
    const projectLabel = label(session.entry.project, NO_PROJECT);
    const taskLabel = label(session.entry.task, NO_TASK);
    let project = projects.get(projectLabel);
    if (!project) {
      project = { label: projectLabel, seconds: 0, tasks: new Map() };
      projects.set(projectLabel, project);
    }
    project.seconds += session.effectiveSeconds;
    project.tasks.set(taskLabel, (project.tasks.get(taskLabel) || 0) + session.effectiveSeconds);
  }
  return projects;
}

export function aggregateProjects(currentSessions, previousSessions, totalEffectiveSeconds) {
  const currentProjects = projectMaps(currentSessions);
  const previousProjects = projectMaps(previousSessions);
  return pairedRows(currentProjects, previousProjects, (projectLabel, current, previous) => {
    const currentSeconds = current?.seconds || 0;
    const previousSeconds = previous?.seconds || 0;
    const tasks = pairedRows(current?.tasks || new Map(), previous?.tasks || new Map(),
      (taskLabel, taskCurrent, taskPrevious) => ({
        label: taskLabel,
        currentSeconds: taskCurrent || 0,
        previousSeconds: taskPrevious || 0,
        share: totalEffectiveSeconds ? (taskCurrent || 0) / totalEffectiveSeconds : 0,
        delta: comparisonDelta(taskCurrent || 0, taskPrevious || 0)
      }))
      .sort((left, right) => right.currentSeconds - left.currentSeconds || compareLabels(left.label, right.label));
    return {
      label: projectLabel,
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
    const previousProject = label(previous.entry.project, NO_PROJECT);
    const currentProject = label(current.entry.project, NO_PROJECT);
    const previousTask = label(previous.entry.task, NO_TASK);
    const currentTask = label(current.entry.task, NO_TASK);
    if (previousProject !== currentProject) projectSwitches += 1;
    if (previousProject !== currentProject || previousTask !== currentTask) taskSwitches += 1;
  }
  const actual = sorted.map(({ actualSeconds }) => actualSeconds);
  return {
    sessionCount: sorted.length,
    averageActualSessionSeconds: actual.length ? actual.reduce((sum, value) => sum + value, 0) / actual.length : 0,
    medianActualSessionSeconds: median(actual),
    longestActualSessionSeconds: actual.length ? Math.max(...actual) : 0,
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

  const active = [];
  for (const session of sorted) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].end <= session.start) active.splice(index, 1);
    }
    for (const other of active) {
      const ids = [identity(other.entry), identity(session.entry)].sort();
      const first = ids[0] === identity(other.entry) ? other : session;
      anomalies.push(anomaly(first, "overlap", "Session overlaps another entry.", ids[1]));
    }
    active.push(session);
  }

  return anomalies.sort((left, right) => (ANOMALY_ORDER[left.type] ?? 99) - (ANOMALY_ORDER[right.type] ?? 99)
    || right.start - left.start || left.entryId.localeCompare(right.entryId)
    || left.relatedEntryId.localeCompare(right.relatedEntryId));
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

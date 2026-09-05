import { MIN_SYNC_INTERVAL_SECONDS } from "./background-schedule.js";
import { normalizeMultiplierText } from "./entries.js";
import { SETTING_KEY } from "./setting-keys.js";
import { normalizeTempoTaskIssueIds } from "./tempo.js";
import { normalizeWindowSizePreset } from "./window-resize.js";

export const INVALID_MULTIPLIER_MESSAGE = "Enter a duration multiplier between 1 and 5.001 with at most three decimal places.";
export const DEFAULT_WORKDAY_START_HOUR = 7;
export const INVALID_WORKDAY_START_HOUR_MESSAGE = "Enter a calendar start hour from 00:00 to 23:00.";
export const BACKUP_SETTING_KEYS = Object.freeze([
  SETTING_KEY.DURATION_MULTIPLIER,
  SETTING_KEY.SYNC_INTERVAL_SECONDS,
  SETTING_KEY.TEMPO_AUTHOR_ACCOUNT_ID,
  SETTING_KEY.TEMPO_TASK_ISSUE_IDS,
  SETTING_KEY.WINDOW_RESIZE_PRESETS,
  SETTING_KEY.WORKDAY_START_HOUR
]);

export function normalizeWorkdayStartHour(value) {
  const startHour = Number(value);
  const valid = value !== ""
    && Number.isInteger(startHour)
    && startHour >= 0
    && startHour <= 23;
  if (!valid) return { valid: false, message: INVALID_WORKDAY_START_HOUR_MESSAGE };
  return { valid: true, start: startHour };
}

export function normalizeOptionsSettings({ interval, multiplier }) {
  const normalizedMultiplier = normalizeMultiplierText(multiplier);
  if (!normalizedMultiplier) return { valid: false, message: INVALID_MULTIPLIER_MESSAGE };

  return {
    valid: true,
    interval: Math.max(MIN_SYNC_INTERVAL_SECONDS, Number(interval) || 60),
    multiplier: normalizedMultiplier
  };
}

export function normalizeBackupSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid backup settings");
  const normalized = {};
  const copy = (key, normalize) => {
    if (Object.hasOwn(value, key)) normalized[key] = normalize(value[key]);
  };

  copy(SETTING_KEY.DURATION_MULTIPLIER, (raw) => {
    const multiplier = normalizeMultiplierText(raw);
    if (!multiplier) throw new TypeError("Invalid backup multiplier");
    return multiplier;
  });
  copy(SETTING_KEY.SYNC_INTERVAL_SECONDS, (raw) => {
    const interval = Number(raw);
    if (!Number.isInteger(interval) || interval < MIN_SYNC_INTERVAL_SECONDS) throw new TypeError("Invalid backup sync interval");
    return interval;
  });
  copy(SETTING_KEY.TEMPO_AUTHOR_ACCOUNT_ID, (raw) => {
    if (typeof raw !== "string") throw new TypeError("Invalid backup Tempo account");
    return raw.trim();
  });
  copy(SETTING_KEY.TEMPO_TASK_ISSUE_IDS, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid backup Tempo mappings");
    const mappings = normalizeTempoTaskIssueIds(raw);
    if (Object.keys(mappings).length !== Object.keys(raw).length) throw new TypeError("Invalid backup Tempo mappings");
    return mappings;
  });
  copy(SETTING_KEY.WINDOW_RESIZE_PRESETS, (raw) => {
    if (!Array.isArray(raw)) throw new TypeError("Invalid backup window presets");
    const presets = raw.map(normalizeWindowSizePreset);
    if (presets.some((preset) => !preset)) throw new TypeError("Invalid backup window presets");
    return presets;
  });
  copy(SETTING_KEY.WORKDAY_START_HOUR, (raw) => {
    const result = normalizeWorkdayStartHour(raw);
    if (!result.valid) throw new TypeError("Invalid backup workday start");
    return result.start;
  });
  return normalized;
}

/**
 * Determines the smallest durable update required for one Options save.
 * A missing timestamp is treated as a pending first-time config publication.
 */
export function planOptionsSettingsSave({
  currentInterval,
  currentMultiplier,
  currentMultiplierUpdatedAt,
  interval,
  multiplier
}) {
  const savedInterval = Math.max(MIN_SYNC_INTERVAL_SECONDS, Number(currentInterval) || 60);
  const savedMultiplier = normalizeMultiplierText(currentMultiplier) || "1.000";
  const intervalChanged = savedInterval !== interval;
  const multiplierChanged = savedMultiplier !== multiplier;

  return {
    intervalChanged,
    multiplierChanged,
    multiplierSyncNeeded: multiplierChanged || !currentMultiplierUpdatedAt
  };
}

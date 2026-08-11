import { MIN_SYNC_INTERVAL_SECONDS } from "./background-schedule.js";
import { normalizeMultiplierText } from "./entries.js";

export const INVALID_MULTIPLIER_MESSAGE = "Enter a duration multiplier between 1 and 5.001 with at most three decimal places.";

export function normalizeOptionsSettings({ interval, multiplier }) {
  const normalizedMultiplier = normalizeMultiplierText(multiplier);
  if (!normalizedMultiplier) return { valid: false, message: INVALID_MULTIPLIER_MESSAGE };

  return {
    valid: true,
    interval: Math.max(MIN_SYNC_INTERVAL_SECONDS, Number(interval) || 60),
    multiplier: normalizedMultiplier
  };
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

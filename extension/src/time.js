export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function durationSeconds(startAt, endAt = nowIso()) {
  if (!startAt || !endAt) return 0;
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 1000);
}

export function startOfLocalDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function startOfLocalWeek(date) {
  const day = startOfLocalDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

// Date formatting follows the browser locale everywhere. Passing [] rather than a
// fixed locale keeps these consistent with localTime and shortDateTime.
export function weekdayDayMonth(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export function dayMonth(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function localTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatElapsed(seconds) {
  const numeric = Number(seconds);
  // Elapsed displays advance only after a full second has passed. Flooring
  // also keeps fractional inputs from leaking into a HH:MM:SS string.
  const total = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

export function toLocalInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 19);
}

export function fromLocalInputValue(value) {
  const text = String(value || "");
  if (!text) return { kind: "empty" };
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) {
    return { kind: "invalid", reason: "format" };
  }
  const [, year, month, dateOfMonth, hours, minutes, seconds = "0"] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDateOfMonth = Number(dateOfMonth);
  const numericHours = Number(hours);
  const numericMinutes = Number(minutes);
  const numericSeconds = Number(seconds);
  const wanted = [numericYear, numericMonth, numericDateOfMonth, numericHours, numericMinutes, numericSeconds];
  const matches = [];
  const seenOffsets = new Set();
  // A bounded sample discovers both one-hour and non-hour offset changes.
  const wallMs = Date.UTC(wanted[0], wanted[1] - 1, wanted[2], wanted[3], wanted[4], wanted[5]);
  for (let delta = -48 * 60; delta <= 48 * 60; delta += 15) {
    seenOffsets.add(new Date(wallMs + delta * 60_000).getTimezoneOffset());
  }
  for (const offset of seenOffsets) {
    const candidate = new Date(wallMs + offset * 60_000);
    if (candidate.getFullYear() === wanted[0] && candidate.getMonth() + 1 === wanted[1]
      && candidate.getDate() === wanted[2] && candidate.getHours() === wanted[3]
      && candidate.getMinutes() === wanted[4] && candidate.getSeconds() === wanted[5]
      && !matches.some((item) => item.getTime() === candidate.getTime())) matches.push(candidate);
  }
  if (!matches.length) return { kind: "invalid", reason: "nonexistent" };
  if (matches.length > 1) return { kind: "invalid", reason: "ambiguous" };
  return { kind: "instant", iso: matches[0].toISOString() };
}

export function bindMinuteRollover(input) {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    const before = new Date(input.value);
    if (Number.isNaN(before.getTime())) return;

    const direction = event.key === "ArrowUp" ? 1 : -1;
    const rolloverFrom = direction > 0 ? 59 : 0;
    if (before.getMinutes() !== rolloverFrom) return;

    setTimeout(() => {
      const after = new Date(input.value);
      const rolloverTo = direction > 0 ? 0 : 59;
      if (Number.isNaN(after.getTime()) || after.getMinutes() !== rolloverTo) return;

      const expected = new Date(before);
      expected.setMinutes(expected.getMinutes() + direction);
      if (after.getTime() === expected.getTime()) return;

      input.value = toLocalInputValue(expected.toISOString());
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 0);
  });
}

export function shortDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

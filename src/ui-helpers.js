export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function entryTitle(entry) {
  return [entry.project, entry.task].filter(Boolean).join(" / ") || entry.description || "Untitled timer";
}

export function projectColor(entry) {
  const name = entry.project || "untitled";
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360}, 68%, 42%)`;
}

export function formatError(error) {
  const code = error && error.code ? error.code : "";
  const message = error && error.message ? error.message : String(error || "");

  if (code === "CONFIG_MISSING") return message || "Google OAuth config missing";
  if (code === "AUTH_REQUIRED") return "not signed in";
  if (code === "AUTH_EXPIRED") return "auth expired";
  if (code === "SPREADSHEET_MISSING") return "spreadsheet missing";
  if (code === "SHEET_MISSING") return message || "sheet tab/header missing";
  if (code === "RATE_LIMIT") return "API quota/rate limit";
  if (code === "OFFLINE") return "offline";
  if (code === "BACKOFF") return message || "waiting after API error";
  if (code === "AUTH_FAILED") return message ? `auth failure: ${message}` : "auth failure";
  return message || "error";
}

export function statusFromError(error) {
  const code = error && error.code;
  if (code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED" || code === "CONFIG_MISSING") return "not signed in";
  if (code === "SPREADSHEET_MISSING") return "spreadsheet missing";
  if (code === "OFFLINE") return "offline";
  return "error";
}

export function setStatus(element, status, detail = "") {
  if (!element) return;
  element.textContent = detail ? `${status}: ${detail}` : status;
  element.dataset.status = status;
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  return userErrorMessage(error);
}

export function statusFromError(error) {
  return errorInfo(error).status;
}

export function setStatus(element, status, detail = "") {
  if (!element) return;
  element.textContent = detail ? `${status}: ${detail}` : status;
  element.dataset.status = status;
}
import { errorInfo, userErrorMessage } from "./error-registry.js";

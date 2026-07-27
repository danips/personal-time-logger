import { hasMultiplier } from "./entries.js";
import { fromLocalInputValue, toLocalInputValue } from "./time.js";

/**
 * Shared mapping between an entry and the edit controls used by both the popup
 * and the calendar. `fields` holds the elements: project, task, description,
 * multiply, start, end, and an optional status select.
 */
export function writeEntryForm(fields, entry) {
  fields.project.value = entry.project || "";
  fields.task.value = entry.task || "";
  fields.description.value = entry.description || "";
  fields.multiply.checked = hasMultiplier(entry);
  fields.start.value = toLocalInputValue(entry.start_at);
  fields.end.value = toLocalInputValue(entry.end_at);
  if (fields.status) fields.status.value = entry.status || "ok";
}

/**
 * Builds an updateEntry payload from the controls. `multiplyValue` carries the
 * entry's existing multiplier so re-saving keeps its own factor instead of
 * falling back to the global setting.
 */
export function readEntryForm(fields, { multiplyValue = "" } = {}) {
  const payload = {
    project: fields.project.value.trim(),
    task: fields.task.value.trim(),
    description: fields.description.value.trim(),
    multiply: fields.multiply.checked ? (multiplyValue || true) : false,
    start_at: fromLocalInputValue(fields.start.value),
    end_at: fromLocalInputValue(fields.end.value)
  };
  if (fields.status) payload.status = fields.status.value;
  return payload;
}

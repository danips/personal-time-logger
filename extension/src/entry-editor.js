/**
 * Mounts the common edit-entry markup. Pages supply their established element
 * ids so their event wiring stays local, while field layout and controls have a
 * single source of truth.
 */
export function mountEntryEditor(container, {
  formId,
  projectId,
  taskId,
  descriptionId,
  multiplyId,
  statusId,
  startId,
  endId,
  mergeControlId,
  mergeTargetId,
  mergeButtonId,
  saveButtonId,
  cancelButtonId,
  deleteButtonId,
  duplicateButtonId = "",
  saveType = "button"
} = {}) {
  if (!container) throw new TypeError("An entry editor container is required");
  container.innerHTML = `
    <form id="${formId}" class="entry-editor-form">
      <label>Project<input id="${projectId}"></label>
      <label>Task<input id="${taskId}"></label>
      <label>Description<textarea id="${descriptionId}" rows="2"></textarea></label>
      <div class="entry-editor-options${duplicateButtonId ? " has-duplicate" : ""}">
        <label><input id="${multiplyId}" type="checkbox">Multiply</label>
        <label class="entry-editor-status">Status
          <select id="${statusId}">
            <option value="ok">ok</option>
            <option value="needs_review">needs_review</option>
          </select>
        </label>
        ${duplicateButtonId ? `<button id="${duplicateButtonId}" type="button">Duplicate</button>` : ""}
      </div>
      <div class="entry-editor-datetime">
        <label>Start<input id="${startId}" type="datetime-local" step="1" required></label>
        <label>End<input id="${endId}" type="datetime-local" step="1"></label>
      </div>
      <div class="entry-editor-merge">
        <div id="${mergeControlId}" class="entry-editor-merge-control" hidden>
          <label>Merge with matching entry<select id="${mergeTargetId}"></select></label>
          <button id="${mergeButtonId}" type="button">Merge</button>
        </div>
      </div>
      <div class="entry-editor-actions">
        <button id="${saveButtonId}" type="${saveType}">Save</button>
        <button id="${cancelButtonId}" type="button">Cancel</button>
        <button id="${deleteButtonId}" class="danger" type="button">Delete</button>
      </div>
    </form>`;
}

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
  const template = document.createElement("template");
  template.innerHTML = `<form id="entry-editor-form" class="entry-editor-form">
    <label>Project<input id="entry-editor-project"></label>
    <label>Task<input id="entry-editor-task"></label>
    <label>Description<textarea id="entry-editor-description" rows="2"></textarea></label>
    <div class="entry-editor-options"><label><input id="entry-editor-multiply" type="checkbox">Multiply</label>
      <label class="entry-editor-status">Status<select id="entry-editor-status"><option value="ok">ok</option><option value="needs_review">needs_review</option></select></label>
      <button id="entry-editor-duplicate" type="button" hidden>Duplicate</button></div>
    <div class="entry-editor-datetime"><label>Start<input id="entry-editor-start" type="datetime-local" step="1" required></label>
      <label>End<input id="entry-editor-end" type="datetime-local" step="1"></label></div>
    <div class="entry-editor-merge"><div id="entry-editor-merge-control" class="entry-editor-merge-control" hidden>
      <label>Merge with matching entry<select id="entry-editor-merge-target"></select></label><button id="entry-editor-merge-button" type="button">Merge</button></div></div>
    <div class="entry-editor-actions"><button id="entry-editor-save" type="button">Save</button><button id="entry-editor-cancel" type="button">Cancel</button><button id="entry-editor-delete" class="danger" type="button">Delete</button></div>
  </form>`;
  const form = template.content.firstElementChild;
  const ids = [["entry-editor-form", formId], ["entry-editor-project", projectId], ["entry-editor-task", taskId], ["entry-editor-description", descriptionId], ["entry-editor-multiply", multiplyId], ["entry-editor-status", statusId], ["entry-editor-start", startId], ["entry-editor-end", endId], ["entry-editor-merge-control", mergeControlId], ["entry-editor-merge-target", mergeTargetId], ["entry-editor-merge-button", mergeButtonId], ["entry-editor-save", saveButtonId], ["entry-editor-cancel", cancelButtonId], ["entry-editor-delete", deleteButtonId]];
  for (const [from, to] of ids) form.querySelector(`#${from}`).id = to;
  const duplicate = form.querySelector("#entry-editor-duplicate");
  if (duplicateButtonId) { duplicate.id = duplicateButtonId; duplicate.hidden = false; }
  else duplicate.remove();
  form.querySelector(`#${saveButtonId}`).type = saveType;
  form.querySelector(`#${deleteButtonId}`).className = "danger";
  container.replaceChildren(form);
}

export function setEntryEditorMergeAvailability(control, hasTargets) {
  if (!control) return false;
  control.hidden = !hasTargets;
  return !control.hidden;
}

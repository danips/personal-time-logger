const EDITOR_IDS = Object.freeze({
  default: Object.freeze({
    form: "entry-editor-form",
    project: "entry-editor-project",
    task: "entry-editor-task",
    description: "entry-editor-description",
    multiply: "entry-editor-multiply",
    status: "entry-editor-status",
    start: "entry-editor-start",
    end: "entry-editor-end",
    mergeControl: "entry-editor-merge-control",
    mergeTarget: "entry-editor-merge-target",
    mergeButton: "entry-editor-merge-button",
    timeSummary: "entry-editor-time-summary",
    preview: "entry-editor-preview",
    previewText: "entry-editor-preview-text",
    previewConfirm: "entry-editor-preview-confirm",
    previewCancel: "entry-editor-preview-cancel",
    save: "entry-editor-save",
    cancel: "entry-editor-cancel",
    delete: "entry-editor-delete",
    duplicate: "entry-editor-duplicate"
  }),
  popup: Object.freeze({
    form: "editForm",
    project: "editProject",
    task: "editTask",
    description: "editDescription",
    multiply: "editMultiply",
    status: "editStatus",
    start: "editStart",
    end: "editEnd",
    mergeControl: "editMergeControl",
    mergeTarget: "mergeTarget",
    mergeButton: "mergeEdit",
    timeSummary: "editTimeSummary",
    preview: "editPreview",
    previewText: "editPreviewText",
    previewConfirm: "confirmEditPreview",
    previewCancel: "cancelEditPreview",
    save: "saveEdit",
    cancel: "cancelEdit",
    delete: "deleteEdit",
    duplicate: "editDuplicate"
  }),
  calendar: Object.freeze({
    form: "calendarEditForm",
    project: "calendarEditProject",
    task: "calendarEditTask",
    description: "calendarEditDescription",
    multiply: "calendarEditMultiply",
    status: "calendarEditStatus",
    start: "calendarEditStart",
    end: "calendarEditEnd",
    mergeControl: "calendarMergeControl",
    mergeTarget: "calendarMergeTarget",
    mergeButton: "calendarMergeButton",
    timeSummary: "calendarEditTimeSummary",
    preview: "calendarPreview",
    previewText: "calendarPreviewText",
    previewConfirm: "confirmCalendarPreview",
    previewCancel: "cancelCalendarPreview",
    save: "calendarSaveEntry",
    cancel: "cancelCalendarEditButton",
    delete: "deleteCalendarEntry",
    duplicate: "duplicateEntryButton"
  })
});

/** Mounts the shared markup and returns references scoped to this editor. */
export function mountEntryEditor(container, { variant = "default", showDuplicate = false, saveType = "button" } = {}) {
  if (!container) throw new TypeError("An entry editor container is required");
  const ids = EDITOR_IDS[variant];
  if (!ids) throw new TypeError(`Unknown entry editor variant: ${variant}`);
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
    <p id="entry-editor-time-summary" class="entry-editor-time-summary" hidden></p>
    <div class="entry-editor-merge"><div id="entry-editor-merge-control" class="entry-editor-merge-control" hidden>
      <label>Merge with matching entry<select id="entry-editor-merge-target"></select></label><button id="entry-editor-merge-button" type="button">Merge</button></div></div>
    <section id="entry-editor-preview" class="entry-editor-preview" hidden aria-live="polite">
      <strong>Review before saving</strong>
      <p id="entry-editor-preview-text"></p>
      <div class="entry-editor-preview-actions"><button id="entry-editor-preview-confirm" type="button">Confirm</button><button id="entry-editor-preview-cancel" type="button">Cancel</button></div>
    </section>
    <div class="entry-editor-actions"><button id="entry-editor-save" type="button">Save</button><button id="entry-editor-cancel" type="button">Cancel</button><button id="entry-editor-delete" class="danger" type="button">Delete</button></div>
  </form>`;
  const form = template.content.firstElementChild;
  const roleIds = [["entry-editor-form", ids.form], ["entry-editor-project", ids.project], ["entry-editor-task", ids.task], ["entry-editor-description", ids.description], ["entry-editor-multiply", ids.multiply], ["entry-editor-status", ids.status], ["entry-editor-start", ids.start], ["entry-editor-end", ids.end], ["entry-editor-time-summary", ids.timeSummary], ["entry-editor-merge-control", ids.mergeControl], ["entry-editor-merge-target", ids.mergeTarget], ["entry-editor-merge-button", ids.mergeButton], ["entry-editor-preview", ids.preview], ["entry-editor-preview-text", ids.previewText], ["entry-editor-preview-confirm", ids.previewConfirm], ["entry-editor-preview-cancel", ids.previewCancel], ["entry-editor-save", ids.save], ["entry-editor-cancel", ids.cancel], ["entry-editor-delete", ids.delete]];
  for (const [from, to] of roleIds) {
    const element = from === "entry-editor-form" ? form : form.querySelector(`#${from}`);
    element.id = to;
  }
  const duplicate = form.querySelector("#entry-editor-duplicate");
  if (showDuplicate) { duplicate.id = ids.duplicate; duplicate.hidden = false; }
  else duplicate.remove();
  form.querySelector(`#${ids.save}`).type = saveType;
  form.querySelector(`#${ids.delete}`).className = "danger";
  container.replaceChildren(form);
  return {
    form,
    fields: {
      project: form.querySelector(`#${ids.project}`),
      task: form.querySelector(`#${ids.task}`),
      description: form.querySelector(`#${ids.description}`),
      multiply: form.querySelector(`#${ids.multiply}`),
      status: form.querySelector(`#${ids.status}`),
      start: form.querySelector(`#${ids.start}`),
      end: form.querySelector(`#${ids.end}`)
    },
    timeSummary: form.querySelector(`#${ids.timeSummary}`),
    merge: {
      control: form.querySelector(`#${ids.mergeControl}`),
      target: form.querySelector(`#${ids.mergeTarget}`),
      button: form.querySelector(`#${ids.mergeButton}`)
    },
    preview: {
      panel: form.querySelector(`#${ids.preview}`),
      text: form.querySelector(`#${ids.previewText}`),
      confirm: form.querySelector(`#${ids.previewConfirm}`),
      cancel: form.querySelector(`#${ids.previewCancel}`)
    },
    actions: {
      save: form.querySelector(`#${ids.save}`),
      cancel: form.querySelector(`#${ids.cancel}`),
      delete: form.querySelector(`#${ids.delete}`),
      duplicate: showDuplicate ? form.querySelector(`#${ids.duplicate}`) : null
    }
  };
}

export function setEntryEditorMergeAvailability(control, hasTargets) {
  if (!control) return false;
  control.hidden = !hasTargets;
  return !control.hidden;
}

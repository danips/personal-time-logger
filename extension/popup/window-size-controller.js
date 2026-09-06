import { MAX_WINDOW_SIZE, normalizeWindowSizePreset, resizeCurrentWindow } from "../src/window-resize.js";

const DEFAULTS = Object.freeze([
  { width: 2000, height: 1000, isWindow: false },
  { width: 1500, height: 1000, isWindow: false },
  { width: 1300, height: 900, isWindow: false }
]);

/** Page-local controller for popup window-size state and browser mutations. */
export function createWindowSizeController({ presets, editor, fields, getSetting, setSetting, settingKey, platform, onError }) {
  let sizes = DEFAULTS.map((size) => ({ ...size }));
  let editing = [];
  let open = false;
  const read = () => [...fields.querySelectorAll(".window-size-field-row")].map((row) => ({
    width: Number(row.querySelector(".window-size-width").value),
    height: Number(row.querySelector(".window-size-height").value),
    isWindow: row.querySelector(".window-size-window-mode").checked
  }));
  const renderPresets = () => {
    const buttons = sizes.map((size) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "window-size-button";
      button.dataset.windowWidth = String(size.width);
      button.dataset.windowHeight = String(size.height);
      button.dataset.windowMode = String(size.isWindow);
      button.textContent = `${size.width}×${size.height}`;
      button.title = `${size.isWindow ? "Resize browser window" : "Resize viewport"} to ${size.width} by ${size.height}`;
      return button;
    });
    if (!buttons.length) {
      const empty = document.createElement("span");
      empty.className = "window-size-empty";
      empty.textContent = "No sizes";
      buttons.push(empty);
    }
    presets.replaceChildren(...buttons);
  };
  const renderEditor = () => {
    fields.replaceChildren(...editing.map((size, index) => {
      const row = document.createElement("div");
      row.className = "window-size-field-row";
      const width = document.createElement("input");
      width.className = "window-size-input window-size-width";
      width.type = "number";
      width.min = "1";
      width.max = String(MAX_WINDOW_SIZE);
      width.step = "1";
      width.value = String(size.width);
      width.setAttribute("aria-label", `Width for window size ${index + 1}`);
      const separator = document.createElement("span");
      separator.className = "window-size-separator";
      separator.textContent = "×";
      const height = document.createElement("input");
      height.className = "window-size-input window-size-height";
      height.type = "number";
      height.min = "1";
      height.max = String(MAX_WINDOW_SIZE);
      height.step = "1";
      height.value = String(size.height);
      height.setAttribute("aria-label", `Height for window size ${index + 1}`);
      const modeLabel = document.createElement("label");
      modeLabel.className = "window-size-mode";
      const mode = document.createElement("input");
      mode.className = "window-size-window-mode";
      mode.type = "checkbox";
      mode.checked = Boolean(size.isWindow);
      mode.setAttribute("aria-label", `Use outer window size for preset ${index + 1}`);
      const modeText = document.createElement("span");
      modeText.textContent = "Window";
      modeLabel.append(mode, modeText);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "window-size-remove danger";
      remove.dataset.removeWindowSize = String(index);
      remove.setAttribute("aria-label", `Remove window size ${index + 1}`);
      remove.textContent = "×";
      row.append(width, separator, height, modeLabel, remove);
      return row;
    }));
  };
  const setOpen = (next) => {
    open = Boolean(next);
    if (open) {
      editing = sizes.map((size) => ({ ...size }));
      renderEditor();
    }
    editor.classList.toggle("hidden", !open);
  };
  return {
    get isOpen() { return open; },
    get sizes() { return sizes; },
    read,
    renderPresets,
    setOpen,
    add() { editing = [...read(), { width: 1280, height: 720, isWindow: false }]; renderEditor(); },
    remove(index) { editing = read(); editing.splice(Number(index), 1); renderEditor(); },
    async resize(request) {
      try { await resizeCurrentWindow(request, platform); }
      catch (error) { onError(error); }
    },
    async save() {
      const normalized = read().map(normalizeWindowSizePreset);
      if (normalized.some((size) => !size)) {
        onError(new Error(`Window sizes must be whole numbers from 1 to ${MAX_WINDOW_SIZE}`));
        return;
      }
      sizes = normalized;
      await setSetting(settingKey, sizes);
      setOpen(false);
      renderPresets();
    },
    async load() {
      const stored = (await getSetting(settingKey, null))?.map?.(normalizeWindowSizePreset)?.filter(Boolean);
      if (stored?.length) sizes = stored;
      renderPresets();
    }
  };
}

const CONTRAST_STORAGE_KEY = "worklog.highContrast";

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readAppearancePreferences() {
  const local = storage();
  let highContrast = false;
  try { highContrast = local?.getItem(CONTRAST_STORAGE_KEY) === "true"; } catch { /* standard contrast */ }
  return { highContrast };
}

export function applyAppearancePreferences(preferences = readAppearancePreferences(), root = globalThis.document?.documentElement) {
  const normalized = { highContrast: Boolean(preferences.highContrast) };
  if (root) root.dataset.contrast = normalized.highContrast ? "high" : "standard";
  return normalized;
}

export function saveAppearancePreferences(preferences) {
  const normalized = applyAppearancePreferences(preferences);
  const local = storage();
  try { local?.setItem(CONTRAST_STORAGE_KEY, String(normalized.highContrast)); } catch { /* applied in memory */ }
  globalThis.dispatchEvent?.(new CustomEvent("worklog-appearance-change", { detail: normalized }));
  return normalized;
}

export function bindAppearanceControls({ contrastToggle, onChange } = {}) {
  const syncControls = (preferences = readAppearancePreferences()) => {
    const normalized = applyAppearancePreferences(preferences);
    if (contrastToggle) contrastToggle.checked = normalized.highContrast;
    return normalized;
  };
  const saveControls = () => {
    const saved = saveAppearancePreferences({
      highContrast: contrastToggle?.checked
    });
    onChange?.(saved);
  };

  contrastToggle?.addEventListener("change", saveControls);
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === CONTRAST_STORAGE_KEY) syncControls();
  });
  globalThis.addEventListener?.("worklog-appearance-change", (event) => syncControls(event.detail));
  return syncControls();
}

applyAppearancePreferences();

export const DEFAULT_THEME = "moss-circuit";

export const THEME_OPTIONS = Object.freeze([
  { id: "cinder-glow", label: "Cinder Glow", description: "Warm charcoal with amber highlights" },
  { id: "moss-circuit", label: "Moss Circuit", description: "Deep graphite with emerald highlights" },
  { id: "blue-archive", label: "Blue Archive", description: "Ink blue with crisp blue highlights" },
  { id: "violet-orbit", label: "Violet Orbit", description: "Midnight violet with soft purple highlights" },
  { id: "amethyst-stack", label: "Amethyst Stack", description: "Layered black with lavender highlights" },
  { id: "sienna-paper", label: "Sienna Paper", description: "Warm monochrome with coral highlights" },
  { id: "harbor-terminal", label: "Harbor Terminal", description: "Editor gray with electric blue highlights" }
]);

const THEME_IDS = new Set(THEME_OPTIONS.map(({ id }) => id));
const LEGACY_THEME_IDS = Object.freeze({
  darcula: "cinder-glow",
  codex: "moss-circuit",
  github: "blue-archive",
  linear: "violet-orbit",
  material: "amethyst-stack",
  notion: "sienna-paper",
  vscode: "harbor-terminal"
});
const THEME_STORAGE_KEY = "worklog.theme";
const CONTRAST_STORAGE_KEY = "worklog.highContrast";

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function normalizeTheme(value) {
  const theme = String(value || "").trim().toLowerCase();
  return THEME_IDS.has(theme) ? theme : LEGACY_THEME_IDS[theme] || DEFAULT_THEME;
}

export function readThemePreferences() {
  const local = storage();
  return {
    theme: normalizeTheme(local?.getItem(THEME_STORAGE_KEY)),
    highContrast: local?.getItem(CONTRAST_STORAGE_KEY) === "true"
  };
}

export function applyThemePreferences(preferences = readThemePreferences(), root = globalThis.document?.documentElement) {
  const normalized = {
    theme: normalizeTheme(preferences.theme),
    highContrast: Boolean(preferences.highContrast)
  };
  if (root) {
    root.dataset.theme = normalized.theme;
    root.dataset.contrast = normalized.highContrast ? "high" : "standard";
  }
  return normalized;
}

export function saveThemePreferences(preferences) {
  const normalized = applyThemePreferences(preferences);
  const local = storage();
  local?.setItem(THEME_STORAGE_KEY, normalized.theme);
  local?.setItem(CONTRAST_STORAGE_KEY, String(normalized.highContrast));
  globalThis.dispatchEvent?.(new CustomEvent("worklog-theme-change", { detail: normalized }));
  return normalized;
}

export function bindThemeControls({ themeSelect, contrastToggle, onChange } = {}) {
  const syncControls = (preferences = readThemePreferences()) => {
    const normalized = applyThemePreferences(preferences);
    if (themeSelect) themeSelect.value = normalized.theme;
    if (contrastToggle) contrastToggle.checked = normalized.highContrast;
    return normalized;
  };
  const saveControls = () => {
    const saved = saveThemePreferences({
      theme: themeSelect?.value,
      highContrast: contrastToggle?.checked
    });
    onChange?.(saved);
  };

  themeSelect?.addEventListener("change", saveControls);
  contrastToggle?.addEventListener("change", saveControls);
  globalThis.addEventListener?.("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === CONTRAST_STORAGE_KEY) syncControls();
  });
  globalThis.addEventListener?.("worklog-theme-change", (event) => syncControls(event.detail));
  return syncControls();
}

applyThemePreferences();

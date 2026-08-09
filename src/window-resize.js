export const MAX_WINDOW_SIZE = 10_000;

function resizeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

/** Validates data at the browser-window mutation boundary. */
export function windowResizeRequest(width, height, isWindow) {
  if (typeof isWindow !== "boolean") {
    throw resizeError("WINDOW_MODE_INVALID", "Window resize mode must be a boolean.");
  }
  const next = { width: Number(width), height: Number(height), isWindow };
  if (!Number.isInteger(next.width) || !Number.isInteger(next.height)
    || next.width < 1 || next.width > MAX_WINDOW_SIZE
    || next.height < 1 || next.height > MAX_WINDOW_SIZE) {
    throw resizeError("WINDOW_SIZE_INVALID", `Window sizes must be whole numbers from 1 to ${MAX_WINDOW_SIZE}.`);
  }
  return next;
}

export function normalizeWindowSizePreset(value) {
  try {
    return windowResizeRequest(value?.width, value?.height, value?.isWindow === true || value?.isWindow === "true");
  } catch {
    return null;
  }
}

export function windowDimensionsForRequest(request, target, tab = null) {
  const size = windowResizeRequest(request?.width, request?.height, request?.isWindow);
  if (!Number.isInteger(target?.id) || !Number.isInteger(target?.width) || !Number.isInteger(target?.height)
    || target.width < 1 || target.height < 1) {
    throw resizeError("WINDOW_UNAVAILABLE", "No browser window with usable dimensions is available.");
  }
  if (size.isWindow) return { windowId: target.id, width: size.width, height: size.height };
  if (!Number.isInteger(tab?.width) || !Number.isInteger(tab?.height) || tab.width < 1 || tab.height < 1) {
    throw resizeError("VIEWPORT_UNAVAILABLE", "Could not read the current tab viewport size.");
  }
  const chromeWidth = target.width - tab.width;
  const chromeHeight = target.height - tab.height;
  if (chromeWidth < 0 || chromeHeight < 0) {
    throw resizeError("WINDOW_CHROME_INVALID", "Browser window dimensions are smaller than its viewport; resize was not applied.");
  }
  // Do not silently clamp: the user asked for an exact viewport. Browser-level
  // limits are reported by resizeWindow rather than changing that request.
  return { windowId: target.id, width: size.width + chromeWidth, height: size.height + chromeHeight };
}

export async function resizeCurrentWindow(request, browserWindow) {
  // Validate first, before reading browser state or accepting tampered dataset
  // values from a future caller.
  const size = windowResizeRequest(request?.width, request?.height, request?.isWindow);
  const target = await browserWindow.getCurrentWindow();
  const tab = size.isWindow ? null : await browserWindow.getCurrentTab(target?.id);
  const dimensions = windowDimensionsForRequest(size, target, tab);
  await browserWindow.resizeWindow(dimensions.windowId, dimensions.width, dimensions.height);
  return dimensions;
}

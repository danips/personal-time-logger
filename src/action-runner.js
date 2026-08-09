const activeActions = new Map();

async function safely(callback, value) {
  try {
    return await callback?.(value);
  } catch {
    return undefined;
  }
}

/**
 * Runs one user action at a time for a stable idempotency key. Errors are
 * reported through the supplied callback rather than becoming unhandled event
 * listener rejections, and the final refresh runs after either outcome.
 */
export function runAction(key, action, {
  setBusy,
  onError,
  onFinally,
  expectedRevision
} = {}) {
  const actionKey = String(key || "");
  if (!actionKey) throw new TypeError("An action idempotency key is required");
  if (activeActions.has(actionKey)) return activeActions.get(actionKey);

  const pending = (async () => {
    void safely(setBusy, true);
    try {
      return await action({ expectedRevision });
    } catch (error) {
      await safely(onError, error);
      return undefined;
    } finally {
      await safely(onFinally);
      await safely(setBusy, false);
      activeActions.delete(actionKey);
    }
  })();
  activeActions.set(actionKey, pending);
  return pending;
}

export function isActionRunning(key) {
  return activeActions.has(String(key || ""));
}

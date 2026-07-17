const ENTRY_EVENTS_CHANNEL = "timelogger_entries";

let channel = null;

function getChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(ENTRY_EVENTS_CHANNEL);
  return channel;
}

export function notifyEntriesChanged(detail = {}) {
  const target = getChannel();
  if (!target) return;
  target.postMessage({
    type: "entries_changed",
    timestamp: Date.now(),
    ...detail
  });
}

export function onEntriesChanged(handler) {
  const target = getChannel();
  if (!target) return () => {};

  const listener = (event) => {
    if (!event.data || event.data.type !== "entries_changed") return;
    handler(event.data);
  };

  target.addEventListener("message", listener);
  return () => {
    target.removeEventListener("message", listener);
  };
}

const FORMULA_PREFIX = /^[=+\-@]/;

function cell(value) {
  let text = String(value ?? "");
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function row(values) {
  return values.map(cell).join(",");
}

function location(item) {
  if (item?.rowIndex) return `row ${item.rowIndex}`;
  if (item?.ref?.version !== undefined) return `record version ${item.ref.version}`;
  return "unknown record";
}

/** Exports only safe quarantine metadata, never raw invalid remote payloads. */
export function serializeQuarantinedRecords(items = [], { provider = "Remote storage" } = {}) {
  const lines = [
    row(["Invalid remote records"]),
    row(["Provider", provider]),
    "",
    row(["Entry ID", "Location", "Reason"])
  ];
  for (const item of items || []) lines.push(row([item.id || "", location(item), item.reason || "invalid record"]));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Seeds records through the production mutation path without exporting test-only
 * write helpers from the runtime repository module.
 */
export async function seedEntry(db, entry) {
  await db.mutateEntries([entry.id], (entries) => {
    entries.set(entry.id, entry);
  });
  return entry;
}

export async function seedEntries(db, entries) {
  const values = Array.isArray(entries) ? entries : [];
  if (!values.length) return;
  await db.mutateEntries(values.map((entry) => entry.id), (stored) => {
    for (const entry of values) stored.set(entry.id, entry);
  });
}

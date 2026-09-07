import {
  chunkByEncodedBytes,
  parseAppendAcknowledgements,
  parseRemoteVersion,
  persistedEntry
} from "./remote-api-client.js";

/**
 * Shared mechanics for providers whose remote references are opaque versions.
 * Provider identity, configuration, health checks, and permissions stay in the
 * adapter that constructs these operations.
 */
export function createVersionedMutationOperations({ configuredClient, chunkOptions, entryRefKind }) {
  const chunks = (values, envelopeKey, encode) => chunkByEncodedBytes(values, {
    ...chunkOptions,
    envelopeKey,
    encode
  });

  return Object.freeze({
    async appendEntries(entries, options = {}) {
      if (!entries.length) return [];
      const client = await configuredClient(options);
      const acknowledgements = [];
      for (const chunk of chunks(entries, "entries", persistedEntry)) {
        const data = client.appendEncoded
          ? await client.appendEncoded(chunk.encodedBody)
          : await client.append(chunk.map(persistedEntry));
        acknowledgements.push(...parseAppendAcknowledgements(data.entries, chunk.map((entry) => entry.id), entryRefKind));
      }
      const byId = new Map(acknowledgements.map((record) => [record.id, record]));
      return entries.map((entry) => byId.get(entry.id));
    },

    async updateEntries(updates, options = {}) {
      if (!updates.length) return;
      const client = await configuredClient(options);
      for (const chunk of chunks(updates, "updates", ({ entry, expectedRef }) => ({
        entry: persistedEntry(entry), expectedVersion: parseRemoteVersion(expectedRef?.version)
      }))) {
        if (client.updateEncoded) await client.updateEncoded(chunk.encodedBody);
        else await client.update(chunk.map(({ entry, expectedRef }) => ({
          entry: persistedEntry(entry), expectedVersion: parseRemoteVersion(expectedRef?.version)
        })));
      }
    },

    async deleteEntries(preconditions, options = {}) {
      if (!preconditions.length) return;
      const client = await configuredClient(options);
      for (const chunk of chunks(preconditions, "preconditions", ({ id, expectedRef }) => ({
        id, expectedVersion: parseRemoteVersion(expectedRef?.version)
      }))) {
        if (client.deleteEncoded) await client.deleteEncoded(chunk.encodedBody);
        else await client.delete(chunk.map(({ id, expectedRef }) => ({
          id, expectedVersion: parseRemoteVersion(expectedRef?.version)
        })));
      }
    },

    async updateConfig(key, value, updatedAt, { expectedRef, ...options } = {}) {
      await (await configuredClient(options)).updateConfig({
        key,
        value,
        updated_at: updatedAt,
        ...(expectedRef ? { expectedVersion: parseRemoteVersion(expectedRef.version) } : {})
      });
    }
  });
}

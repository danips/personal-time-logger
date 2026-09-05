/* global fetch, process, console */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function assertHttpContract(baseUrl, token) {
  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers }
    });
    return { response, body: await response.json() };
  };

  const wrongMethod = await request("/v1/health", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.body.error.code, "METHOD_NOT_ALLOWED");

  const wrongType = await request("/v1/entries/append", { method: "POST", body: JSON.stringify({ entries: [] }) });
  assert.equal(wrongType.response.status, 400);
  assert.equal(wrongType.body.error.code, "INVALID_REQUEST");

  const unknownField = await request("/v1/entries/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [], unexpected: true })
  });
  assert.equal(unknownField.response.status, 400);
  assert.equal(unknownField.body.error.code, "INVALID_REQUEST");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , baseUrl, token] = process.argv;
  if (!baseUrl || !token) throw new Error("Usage: node server/http-contract.mjs BASE_URL TOKEN");
  await assertHttpContract(baseUrl, token);
  console.log("HTTP contract checks passed.");
}

export async function readBoundedJson(response, maxBytes, errorFor) {
  const fail = (reason) => { throw errorFor(reason); };
  const declaredLength = Number(response.headers?.get?.("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) fail("response is too large");

  let text = "";
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel();
          fail("response is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) fail("response is too large");
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    fail("response contains malformed JSON");
  }
}

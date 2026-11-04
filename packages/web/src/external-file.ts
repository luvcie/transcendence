export async function fetchExternalFile(url: string, limit: number, signal: AbortSignal, timeoutMs = 12000): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Could not load file (HTTP ${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file was empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("The file is too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

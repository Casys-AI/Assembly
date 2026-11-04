import { SavedSystemError } from "../../../../domain/work/records/saved-systems.ts";

export async function readWorkCommandBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "A JSON command is required.",
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "The JSON command exceeds its bounds.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(joined),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SavedSystemError("INVALID_COMMAND", "A JSON object is required.");
  }
  return value;
}

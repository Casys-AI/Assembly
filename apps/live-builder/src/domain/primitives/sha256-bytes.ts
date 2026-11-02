/** Artifact byte contract: copies the exact view; runtime undefined throws. */
export async function sha256Bytes(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

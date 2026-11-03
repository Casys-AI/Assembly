/** Git SHA-1 blob identity, independent of source/model SHA-256 identities.
 * This adapter already admits only 40-hex Git object IDs. Use UTF-8 byte length,
 * not JavaScript character count, matching `git hash-object --stdin` exactly.
 * An ID is only a reuse hint: complete immutable-tree read-back remains required.
 */
export async function gitBlobIdentity(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", object)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

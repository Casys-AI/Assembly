import { canonical } from "./canonical-json.ts";
import { persistedOrder } from "./persisted-order.ts";
import { sha256Bytes } from "./sha256-bytes.ts";
/** Stable semantic encoding excludes operational catalog entries and visual layout. */
// Execution digests are already persisted in pins: key order stays locale-based
// but pinned to en-US, so a host default of da_DK or tr_TR cannot move them.
export async function executionDigest(value: unknown): Promise<string> {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
      ? Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => persistedOrder(a, b))
          .map((
            [k, value],
          ) => [k, stable(value)]),
      )
      : v;
  return await sha256(JSON.stringify(stable(value)));
}

/** TextEncoder string contract; runtime undefined retains its empty-byte encoding. */
export async function sha256(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

/** Preserve semantic canonical bytes, including canonical(undefined). */
export async function canonicalDigest(value: unknown): Promise<string> {
  return await sha256(canonical(value));
}

/** Strict string boundary; do not replace coercive regexp-only checks (C-Dup). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

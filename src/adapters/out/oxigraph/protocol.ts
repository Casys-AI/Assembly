/** Small, closed JSON control protocol. Storage paths and RDF/artifact bytes
 * are never request fields; paths belong to process startup composition. */
import type { ProjectionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { parseProjectionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { SemanticIndexError } from "../../../application/model/semantic/index-service.ts";
import {
  type SemanticProjectionPreparationInput,
  snapshotSemanticPreparationInput,
} from "./preparation.ts";

export const SEMANTIC_PREPARATION_MAX_CONTROL_BYTES = 65_536;
const FAILURE_CODES = new Set([
  "BUILD_BLOB_CORRUPT",
  "BUILD_BLOB_MISSING",
  "BUILD_BLOB_CONFLICT",
  "BUILD_STORE_UNAVAILABLE",
  "BUILD_STORE_BUSY",
  "BUILD_STORE_QUOTA_EXCEEDED",
  "BUILD_STORE_INVALID_INPUT",
  "BUILD_DESCRIPTOR_MISMATCH",
  "BUILD_SOURCE_MISMATCH",
  "BUILD_CORRUPT",
  "BUILD_MATERIALIZATION_INCOMPATIBLE",
  "BUILD_RECIPE_UNAVAILABLE",
  "BUILD_OUTPUT_MISMATCH",
  "BUILD_UNAVAILABLE",
  "ARTIFACT_TOO_LARGE",
  "BUILD_INVALID_INPUT",
  "BUILD_RECIPE_INVALID",
  "BUILD_DESCRIPTOR_INVALID",
  "MODEL_REF_INVALID",
  "INDEX_INVALID_INPUT",
  "INDEX_QUERY_REFUSED",
  "INDEX_PROJECTION_MISSING",
  "INDEX_PROJECTION_CORRUPT",
  "INDEX_QUERY_LIMIT",
  "INDEX_TIMEOUT",
  "INDEX_BUSY",
  "INDEX_UNAVAILABLE",
  "RDF_PROJECTION_INVALID",
  "RDF_PROJECTION_UNSUPPORTED",
]);
export interface SemanticPreparationRequest {
  readonly v: 1;
  readonly id: number;
  readonly input: SemanticProjectionPreparationInput;
}
export interface SemanticPreparationFailure {
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly recovery: string;
}
export type SemanticPreparationResponse =
  | {
    readonly v: 1;
    readonly id: number;
    readonly ok: true;
    readonly projection: ProjectionRef;
  }
  | {
    readonly v: 1;
    readonly id: number;
    readonly ok: false;
    readonly error: SemanticPreparationFailure;
  };

function invalid(): never {
  throw new SemanticIndexError(
    "INDEX_UNAVAILABLE",
    {},
    "Invalid semantic preparation control message",
  );
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) invalid();
  return value as Record<string, unknown>;
}
function requestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
export function parseSemanticPreparationRequest(
  value: unknown,
): SemanticPreparationRequest {
  const input = record(value, ["v", "id", "input"]);
  if (input.v !== 1) invalid();
  return {
    v: 1,
    id: requestId(input.id),
    input: snapshotSemanticPreparationInput(input.input),
  };
}
export function parseSemanticPreparationResponse(
  value: unknown,
  expectedId: number,
): SemanticPreparationResponse {
  const input = record(value, ["v", "id", "ok", "projection", "error"]);
  if (input.v !== 1 || requestId(input.id) !== expectedId) invalid();
  if (input.ok === true && !Object.hasOwn(input, "error")) {
    return {
      v: 1,
      id: expectedId,
      ok: true,
      projection: parseProjectionRef(input.projection),
    };
  }
  if (input.ok !== false || Object.hasOwn(input, "projection")) invalid();
  const error = record(input.error, ["code", "message", "context", "recovery"]);
  if (
    typeof error.code !== "string" || !FAILURE_CODES.has(error.code) ||
    typeof error.message !== "string" || error.message.length > 8192 ||
    typeof error.recovery !== "string" || error.recovery.length > 8192 ||
    !error.context || typeof error.context !== "object" ||
    Array.isArray(error.context)
  ) invalid();
  return {
    v: 1,
    id: expectedId,
    ok: false,
    error: error as unknown as SemanticPreparationFailure,
  };
}
export function semanticPreparationFailure(
  error: unknown,
): SemanticPreparationFailure {
  const detail = error as {
    code?: unknown;
    context?: unknown;
    recovery?: unknown;
  } | null;
  return {
    code: typeof detail?.code === "string" && FAILURE_CODES.has(detail.code)
      ? detail.code
      : "INDEX_UNAVAILABLE",
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      8192,
    ),
    context: detail?.context && typeof detail.context === "object" &&
        !Array.isArray(detail.context)
      ? detail.context as Readonly<Record<string, unknown>>
      : {},
    recovery: typeof detail?.recovery === "string"
      ? detail.recovery.slice(0, 8192)
      : "Retry semantic preparation after restoring the exact build cache and vault.",
  };
}
export function encodeSemanticPreparationControl(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > SEMANTIC_PREPARATION_MAX_CONTROL_BYTES) invalid();
  return bytes;
}
export async function readSemanticPreparationControl(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > SEMANTIC_PREPARATION_MAX_CONTROL_BYTES) invalid();
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

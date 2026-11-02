/**
 * APE 5.2 Governed Memory Promotion: candidate content, admission policy, versions and
 * guidance status; storage alone does not establish promotion.
 */
import { executionDigest } from "../primitives/execution-digest.ts";
import type { BehaviorModelVersion } from "../shared-kernel/behavior-model-version.ts";
import type {
  MemoryContent,
  MemoryOperation,
  MemoryOperationEvent,
  MemoryRecord,
  MemoryStatus,
} from "./entities/memory-record.ts";

/**
 * The bound for a governed-memory admission or withdrawal reason, counted
 * in `String.length`. It is this concept's own bound, not the human
 * conversation-message bound.
 */
export const MAX_GOVERNED_MEMORY_REASON_CHARS = 8_000;

export type MemoryPermission =
  | Exclude<MemoryOperation, "request-revision">
  | "recall";

/** Values and native grants compiled from the admitted model, never agent input. */
export interface MemoryPolicy {
  id: string;
  ownerId: string;
  modelVersion: BehaviorModelVersion;
  allowedScopes: string[];
  permissions: Partial<Record<MemoryPermission, string[]>>;
  requireSourceRefs: boolean;
  requireKnownOutcome: boolean;
  maxValidityMs: number;
  allowSelfAdmission: boolean;
}

/** Constructed by the native behavior binding after admission of its invocation. */
export interface MemoryAuthority {
  callerId: string;
  behaviorId: string;
  invocationId: string;
  modelVersion: BehaviorModelVersion;
  policy: MemoryPolicy;
}

export interface MemoryExpectedVersion {
  revision: number;
  digest: string;
}

/** Trusted internal audit view. Its history may contain versions from former
 * scopes. Agent-facing boundaries must publish memoryGuidance(view), never this
 * full audit object; current scope admission is not historical disclosure. */
export interface MemoryView extends MemoryRecord {
  /** Expiry is evaluated at read time and never silently writes a new version. */
  effectiveStatus: MemoryStatus | "expired";
  usableAsGuidance: boolean;
}

/** A decision may consult an exact current note without carrying its full log. */
export type MemoryGuidance = Omit<MemoryView, "history"> & {
  historyLength: number;
};

export function memoryGuidance(view: MemoryView): MemoryGuidance {
  const { history, ...current } = view;
  return { ...structuredClone(current), historyLength: history.length };
}

export interface MemoryReceipt {
  /** Current state, including a withdrawal that followed an idempotent replay. */
  memory: MemoryView;
  /** Trusted audit evidence of the exact operation originally committed. A
   * transport to an agent must omit its content and publish only metadata. */
  operation: MemoryOperationEvent;
  replayed: boolean;
}

export type MemoryErrorCode =
  | "invalid"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "expired"
  | "provenance";

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super("Governed memory: " + message);
    this.name = "MemoryError";
  }
}

export function requireMemory(
  condition: unknown,
  code: MemoryErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new MemoryError(code, message);
}

export function memoryIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 512;
}

function stringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(memoryIdentity) &&
    new Set(value).size === value.length;
}

/** Content is closed data. Accessors, prototype-bearing instances and hidden
 * extra keys are not an alternate representation of the admitted contract. */
function closedMemoryObject(
  value: unknown,
  fields: readonly string[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length &&
    keys.every((key) =>
      typeof key === "string" && fields.includes(key) &&
      "value" in Object.getOwnPropertyDescriptor(value, key)!
    );
}

export function memoryTime(value: string): number {
  requireMemory(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value),
    "invalid",
    "timestamp must declare its time zone",
  );
  const at = Date.parse(value);
  requireMemory(Number.isFinite(at), "invalid", "invalid timestamp");
  return at;
}

/** Representation checks do not establish that a referenced decision exists. */
export function validateMemoryContent(content: MemoryContent): void {
  requireMemory(
    closedMemoryObject(content, [
      "text",
      "origin",
      "scope",
      "validUntil",
      "outcome",
    ]),
    "invalid",
    "candidate content has missing or undeclared fields",
  );
  requireMemory(
    content && typeof content.text === "string" && content.text.trim() &&
      content.text.length <= 65_536,
    "invalid",
    "candidate text is missing or too large",
  );
  requireMemory(
    closedMemoryObject(content.origin, ["decisionId", "sourceRefs"]) &&
      memoryIdentity(content.origin.decisionId) &&
      stringSet(content.origin.sourceRefs),
    "invalid",
    "candidate must identify its originating decision and source references",
  );
  requireMemory(
    stringSet(content.scope) && content.scope.length > 0,
    "invalid",
    "candidate must have an explicit scope",
  );
  requireMemory(
    typeof content.validUntil === "string",
    "invalid",
    "candidate must have a validity deadline",
  );
  memoryTime(content.validUntil);
  const outcome = content.outcome;
  requireMemory(
    (closedMemoryObject(outcome, ["status"]) && outcome.status === "pending") ||
      (closedMemoryObject(outcome, ["status", "summary", "evidenceRefs"]) &&
        outcome.status === "known"),
    "invalid",
    "candidate must preserve its outcome status",
  );
  if (outcome.status === "known") {
    requireMemory(
      typeof outcome.summary === "string" && outcome.summary.trim() &&
        outcome.summary.length <= 65_536 &&
        stringSet(outcome.evidenceRefs) && outcome.evidenceRefs.length > 0,
      "invalid",
      "a known outcome requires its description and evidence references",
    );
  } else {
    requireMemory(
      Object.keys(outcome).every((key) => key === "status"),
      "invalid",
      "pending outcome cannot claim confirmed feedback",
    );
  }
}

export function requireMemoryPermission(
  authority: MemoryAuthority,
  permission: MemoryPermission,
): void {
  const policy = authority.policy;
  requireMemory(
    policy && memoryIdentity(policy.id) && memoryIdentity(policy.ownerId) &&
      memoryIdentity(authority.callerId) &&
      memoryIdentity(authority.behaviorId) &&
      memoryIdentity(authority.invocationId) &&
      memoryIdentity(authority.modelVersion?.digest) &&
      memoryIdentity(authority.modelVersion?.repositoryVersion) &&
      policy.modelVersion?.digest === authority.modelVersion.digest &&
      policy.modelVersion?.repositoryVersion ===
        authority.modelVersion.repositoryVersion,
    "forbidden",
    "authority is not pinned to its admitted native model",
  );
  requireMemory(
    stringSet(policy.allowedScopes) && policy.allowedScopes.length > 0 &&
      Number.isSafeInteger(policy.maxValidityMs) && policy.maxValidityMs > 0 &&
      typeof policy.requireSourceRefs === "boolean" &&
      typeof policy.requireKnownOutcome === "boolean" &&
      typeof policy.allowSelfAdmission === "boolean",
    "invalid",
    "incomplete modeled memory policy",
  );
  requireMemory(
    stringSet(policy.permissions?.[permission]) &&
      policy.permissions[permission]!.includes(authority.callerId),
    "forbidden",
    `native caller has no ${permission} permission`,
  );
}

export function requireMemoryPolicy(
  content: MemoryContent,
  policy: MemoryPolicy,
  at: string,
  admission = false,
): void {
  validateMemoryContent(content);
  requireMemory(
    content.scope.every((scope) => policy.allowedScopes.includes(scope)),
    "forbidden",
    "candidate scope exceeds the modeled scopes",
  );
  const remaining = memoryTime(content.validUntil) - memoryTime(at);
  requireMemory(remaining > 0, "expired", "candidate validity has expired");
  requireMemory(
    remaining <= policy.maxValidityMs,
    "invalid",
    "candidate validity exceeds the modeled lifetime",
  );
  requireMemory(
    !policy.requireSourceRefs || content.origin.sourceRefs.length > 0,
    "invalid",
    "modeled policy requires source references",
  );
  requireMemory(
    !admission || !policy.requireKnownOutcome ||
      content.outcome.status === "known",
    "forbidden",
    "modeled admission requires a known outcome",
  );
}

export async function memoryContentDigest(
  ownerId: string,
  content: MemoryContent,
): Promise<string> {
  return await executionDigest({ ownerId, content });
}

export function memoryView(
  record: MemoryRecord,
  at: string,
  policy?: MemoryPolicy,
): MemoryView {
  const expired = memoryTime(record.content.validUntil) <= memoryTime(at);
  const permitted = !policy || (
    record.content.scope.every((scope) =>
      policy.allowedScopes.includes(scope)
    ) &&
    (!policy.requireKnownOutcome ||
      record.content.outcome.status === "known") &&
    (!policy.requireSourceRefs || record.content.origin.sourceRefs.length > 0)
  );
  return {
    ...structuredClone(record),
    effectiveStatus: expired ? "expired" : record.status,
    usableAsGuidance: record.status === "admitted" && !expired && permitted,
  };
}

export function requireMemoryVersion(
  record: MemoryRecord,
  expected: MemoryExpectedVersion,
): void {
  requireMemory(
    expected && Number.isSafeInteger(expected.revision) &&
      expected.revision >= 1 && memoryIdentity(expected.digest) &&
      record.revision === expected.revision &&
      record.digest === expected.digest,
    "conflict",
    "candidate revision or digest changed",
  );
}

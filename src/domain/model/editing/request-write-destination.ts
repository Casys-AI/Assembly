import { isSha256Hex } from "../../primitives/execution-digest.ts";
import { ModelWriteCommandError } from "./write-command.ts";
import {
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../value-objects/element-ref.ts";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function invalid(reason: string, path: string): never {
  throw new ModelWriteCommandError(
    "WRITE_COMMAND_INVALID",
    { reason, path },
    `${reason}: ${path}`,
  );
}
/** Internal, server-resolved immutable destination. Decoding establishes shape
 * and consistency only: it authenticates no principal and grants no write.
 * Never accept this object as a public HTTP/provider command field. */
export interface RequestModelWriteDestination {
  readonly v: 1;
  readonly kind: "request";
  readonly repositoryId: string;
  readonly host: { readonly projectId: string; readonly systemId: string };
  readonly openingId: string;
  readonly executionSpaceId: string;
  readonly caseId: string;
  readonly branchId: string;
  readonly ref: string;
  readonly expectedAdmittedSource: {
    readonly revision: number;
    readonly source: ModelRevisionRef;
    readonly sourceDigest: string;
  };
}

function object(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Expected an object", path);
  }
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(entry, key))
  ) invalid("Expected exact fields", path);
  return entry;
}
function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 512 ||
    // deno-lint-ignore no-control-regex -- Host identities must not contain control characters.
    /[\x00-\x1f\x7f]/.test(value)
  ) invalid("Expected bounded identity", path);
  return value;
}
function identity(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    invalid("Expected bounded locator", path);
  }
  return value;
}

const LOCATOR_FIELDS = [
  "v",
  "kind",
  "repositoryId",
  "host",
  "openingId",
  "executionSpaceId",
  "caseId",
  "branchId",
  "ref",
] as const;
export type RequestModelWriteLocator = Omit<
  RequestModelWriteDestination,
  "expectedAdmittedSource"
>;
/** Static owned Request locator; no synthetic current version or permission. */
export function parseRequestModelWriteLocator(
  value: unknown,
): RequestModelWriteLocator {
  const target = object(value, LOCATOR_FIELDS, "destination");
  if (target.v !== 1 || target.kind !== "request") {
    invalid("Unsupported destination", "destination.kind");
  }
  const repositoryId = text(target.repositoryId, "destination.repositoryId");
  const host = object(
    target.host,
    ["projectId", "systemId"],
    "destination.host",
  );
  const branchId = text(target.branchId, "destination.branchId");
  if (!UUID.test(branchId)) {
    invalid("Expected canonical Request branch UUID", "destination.branchId");
  }
  const ref = `refs/heads/requests/${branchId}`;
  if (target.ref !== ref) {
    invalid("Ref differs from canonical Request branch", "destination.ref");
  }
  const executionSpaceId = identity(
    target.executionSpaceId,
    "destination.executionSpaceId",
  );
  if (executionSpaceId === "main") {
    invalid(
      "Request destination cannot be Main",
      "destination.executionSpaceId",
    );
  }
  return {
    v: 1,
    kind: "request",
    repositoryId,
    host: {
      projectId: text(host.projectId, "destination.host.projectId"),
      systemId: text(host.systemId, "destination.host.systemId"),
    },
    openingId: identity(target.openingId, "destination.openingId"),
    executionSpaceId,
    caseId: identity(target.caseId, "destination.caseId"),
    branchId,
    ref,
  };
}

export function parseRequestModelWriteDestination(
  value: unknown,
): RequestModelWriteDestination {
  const target = object(
    value,
    [...LOCATOR_FIELDS, "expectedAdmittedSource"],
    "destination",
  );
  const { expectedAdmittedSource, ...locatorInput } = target;
  const locator = parseRequestModelWriteLocator(locatorInput);
  const repositoryId = locator.repositoryId;
  const expected = object(expectedAdmittedSource, [
    "revision",
    "source",
    "sourceDigest",
  ], "destination.expectedAdmittedSource");
  if (
    typeof expected.revision !== "number" ||
    !Number.isSafeInteger(expected.revision) || expected.revision < 1
  ) {
    invalid(
      "Expected positive safe admitted revision",
      "destination.expectedAdmittedSource.revision",
    );
  }
  const source = parseModelRevisionRef(expected.source);
  if (source.repositoryId !== repositoryId) {
    invalid(
      "Admitted source repository differs",
      "destination.expectedAdmittedSource.source",
    );
  }
  if (
    !isSha256Hex(expected.sourceDigest)
  ) {
    invalid(
      "Expected exact source digest",
      "destination.expectedAdmittedSource.sourceDigest",
    );
  }
  return {
    ...locator,
    expectedAdmittedSource: {
      revision: expected.revision,
      source,
      sourceDigest: expected.sourceDigest,
    },
  };
}

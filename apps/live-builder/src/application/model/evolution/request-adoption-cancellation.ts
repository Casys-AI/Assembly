import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { exactSourceVersion } from "../../../domain/work/request-spaces.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import { RequestAdoptionError } from "./request-adoption-ports.ts";

interface RequestCancellationNativeObservation {
  readonly retired: boolean;
  readonly authorizedPin: unknown | null;
  readonly runPin: unknown | null;
}
type Pin = { readonly digest: string; readonly repositoryVersion: string };
function refuse(): never {
  throw new RequestAdoptionError(
    "UNAVAILABLE",
    "The native no-effect pins disagree or are unknown; the barrier is retained.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function pin(digest: unknown, repositoryVersion: unknown): Pin {
  if (
    !isSha256Hex(digest) ||
    !exactSourceVersion(repositoryVersion)
  ) refuse();
  return { digest, repositoryVersion };
}
/** Neither physical pin may hide the other. Historical retired rows retain
 * only pins already proved by this exact Request's executed lineage. */
export function assertRequestCancellationNativePins(
  observations: readonly RequestCancellationNativeObservation[],
  expected: {
    readonly identity: ModelIdentity;
    readonly previous: Pin;
    readonly candidate: Pin;
    readonly executed: readonly Pin[];
  },
): void {
  const snapshot = structuredClone({ observations, expected });
  if (!snapshot.observations.length || snapshot.observations.length > 256) {
    refuse();
  }
  const previous = canonical(
    pin(
      snapshot.expected.previous.digest,
      snapshot.expected.previous.repositoryVersion,
    ),
  );
  const candidate = canonical(
    pin(
      snapshot.expected.candidate.digest,
      snapshot.expected.candidate.repositoryVersion,
    ),
  );
  const executed = new Set(
    snapshot.expected.executed.map((item) =>
      canonical(pin(item.digest, item.repositoryVersion))
    ),
  );
  for (const row of snapshot.observations) {
    if (typeof row.retired !== "boolean") refuse();
    let authorized: Pin | null = null, run: Pin | null = null;
    if (row.authorizedPin !== null) {
      const value = object(row.authorizedPin);
      if (
        Object.keys(value).sort().join(",") !== "modelDigest,repositoryVersion"
      ) refuse();
      authorized = pin(value.modelDigest, value.repositoryVersion);
    }
    if (row.runPin !== null) {
      const value = object(row.runPin);
      if (
        Object.keys(value).sort().join(",") !==
          "flowOccurrenceId,flowRootId,identity,maxSteps,profile,version" ||
        canonical(value.identity) !== canonical(snapshot.expected.identity) ||
        typeof value.flowRootId !== "string" || !value.flowRootId ||
        typeof value.flowOccurrenceId !== "string" || !value.flowOccurrenceId ||
        !Number.isSafeInteger(value.maxSteps) || Number(value.maxSteps) < 1
      ) refuse();
      const version = object(value.version);
      run = pin(version.digest, version.repositoryVersion);
    }
    if (
      !authorized && !run ||
      authorized && run && canonical(authorized) !== canonical(run)
    ) refuse();
    for (const item of [authorized, run]) {
      if (!item) continue;
      const exact = canonical(item);
      if (
        exact === candidate || !executed.has(exact) ||
        !row.retired && exact !== previous
      ) refuse();
    }
  }
}

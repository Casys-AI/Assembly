import {
  normalizeProviderCallObservation,
  type ProviderCallHostScope,
  type ProviderCallObservation,
  type ProviderCallScope,
} from "../../../application/telemetry/provider-call.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { assertPostgresSystemScope } from "./scope.ts";

export function assertProviderCallScope(scope: ProviderCallScope): void {
  assertPostgresSystemScope(scope);
  if (
    scope.executionSpaceId !== null &&
    (typeof scope.executionSpaceId !== "string" ||
      !scope.executionSpaceId.trim() ||
      scope.executionSpaceId.includes("\0"))
  ) {
    throw new Error("Invalid provider call scope");
  }
}

/** Canonicalize only the allowlisted DTO. Unknown fields never reach storage. */
export function encodeProviderCall(
  host: ProviderCallHostScope,
  input: unknown,
): string {
  assertPostgresSystemScope(host);
  const observation = normalizeProviderCallObservation(input);
  const scope = observation.correlation.executionScope;
  if (
    scope &&
    (scope.projectId !== host.projectId || scope.systemId !== host.systemId)
  ) {
    throw new Error("Provider call host mismatch");
  }
  return canonical(observation);
}

export function decodeProviderCall(
  scope: ProviderCallScope,
  observationId: string,
  payload: string,
): ProviderCallObservation {
  try {
    assertProviderCallScope(scope);
    const observation = normalizeProviderCallObservation(JSON.parse(payload));
    if (
      observation.observationId !== observationId ||
      (observation.correlation.executionScope?.executionSpaceId ?? null) !==
        scope.executionSpaceId ||
      encodeProviderCall(scope, observation) !== payload
    ) throw new Error();
    return observation;
  } catch {
    throw new Error("Invalid stored provider call observation");
  }
}

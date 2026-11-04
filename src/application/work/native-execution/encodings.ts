import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  NativeExecutionIdentity,
  NativeExecutionRequest,
} from "./contract.ts";

/** Stable persisted execution encodings; retain all enumerable runtime scope fields. */
export async function postgresExecutionThreadId(
  scope: {
    readonly projectId: string;
    readonly systemId: string;
    executionSpaceId: string;
  },
  identity: NativeExecutionIdentity,
) {
  return `execution:${await executionDigest({ ...scope, identity })}`;
}

export function immutablePin(request: NativeExecutionRequest) {
  return canonical({
    identity: request.model.identity,
    version: request.model.version,
    flowRootId: request.flow.rootNativeId,
    flowOccurrenceId: request.flow.rootOccurrenceId,
    profile: request.flow.executionProfile ?? null,
    maxSteps: request.maxSteps,
  });
}

export function modelSourceReference(request: NativeExecutionRequest) {
  return canonical({
    businessRevision: request.businessRevision,
    contribution: request.contribution,
  });
}

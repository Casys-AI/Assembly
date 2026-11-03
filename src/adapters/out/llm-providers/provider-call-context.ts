import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ProviderCallContextPort,
  type ProviderCallCorrelation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "../../../application/telemetry/provider-call.ts";

const context = new AsyncLocalStorage<ProviderCallCorrelation>();

/** Only explicit native and application identities enter this context. */
export const providerCallContext: ProviderCallContextPort = {
  async run(correlation, operation) {
    // Partial callers may explicitly supply undefined. It means unavailable in
    // this patch, not an instruction to erase an established parent identity.
    const supplied = Object.fromEntries(
      Object.entries(correlation).filter(([, value]) => value !== undefined),
    ) as Partial<ProviderCallCorrelation>;
    const parent = context.getStore();
    // A nested operator, Case, model or space cannot borrow its caller's native
    // receipt. A budget-only child in the exact same execution retains joins.
    const changed = parent && ([
      "scopeKind",
      "scopeId",
      "caseId",
      "operatorId",
      "modelDigest",
      "repositoryVersion",
      "threadId",
      "runId",
      "effectId",
      "nodeId",
    ] as const).some((key) =>
      supplied[key] !== undefined && supplied[key] !== parent[key]
    );
    const nextScope = supplied.executionScope;
    const changedSpace = parent && nextScope !== undefined &&
      (nextScope?.projectId !== parent.executionScope?.projectId ||
        nextScope?.systemId !== parent.executionScope?.systemId ||
        nextScope?.executionSpaceId !==
          parent.executionScope?.executionSpaceId);
    const captured = Object.freeze({
      ...(changed || changedSpace
        ? UNKNOWN_PROVIDER_CALL_CORRELATION
        : parent ?? UNKNOWN_PROVIDER_CALL_CORRELATION),
      ...supplied,
      ...(supplied.executionScope
        ? {
          executionScope: Object.freeze({ ...supplied.executionScope }),
        }
        : {}),
    });
    return await context.run(captured, operation);
  },
};

export function currentProviderCallCorrelation(): ProviderCallCorrelation {
  return Object.freeze({
    ...(context.getStore() ?? UNKNOWN_PROVIDER_CALL_CORRELATION),
  });
}

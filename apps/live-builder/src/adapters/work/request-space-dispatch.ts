import type { OperatorExecutionDelivery } from "../../application/work/operators/execution.ts";
import type { PostgresSystemScope } from "../out/postgres/scope.ts";
import type { ResolvedOperatorScope } from "./runtime/operator-dispatch.ts";
import type { RequestSpaceRuntime } from "./request-space-runtime.ts";
import { RequestSpaceError } from "../../domain/work/request-spaces.ts";

/** The resolved space wins before any operator lookup. A Case refusal never
 * retries through Main, even when both spaces use the same operator identity. */
export function createRequestSpaceDispatcher(
  host: PostgresSystemScope,
  runtime: Pick<RequestSpaceRuntime, "processAcceptedContribution">,
) {
  const boundHost = Object.freeze({ ...host });
  return async (
    delivery: OperatorExecutionDelivery,
    scope: ResolvedOperatorScope | undefined,
    mainDispatch: (delivery: OperatorExecutionDelivery) => Promise<void>,
  ): Promise<void> => {
    if (
      !scope ||
      (scope.projectId !== boundHost.projectId ||
        scope.systemId !== boundHost.systemId) ||
      !scope.executionSpaceId
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The resolved Request worker scope is unavailable.",
      );
    }
    if (scope.executionSpaceId === "main") {
      if (scope.caseId !== undefined) {
        throw new RequestSpaceError(
          "ADMISSION_REFUSED",
          "The resolved Request worker scope is unavailable.",
        );
      }
      await mainDispatch(delivery);
      return;
    }
    if (!scope.caseId) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The resolved Request worker scope is unavailable.",
      );
    }
    await runtime.processAcceptedContribution(delivery, scope);
  };
}

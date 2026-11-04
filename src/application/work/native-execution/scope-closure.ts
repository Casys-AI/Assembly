import type { SystemRuntimeState } from "../runtime/state.ts";
import type {
  NativeExecutionSnapshot,
  NativeScopeClosure,
} from "./contract.ts";

export function assertHistoricalScopeClosure(
  operatorId: string,
  closure: NativeScopeClosure,
  accepted: SystemRuntimeState,
) {
  const record = accepted.cases?.find((entry) => entry.id === closure.caseId);
  if (
    !record || record.owner !== operatorId ||
    record.status !== closure.status ||
    record.closedAt !== closure.closedAt ||
    !accepted.events.some((event) =>
      event.kind === "case-closed" && event.caseId === closure.caseId
    )
  ) {
    throw new Error(
      "Canonical business history does not attest this Request closure",
    );
  }
}

export function assertCurrentScopeClosure(
  snapshot: NativeExecutionSnapshot,
  closure: NativeScopeClosure,
  current: SystemRuntimeState,
) {
  const currentCase = current.cases?.find((entry) =>
    entry.id === closure.caseId
  );
  if (
    currentCase?.status !== closure.status ||
    currentCase.closedAt !== closure.closedAt
  ) throw new Error("Canonical Request closure changed");
  if (
    Object.values(current.pendingContributions ?? {}).some((receipt) =>
      receipt.status === "pending" &&
      receipt.invocationKey === snapshot.identity.invocationKey &&
      (!snapshot.identity.subjectId ||
        receipt.inputMessageId === snapshot.identity.subjectId)
    )
  ) {
    throw new Error(
      "A correlated contribution still blocks native scope closure",
    );
  }
}

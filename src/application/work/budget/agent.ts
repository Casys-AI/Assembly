import { WorkBudgetError } from "../../../domain/work/policies/budget.ts";
import type { WorkBudgetView } from "../../../domain/work/policies/budget.ts";
import type { WorkBudgetReserveInput } from "./commands/inputs.ts";
import type { WorkBudgetPort } from "./ports.ts";
import type { ProviderCallContextPort } from "../../telemetry/provider-call.ts";

/** A budget boundary failure suspends work without invalidating its candidate. */
export class AgentBudgetWait extends Error {
  constructor(
    readonly budget: WorkBudgetView | undefined,
    readonly reason: "exhausted" | "unavailable" = "exhausted",
    message =
      "Le budget cumulatif d’appels d’agent est épuisé ; contrôle local attendu.",
    readonly attemptId?: string,
    readonly dispatchStarted = false,
  ) {
    super(message);
    this.name = "AgentBudgetWait";
  }
}

function unavailable(
  error: unknown,
  attemptId: string,
  dispatchStarted = false,
): AgentBudgetWait {
  return new AgentBudgetWait(
    undefined,
    "unavailable",
    error instanceof Error ? error.message : "Registre de budget indisponible",
    attemptId,
    dispatchStarted,
  );
}

/** Arguments and authority checks must be prepared before entering this boundary.
 * Best-effort refresh failures never log here; the edge reports them through
 * `onRefreshError` when it wants them observed. */
export async function budgetedAgentCall<T>(
  port: WorkBudgetPort | undefined,
  input: WorkBudgetReserveInput,
  dispatch: () => Promise<T>,
  observed: (view: WorkBudgetView | undefined) => Promise<void>,
  onRefreshError?: (error: unknown) => void,
  providerCallContext?: ProviderCallContextPort,
): Promise<T> {
  const dispatchObserved = (attemptId: string | null) =>
    providerCallContext
      ? providerCallContext.run({
        budgetAttemptId: attemptId,
        budgetOperation: input.operation,
      }, dispatch)
      : dispatch();
  if (!port) {
    if (input.policy) {
      throw new AgentBudgetWait(
        undefined,
        "unavailable",
        "Le budget natif exige son registre durable.",
        input.attemptId,
      );
    }
    return await dispatchObserved(null);
  }
  // Even an absent policy goes through the ledger: removing the source binding
  // must never silently restore unlimited dispatch.
  let reservation: Awaited<ReturnType<WorkBudgetPort["reserve"]>>;
  try {
    reservation = await port.reserve(input);
  } catch (error) {
    if (error instanceof WorkBudgetError && error.code === "exhausted") {
      try {
        const view = await port.snapshot(
          input.scopeId,
          input.ownerId,
          input.policy,
        );
        if (!view) throw error;
        await observed(view);
        throw new AgentBudgetWait(
          view,
          "exhausted",
          undefined,
          input.attemptId,
        );
      } catch (snapshotError) {
        if (snapshotError instanceof AgentBudgetWait) throw snapshotError;
        throw unavailable(snapshotError, input.attemptId);
      }
    }
    throw unavailable(error, input.attemptId);
  }
  try {
    await observed(reservation);
  } catch (error) {
    throw unavailable(error, input.attemptId);
  }
  async function settle(outcome: "returned" | "failed") {
    if (!reservation || !port) return;
    // Settlement stays fail-closed: its failure fails the call.
    try {
      await port.settle({
        scopeId: input.scopeId,
        ownerId: input.ownerId,
        attemptId: input.attemptId,
        outcome,
      });
    } catch (error) {
      throw unavailable(error, input.attemptId, true);
    }
    // Snapshot and view refresh are best-effort: their failure is reported
    // to the edge hook and never discards the already-paid call response.
    try {
      await observed(
        await port.snapshot(input.scopeId, input.ownerId, input.policy),
      );
    } catch (error) {
      try {
        onRefreshError?.(error);
      } catch { /* The edge hook must never fail the paid call. */ }
    }
  }
  let result: T;
  try {
    result = await dispatchObserved(reservation ? input.attemptId : null);
  } catch (error) {
    await settle("failed");
    throw error;
  }
  await settle("returned");
  return result;
}

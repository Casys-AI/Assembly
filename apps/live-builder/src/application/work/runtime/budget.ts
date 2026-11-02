import {
  caseBudgetPolicy,
  caseExecutionContext,
  currentCase,
  delegatedCaseContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  WorkBudgetOperation,
  WorkBudgetPolicy,
  WorkBudgetView,
} from "../../../domain/work/policies/budget.ts";
import { AgentBudgetWait, budgetedAgentCall } from "../budget/agent.ts";
import { errorText, makeEvent } from "./values.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import type { ProviderCallContextPort } from "../../telemetry/provider-call.ts";

export interface RuntimeBudgetHost {
  readonly state: Pick<
    SystemRuntimeState,
    | "id"
    | "workBudgetBinding"
    | "budgetSuspension"
    | "budgetCeilingTransition"
    | "workBudget"
    | "cases"
    | "caseInvocation"
    | "executionModel"
    | "caseBudgetPending"
    | "designer"
  >;
  readonly ports: {
    workBudget?: WorkBudgetPort;
    providerCallContext?: ProviderCallContextPort;
  };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  budgetView(model: ExecutableModel): Promise<WorkBudgetView | undefined>;
}

function budgetScope(
  state: RuntimeBudgetHost["state"],
  model: ExecutableModel,
): { scopeId: string; ownerId: string; policy: WorkBudgetPolicy | undefined } {
  const delegated = delegatedCaseContext(state);
  const designer = designerExecutionContext(state);
  if (designer) {
    return { ...structuredClone(designer), policy: designer.policy };
  }
  if (delegated) {
    return {
      scopeId: delegated.budget?.scopeId ?? delegated.caseId,
      ownerId: delegated.budget?.ownerId ?? model.identity.builderId,
      policy: delegated.budget?.policy,
    };
  }
  const caseRecord = currentCase(state);
  const scopeId = caseRecord?.budget?.scopeId ?? caseRecord?.id;
  if (!scopeId) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "Une invocation exige une portée explicite de concepteur ou de Case.",
      { conversationId: state.id },
      "Reload the original dossier through initialize() or open a new Case before invoking an agent.",
    );
  }
  return {
    scopeId,
    ownerId: model.identity.builderId,
    policy: caseBudgetPolicy(
      model,
      caseRecord?.caseTypeId,
      caseRecord?.scheduling?.maxInvocations,
    ),
  };
}

export async function budgetView(
  this: RuntimeBudgetHost,
  model: ExecutableModel,
) {
  const delegated = delegatedCaseContext(this.state) ||
    (this.state.caseInvocation?.kind === "delegated-designer"
      ? this.state.caseInvocation.work.designerContext
      : undefined);
  const { scopeId, ownerId, policy } = budgetScope(this.state, model);
  if (
    !delegated && policy &&
    (!this.state.workBudgetBinding ||
      this.state.workBudgetBinding.budgetId !== policy.id ||
      this.state.workBudgetBinding.scopeId !== scopeId)
  ) {
    throw new AgentBudgetWait(
      undefined,
      "unavailable",
      "La liaison durable du budget admis est absente ou incohérente.",
    );
  }
  if (policy && !this.ports.workBudget) {
    throw new AgentBudgetWait(
      undefined,
      "unavailable",
      "Le budget natif exige son registre durable.",
    );
  }
  try {
    const view = this.state.caseBudgetPending && !delegated
      ? await this.ports.workBudget?.adopt({
        scopeId,
        ownerId,
        policy,
        previousPolicy: undefined,
        modelVersion: model.version,
      })
      : await this.ports.workBudget?.snapshot(scopeId, ownerId, policy);
    if (this.state.caseBudgetPending && view && !delegated) {
      await this.update((s) => {
        delete s.caseBudgetPending;
        s.workBudget = view;
      });
    }
    if (
      (delegated || this.state.workBudgetBinding) && policy && !view
    ) {
      throw new Error("Registre de budget attendu mais absent.");
    }
    return view;
  } catch (error) {
    throw new AgentBudgetWait(undefined, "unavailable", errorText(error));
  }
}
export async function agentCall<T>(
  this: RuntimeBudgetHost,
  model: ExecutableModel,
  operation: WorkBudgetOperation,
  dispatch: () => Promise<T>,
  onRefreshError?: (error: unknown) => void,
): Promise<T> {
  const pending = this.state.budgetSuspension;
  if (pending?.dispatchStarted) {
    throw new AgentBudgetWait(
      this.state.workBudget,
      "unavailable",
      pending.diagnostic,
      pending.attemptId,
      true,
    );
  }
  await this.budgetView(model);
  const scope = budgetScope(this.state, model);
  const call = () =>
    budgetedAgentCall(
      this.ports.workBudget,
      {
        ...scope,
        operation,
        attemptId:
          pending?.reason === "exhausted" && !pending.dispatchStarted &&
            pending.operation === operation &&
            this.state.budgetCeilingTransition?.resume &&
            this.state.budgetCeilingTransition.manifest.budget
                .refusedAttemptId === pending.attemptId
            ? pending.attemptId
            : crypto.randomUUID(),
        ...(pending?.reason === "exhausted" && !pending.dispatchStarted &&
            pending.operation === operation &&
            this.state.budgetCeilingTransition?.resume &&
            this.state.budgetCeilingTransition.manifest.budget
                .refusedAttemptId === pending.attemptId
          ? {
            ceilingTransition: {
              id: this.state.budgetCeilingTransition.manifest.id,
              manifestDigest: this.state.budgetCeilingTransition.manifestDigest,
              originRevision: this.state.budgetCeilingTransition.manifest.budget
                .originRevision,
              refusedAttemptId: pending.attemptId,
            },
          }
          : {}),
        modelVersion: model.version,
      },
      dispatch,
      async (view) => {
        if (view) {
          await this.update((s) => {
            s.workBudget = view;
          });
        }
      },
      onRefreshError,
      this.ports.providerCallContext,
    );
  const request = caseExecutionContext(this.state);
  const designer = designerExecutionContext(this.state);
  return await (this.ports.providerCallContext
    ? this.ports.providerCallContext.run({
      scopeKind: request ? "request" : designer ? "designer" : null,
      scopeId: request?.caseId ?? designer?.scopeId ?? null,
      caseId: request?.caseId ?? null,
      operatorId: model.identity.builderId,
      modelDigest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion ?? null,
    }, call)
    : call());
}
export async function suspendBudget(
  this: RuntimeBudgetHost,
  error: AgentBudgetWait,
  node: CompiledFlowNode,
  operation: WorkBudgetOperation,
  candidateId?: string,
): Promise<void> {
  await this.update((s) => {
    if (error.budget) s.workBudget = error.budget;
    if (candidateId) s.budgetPromotionCandidateId = candidateId;
    s.budgetSuspension = {
      nodeId: node.id,
      operation,
      candidateId,
      recipient: "local-control",
      reason: error.reason,
      diagnostic: error.message,
      attemptId: error.attemptId,
      dispatchStarted: error.dispatchStarted,
    };
    s.phase = "Budget : contrôle local attendu";
    delete s.error;
    s.events.push(
      makeEvent(
        "work-budget-wait",
        error.message,
        candidateId
          ? s.candidates.find((c) => c.id === candidateId)
          : undefined,
      ),
    );
  });
}

import { nativePromotionDependencies } from "./model-advance.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { adoptBudgetCeiling } from "./budget-transition.ts";
import type { NativeExecutionPort } from "./execution.ts";
import {
  caseBudgetPolicy,
  currentCase,
  delegatedCaseContext,
  designerExecutionContext,
  localRequestCase,
} from "../cases/runtime.ts";
import type { ConversationsSnapshot } from "../../../domain/work/records/conversations.ts";
import {
  effectiveModelUpdate,
  type EffectiveModelUpdateOrigin,
} from "../../../domain/work/records/effective-model-update.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  type ModelDiagnosticAddress,
  requireExistingDiagnosticAddresses,
} from "../../../domain/model/value-objects/diagnostic-address.ts";
import type {
  Event,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type {
  SystemConfiguration,
} from "../../../domain/governance/records/system-configuration.ts";
import type { ModelDiagnosticsPort, ModelPort } from "./ports.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import { makeEvent } from "./values.ts";
import {
  materializeScheduledCases,
  missingScheduledTypes,
} from "../cases/scheduling.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import type { ClockPort } from "./ports.ts";
import {
  exerciseOwnerAuthority,
  ownerAuthorityFor,
} from "../../../domain/governance/authority.ts";

/** The admitted pin and the serialized mutation boundary remain runtime-owned. */
export interface ModelAdoptionHost {
  readonly state: SystemRuntimeState;
  readonly operatorRegistry?: { readonly snapshot: ConversationsSnapshot };
  readonly ports: {
    clock: ClockPort;
    execution?: NativeExecutionPort;
    caseNumbers: CaseNumberPort;
    model: Pick<ModelPort, "readExecutableModel">;
    modelDiagnostics?: ModelDiagnosticsPort;
    workBudget?: WorkBudgetPort;
  };
  control(action: () => Promise<void>): Promise<void>;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  inspectModelVersion(): Promise<ExecutableModel>;
  /** Runtime-injected durable pin gate; checked inside serialized owner control. */
  assertPinAdmission?(): Promise<void>;
  assertBudgetCeilingAdmission?(): Promise<void>;
  reloadBudgetCeilingState?(): Promise<void>;
  retireNativeAwaits?(model: ExecutableModel): Promise<void>;
  isPrimaryOperator(model: ExecutableModel): boolean;
  adopt(
    native: ExecutableModel,
    changes?: SystemConfiguration["changes"],
    event?: Event,
    onAdopt?: (state: SystemRuntimeState) => void,
    origin?: EffectiveModelUpdateOrigin,
  ): Promise<void>;
}

export function isPrimaryOperator(
  this: ModelAdoptionHost,
  model: ExecutableModel,
): boolean {
  const admitted = this.state.executionModel;
  if (
    !admitted || model.identity.builderId !== admitted.identity.builderId ||
    model.version.digest !== admitted.version.digest
  ) return false;
  // Without a registry, the admitted endpoint decides; no endpoint keeps the historical primary fallback.
  if (!this.operatorRegistry) return admitted.operator?.primary ?? true;
  try {
    const primaries = this.operatorRegistry.snapshot.conversations.filter(
      (entry) => entry.runtimeOwned === true && entry.primary === true,
    );
    const primary = primaries.length === 1 ? primaries[0] : undefined;
    // Source-only publications may advance HEAD without adopting a contract.
    // The role belongs to the admitted pin, not the current source revision.
    return primary?.agentId === admitted.identity.builderId &&
      primary.nativeId === admitted.identity.builderId &&
      primary.modelDigest === admitted.version.digest &&
      primary.repositoryVersion === admitted.version.repositoryVersion;
  } catch {
    // A missing or unreadable role must never grant designer privileges.
    return false;
  }
}

export async function adoptModelVersion(this: ModelAdoptionHost, input: {
  expectedDigest: string;
  expectedVersion?: string;
  recoveryReason?: string;
}): Promise<void> {
  await this.control(async () => {
    if (
      this.state.budgetSuspension?.reason === "exhausted" ||
      this.state.budgetCeilingTransition &&
        this.state.budgetCeilingTransition.phase !== "complete"
    ) {
      const target = await this.ports.model.readExecutableModel(
        this.state.model!,
      );
      if (
        target.version.digest !== input.expectedDigest ||
        input.expectedVersion !== undefined &&
          target.version.repositoryVersion !== input.expectedVersion
      ) {
        throw new Error(
          "La version du modèle a changé ; recharge sa proposition.",
        );
      }
      try {
        await adoptBudgetCeiling(this, target, input.recoveryReason);
      } catch (error) {
        await this.reloadBudgetCeilingState?.();
        if (
          this.state.budgetCeilingTransition &&
          this.state.budgetCeilingTransition.phase !== "complete"
        ) {
          await this.update((state) => {
            state.budgetCeilingTransition!.blockedReason =
              error instanceof Error ? error.message : String(error);
          });
        }
        throw error;
      }
      return;
    }
    await this.assertPinAdmission?.();
    if (input.recoveryReason !== undefined && !input.recoveryReason.trim()) {
      throw new Error("La reprise hors mandat exige une justification.");
    }
    // Capture before reading/adopting the replacement: new grants cannot admit
    // themselves. Recovery remains an explicit, durable local control.
    const authorityExercise = exerciseOwnerAuthority(
      this.state.executionModel!,
      "model-adoption",
      input.recoveryReason === undefined
        ? {}
        : { outOfMandate: true, reason: input.recoveryReason.trim() },
    );
    const native = await this.ports.model.readExecutableModel(
      this.state.model!,
    );
    if (
      native.version.digest !== input.expectedDigest ||
      input.expectedVersion !== undefined &&
        native.version.repositoryVersion !== input.expectedVersion
    ) {
      throw new Error(
        "La version du modèle a changé ; recharge sa proposition.",
      );
    }
    await this.update((s) =>
      s.events.push({
        ...makeEvent(
          "model-version-admission-authorized",
          `Décision locale d’adoption : ${native.version.digest}`,
        ),
        authorityExercise,
        modelAdoptionAuthorization: {
          target: {
            identity: structuredClone(native.identity),
            version: structuredClone(native.version),
          },
        },
      })
    );
    // This owner control is invoked from Model, without a proved conversation
    // origin. A retained selected invocation cannot attribute this activation.
    await this.assertPinAdmission?.();
    await this.retireNativeAwaits?.(native);
    await this.adopt(native, undefined, undefined, undefined, {});
    await this.update((s) => {
      s.events.push(
        {
          ...makeEvent(
            "model-version-admitted",
            authorityExercise.outOfMandate
              ? "Reprise locale hors mandat : version du modèle admise"
              : "Version du modèle admise explicitement",
          ),
          authorityExercise,
        },
      );
    });
  });
}

export async function adopt(
  this: ModelAdoptionHost,
  native: ExecutableModel,
  changes = this.state.configuration?.changes ?? [],
  event?: Event,
  onAdopt?: (state: SystemRuntimeState) => void,
  origin?: EffectiveModelUpdateOrigin,
): Promise<void> {
  const admittedDigest = this.state.executionModel?.version.digest;
  const executions = await this.ports.execution?.inspect(
    this.state.executionModel?.identity.builderId ??
      native.identity.builderId,
  ) ?? [];
  const pendingPromotions = nativePromotionDependencies(this.state, executions);
  const changesPin = this.state.executionModel &&
    canonical({
        identity: this.state.executionModel.identity,
        version: this.state.executionModel.version,
      }) !==
      canonical({ identity: native.identity, version: native.version });
  if (
    changesPin && !this.ports.execution &&
    this.state.candidates.some((candidate) => candidate.promotionExecution)
  ) {
    throw new Error(
      "Native promotion inspection is unavailable before model adoption",
    );
  }
  if (changesPin && pendingPromotions.length) {
    throw new Error(
      "A native promotion checkpoint still depends on its previous admitted source pin",
    );
  }
  if (
    pendingPromotions.length &&
    JSON.stringify(this.state.executionModel?.flows.promotion) !==
      JSON.stringify(native.flows.promotion)
  ) {
    throw new Error(
      "A native promotion checkpoint still depends on its previous admitted flow",
    );
  }
  const scheduledNumbers: number[] = [];
  for (const _type of missingScheduledTypes(this.state, native)) {
    scheduledNumbers.push(await this.ports.caseNumbers.allocate());
  }
  if (
    this.state.candidates.some((candidate) => candidate.promotionCursor) &&
    JSON.stringify(this.state.executionModel?.flows.promotion) !==
      JSON.stringify(native.flows.promotion)
  ) {
    throw new Error(
      "Une promotion suspendue dépend du flux natif précédent ; sa nouvelle version ne peut pas encore être admise.",
    );
  }
  if (
    this.state.candidates.some((candidate) =>
      candidate.promotionCursor &&
      candidate.promotionModelDigest !== admittedDigest
    )
  ) {
    throw new Error(
      "Une continuation de promotion ne correspond plus au modèle précédemment admis.",
    );
  }
  const caseRecord = localRequestCase(this.state) ?? currentCase(this.state);
  const designer = this.state.caseInvocation?.kind === "designer" &&
    designerExecutionContext(this.state);
  const policy = designer
    ? native.workBudgetPolicy
    : caseBudgetPolicy(native, caseRecord?.caseTypeId);
  const previousPolicy = this.state.executionModel &&
    (designer
      ? this.state.executionModel.workBudgetPolicy
      : caseBudgetPolicy(this.state.executionModel, caseRecord?.caseTypeId));
  if (policy && !this.ports.workBudget) {
    throw new Error("Le budget natif exige son registre durable.");
  }
  // Closed Cases retain their ledger; the next Case adopts its own reservation.
  const betweenCases = !caseRecord && !designer;
  const budget = betweenCases ? undefined : await this.ports.workBudget?.adopt({
    // Only initial/legacy bootstrap may still use the conversation scope.
    scopeId: designer
      ? designer.scopeId
      : caseRecord!.budget?.scopeId ?? caseRecord!.id,
    ownerId: native.identity.builderId,
    // A pending local scope has not adopted its initial ledger yet, just as
    // in budgetView; every started scope must still prove its previous policy.
    previousPolicy: this.state.caseBudgetPending ? undefined : previousPolicy,
    policy,
    modelVersion: native.version,
  });
  await this.update((s) => {
    if (
      betweenCases && !delegatedCaseContext(s) &&
      s.caseInvocation?.kind !== "delegated-designer"
    ) {
      delete s.workBudgetBinding;
      delete s.workBudget;
      delete s.caseBudgetPending;
    }
    if (budget) {
      const binding = {
        budgetId: budget.budgetId,
        scopeId: budget.scopeId,
      };
      const caseRecord = localRequestCase(s) ?? currentCase(s);
      if (caseRecord) caseRecord.budget = structuredClone(binding);
      if (designer) s.designer!.budget = structuredClone(binding);
      if (
        !delegatedCaseContext(s) &&
        s.caseInvocation?.kind !== "delegated-designer"
      ) {
        s.workBudget = budget;
        s.workBudgetBinding = binding;
        delete s.caseBudgetPending;
      }
    }
    if (
      s.conversationFlow &&
      JSON.stringify(s.conversationFlow) !==
        JSON.stringify(native.flows.conversation)
    ) {
      delete s.conversationCursor;
      delete s.conversationContext;
      delete s.conversationFlow;
    }
    const delegated = delegatedCaseContext(s);
    const local = currentCase(s);
    const designerOrigin = designerExecutionContext(s);
    const update = effectiveModelUpdate(s.executionModel, native, {
      journalId: s.id,
      journalPosition: s.events.length,
      activatedAt: this.ports.clock.now(),
      origin: origin ??
        (delegated
          ? { caseId: delegated.caseId }
          : local
          ? { caseId: local.id }
          : designerOrigin
          ? { designerScopeId: designerOrigin.scopeId }
          : undefined),
    });
    s.executionModel = structuredClone(native);
    if (update) {
      s.events.push({
        id: update.id,
        at: update.activatedAt,
        kind: "effective-model-updated",
        label: update.kind === "action-flow"
          ? "Action flow updated"
          : "Model updated",
        effectiveModelUpdate: update,
        ...(update.caseId ? { caseId: update.caseId } : {}),
      });
    }
    materializeScheduledCases(s, native, scheduledNumbers, this.ports.clock);
    s.ownerAuthority = structuredClone(ownerAuthorityFor(native));
    s.model = structuredClone(native.identity);
    // A pending proposal overtaken by this adoption is terminally superseded,
    // with one receipt event each; its decision continuations are retired so
    // no stale rows linger and a fresh proposal can be filed at the new pin.
    const settled = structuredClone(changes);
    for (const change of settled) {
      // A published change is decided and merely completing its own receipt
      // (possibly through this very adoption); superseding it would orphan a
      // real publication. Only undecided proposals with an overtaken base go.
      if (
        change.status !== "pending" || change.publishedCommit ||
        change.baseRevision === native.configuration.revision &&
          (change.baseModelDigest === undefined ||
            change.baseModelDigest === native.version.digest)
      ) continue;
      change.status = "superseded";
      s.events.push({
        ...makeEvent(
          "configuration-change-superseded",
          `Proposition supplantée : ${change.id}`,
        ),
        changeId: change.id,
        changeSuperseded: {
          oldPin: {
            ...(change.baseModelDigest !== undefined
              ? { digest: change.baseModelDigest }
              : {}),
            ...(change.diff?.base.repositoryVersion !== undefined
              ? { repositoryVersion: change.diff.base.repositoryVersion }
              : {}),
            revision: change.baseRevision,
          },
          newPin: {
            digest: native.version.digest,
            ...(native.version.repositoryVersion !== undefined
              ? { repositoryVersion: native.version.repositoryVersion }
              : {}),
          },
        },
      });
      delete s.changeDecisionContinuations?.[change.id];
      delete s.changeWorkContinuations?.[change.id];
    }
    s.configuration = {
      ...structuredClone(native.configuration),
      changes: settled,
    };
    delete s.availableExecutionModel;
    if (event) s.events.push(event);
    onAdopt?.(s);
  });
}

export async function currentModel(
  this: ModelAdoptionHost,
): Promise<ExecutableModel> {
  const native = await this.inspectModelVersion();
  if (
    !this.state.executionModel ||
    native.version.digest !== this.state.executionModel.version.digest
  ) {
    throw new Error(
      "Le modèle natif a changé ; une admission explicite de sa version est requise avant toute décision ou effet.",
    );
  }
  const admitted = this.state.executionModel;
  if (
    admitted.version.repositoryVersion &&
    native.version.repositoryVersion !== admitted.version.repositoryVersion
  ) {
    const pinned = await this.ports.model.readExecutableModel(
      admitted.identity,
      admitted.version.repositoryVersion,
    );
    if (
      pinned.version.digest !== admitted.version.digest ||
      pinned.version.repositoryVersion !== admitted.version.repositoryVersion
    ) {
      throw new Error("The exact admitted native source is unavailable");
    }
    return pinned;
  }
  return native;
}

export async function diagnosticAddresses(
  this: ModelAdoptionHost,
  model: ExecutableModel,
  baseVersion: string,
  addresses: ModelDiagnosticAddress[] | undefined,
): Promise<{ addresses?: ModelDiagnosticAddress[] }> {
  if (addresses === undefined || addresses.length === 0) return {};
  if (!this.isPrimaryOperator(model)) {
    throw new Error(
      "Only the primary operator may address model diagnostics",
    );
  }
  if (!this.ports.modelDiagnostics) {
    throw new Error("Diagnostic validation is unavailable for this proposal");
  }
  // Use the complete base-version findings, regardless of masking, severity,
  // the prompt's 20-item limit, or context-budget truncation.
  const diagnostics = await this.ports.modelDiagnostics.read(
    model,
    baseVersion,
  );
  return {
    addresses: requireExistingDiagnosticAddresses(addresses, diagnostics),
  };
}

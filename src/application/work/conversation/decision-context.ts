import { mayConsultModel } from "../../../domain/model/consultation/model-read-policy.ts";
import { activeTools } from "../tools/active-tools.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  memoryGuidance,
  memoryView,
} from "../../../domain/memory/governed-memory-promotion.ts";
import { matchesNativeInputSchema } from "../behaviors/invocation.ts";
import { caseBudgetPolicy } from "../cases/runtime.ts";
import {
  caseExecutionContext,
  caseMessages,
  designerExecutionContext,
} from "../cases/runtime.ts";
import type { DecisionContextPolicy } from "../../../domain/work/policies/context-separation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { availableBehaviors } from "../../governance/behavior-call-admission.ts";
import {
  ContextRepresentationLimitError,
  projectDecisionContext,
} from "../context/separation.ts";
import type {
  ConversationDecisionHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { changeDecisionMetadata } from "../../../domain/governance/operator-authority.ts";
import { batchHistory } from "./batches.ts";
import { creationScopeOf } from "../runtime/ports.ts";
import {
  canRequestOperatorCreationPolicy,
  type CreationScope,
} from "../../../domain/governance/policies/operator-creation-policy.ts";
import { MAIN_EXECUTION_SPACE_ID } from "../../../domain/governance/operator-authority.ts";
import { MAX_BRANCH_TEAM } from "../../../domain/work/records/conversations.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { modelDiagnosticsView as diagnosticsView } from "./model-diagnostics-link.ts";

/** Only current native grants in an active Request can expose team creation. */
export function operatorCreationContext(
  current: ExecutableModel,
  record: SystemRuntimeState,
  scope: CreationScope,
): ChatContext["operatorCreation"] {
  const request = caseExecutionContext(record)?.record;
  if (request?.type !== "request" || !isOpenCase(request)) return undefined;
  if (
    !scope?.space || scope.space.systemId !== current.identity.systemId ||
    current.identity.projectId !== undefined &&
      scope.space.projectId !== current.identity.projectId
  ) return undefined;
  const branch = scope.space.executionSpaceId !== MAIN_EXECUTION_SPACE_ID;
  if (
    branch &&
    (!Number.isSafeInteger(scope.branchTeamSize) || scope.branchTeamSize! < 0)
  ) return undefined;
  const policies = current.operatorCreationPolicies?.filter((policy) =>
    policy.enabled && policy.holderNativeId === current.identity.builderId &&
    policy.systemId === current.identity.systemId &&
    policy.rootAuthority?.ownerSource === "modeled" &&
    (branch
      // Inherited native children are inert in a branch: the whole current
      // branch team counts against the tighter of grant and team bound.
      ? scope.branchTeamSize! <
        Math.min(policy.maxChildren, MAX_BRANCH_TEAM)
      : policy.children.length < policy.maxChildren)
  );
  return policies?.length
    ? {
      policies: structuredClone(policies),
      provisionBounds: {
        budget: {
          maxAgentDecisions: current.policy.maxAgentDecisions,
          maxToolProposals: current.policy.maxToolProposals,
          maxFlowSteps: current.policy.maxFlowSteps,
        },
        networkHosts: [...(current.configuration.network?.allowedHosts ?? [])],
        mayPropose: [...current.mandate.mayPropose],
        mayInvokeActiveCatalog:
          current.mandate.mayInvoke === "active-catalog-only",
        mayConsultModel: mayConsultModel(current.policy),
        mayProposeSysmlRevision:
          current.policy.mayProposeSysmlRevision === true,
        mayAddNetworkHosts: current.policy.mayAddNetworkHosts,
      },
    }
    : undefined;
}

/** Request discovery is descriptive; the domain checks the same bounds on submission. */
function decisionMandate(
  current: ExecutableModel,
  record: SystemRuntimeState,
  scope: CreationScope,
): ExecutableModel["mandate"] {
  const mandate = structuredClone(current.mandate);
  mandate.supportedChanges = mandate.supportedChanges.filter((change) =>
    change.requestedRights !== "operatorCreation"
  );
  const request = caseExecutionContext(record)?.record;
  if (
    request?.type === "request" && isOpenCase(request) &&
    request.owner === current.identity.builderId &&
    canRequestOperatorCreationPolicy(current, scope)
  ) {
    mandate.supportedChanges = [...mandate.supportedChanges, {
      kind: "propose_mandate_change",
      requestedRights: "operatorCreation",
      description:
        "Request your own branch creation grant: networkHosts within your own, maxChildren 1–3 across the whole team, and mode autonomous or per-creation. The person decides; no redelegation. Publication and adoption precede creation.",
    }];
  }
  return mandate;
}

async function projectRuntimeDecisionContext(
  context: ChatContext,
  policy?: DecisionContextPolicy,
): Promise<ChatContext> {
  try {
    return await projectDecisionContext(context, policy);
  } catch (error) {
    if (
      !(error instanceof ContextRepresentationLimitError) ||
      context.modelDiagnostics === undefined
    ) throw error;
    // Advisory lint may be omitted; required authority and evidence cannot be.
    const {
      modelDiagnostics: _diagnostics,
      modelDiagnosticsView: _diagnosticsView,
      ...required
    } = context;
    return await projectDecisionContext(required, policy);
  }
}

async function gatherDecisionContext(
  this: ConversationDecisionHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  record: SystemRuntimeState,
) {
  const callableTools = [];
  for (
    const selected of await activeTools(
      this.state,
      current,
      this.ports.retainedTools,
    )
  ) {
    if (
      selected.kind === "local-candidate" &&
      !this.nativeCandidate(current, selected.tool, "active")
    ) continue;
    const { id, name, description, digest, kind } = selected.tool;
    callableTools.push({ id, name, description, digest, kind });
  }
  const mayRevise = current.policy.mayProposeSysmlRevision === true;
  const selectiveModel = mayConsultModel(current.policy) &&
    !!this.ports.information?.consultModel;
  const sourceProposals = this.ports.model.readSourceProposals
    ? await this.ports.model.readSourceProposals(
      this.state.model!,
    )
    : undefined;
  const artifacts = await Promise.all(
    this.state.candidates.map((candidate) =>
      this.artifactEvidence(candidate, current)
    ),
  );
  const messages = structuredClone(caseMessages(record));
  if (!current.contextPolicy) {
    for (const message of messages) {
      if (message.execution) delete message.execution.sourceIds;
    }
  }
  const information = current.memoryPolicy || current.skillPolicy ||
      selectiveModel
    ? await this.ports.information?.read(current, messages)
    : undefined;
  if (
    (current.memoryPolicy || current.skillPolicy ||
      selectiveModel) &&
    !information
  ) {
    throw new Error(
      "Le modèle d’information admis exige son lecteur local.",
    );
  }
  if (current.skillPolicy && !information?.skills) {
    throw new Error(
      "Le modèle de skills admis exige son contexte local courant.",
    );
  }
  if (
    selectiveModel &&
    (!information?.modelContext || !information.modelSources ||
      information.modelContext.version !==
        information.modelSources.version)
  ) {
    throw new Error(
      "La consultation du modèle admise exige une base source exacte et son lecteur local.",
    );
  }
  const modelSources = selectiveModel
    ? information!.modelSources
    : mayRevise && mayConsultModel(current.policy) &&
        this.ports.model.readSourceRevision
    ? await this.ports.model.readSourceRevision(
      this.state.model!,
    )
    : undefined;
  turn.sourceDecision = structuredClone({
    modelSources,
    ...(selectiveModel ? { modelContext: information!.modelContext } : {}),
  });
  const policy = current.contextPolicy;
  await this.currentModel();
  const workBudget = await this.budgetView(current);
  // Designer diagnostics follow the current admitted registry. They belong to
  // the designer, never to a Case (Request, Job or Watch) conversation.
  let modelDiagnostics: ChatContext["modelDiagnostics"];
  let modelDiagnosticsView: ChatContext["modelDiagnosticsView"];
  if (
    this.ports.modelDiagnostics &&
    this.isPrimaryOperator(current) &&
    this.state.caseInvocation?.kind === "designer" &&
    designerExecutionContext(this.state)
  ) {
    try {
      modelDiagnostics = (await this.ports.modelDiagnostics.read(
        current,
      ))
        .filter((diagnostic) =>
          !diagnostic.masked &&
          (diagnostic.severity === "error" ||
            diagnostic.severity === "warning")
        )
        .slice(0, 20)
        .map(({ masked: _masked, ...diagnostic }) => diagnostic);
      modelDiagnosticsView = diagnosticsView(current.version.repositoryVersion);
    } catch {
      // Lint and instance preferences cannot block execution.
      // Omit unknown observations instead of claiming none exist.
    }
  }
  return {
    activeTools: callableTools,
    selectiveModel,
    mayRevise,
    sourceProposals,
    artifacts,
    messages,
    information,
    modelSources,
    policy,
    workBudget,
    modelDiagnostics,
    modelDiagnosticsView,
  };
}

export async function buildUnprojectedDecisionContext(
  this: ConversationDecisionHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  record: SystemRuntimeState,
): Promise<
  { decisionContext: ChatContext; selectiveModel: boolean | undefined }
> {
  const {
    activeTools: callableTools,
    selectiveModel,
    mayRevise,
    sourceProposals,
    artifacts,
    messages,
    information,
    modelSources,
    workBudget,
    modelDiagnostics,
    modelDiagnosticsView,
  } = await gatherDecisionContext.call(this, turn, current, record);
  // Bound for the registered designer's runtime only.
  const requestOpening = await this.requestOpeningContext?.();
  const operatorAuthority = await this.operatorAuthorityContext();
  const operatorToolAdmission = this.operatorToolAdmissionContext();
  const operatorCreation = operatorCreationContext(
    current,
    record,
    creationScopeOf(this.ports.model, current.identity),
  );
  const operatorEvolution = await this.operatorEvolutionContext?.(current);
  const taskSourceInputs = caseExecutionContext(this.state)?.record
    ?.taskSourceInputs;
  const invocationCaseId = record.caseInvocation?.kind === "local"
    ? record.caseInvocation.caseId
    : undefined;
  const invocationCase = caseExecutionContext(record)?.record ??
    record.cases?.find((entry) => entry.id === invocationCaseId);
  const decisionContext: ChatContext = {
    pinPolicies: {
      creation: structuredClone(current.operatorCreationPolicies ?? []),
      authority: structuredClone(current.operatorAuthorityPolicies ?? []),
      toolAdmission: structuredClone(current.toolAdmissionPolicies ?? []),
    },
    pinCapabilities: {
      teamCreation: invocationCase?.type === "request" &&
        (current.operatorCreationPolicies ?? []).some((policy) =>
          policy.enabled &&
          policy.holderNativeId === current.identity.builderId &&
          policy.systemId === current.identity.systemId &&
          policy.rootAuthority?.ownerSource === "modeled"
        ),
      operatorDecisions: (current.operatorAuthorityPolicies ?? []).some((
        policy,
      ) =>
        policy.enabled && policy.holderNativeId === current.identity.builderId
      ),
      candidateDecisions: (current.toolAdmissionPolicies ?? []).some((policy) =>
        policy.enabled && policy.holderNativeId === current.identity.builderId
      ),
    },
    ...((turn.inputMessageId ?? record.activeInputMessageId)
      ? {
        activeInputMessageId: turn.inputMessageId ??
          record.activeInputMessageId,
      }
      : {}),
    ...(taskSourceInputs?.length
      ? { taskSourceInputs: structuredClone(taskSourceInputs) }
      : {}),
    ...(batchHistory(this.state)
      ? { toolCallHistory: batchHistory(this.state) }
      : {}),
    ...(designerExecutionContext(this.state)
      ? { designer: designerExecutionContext(this.state) }
      : {}),
    ...(invocationCase ? { case: structuredClone(invocationCase) } : {}),
    ...(modelDiagnostics ? { modelDiagnostics } : {}),
    ...(modelDiagnosticsView ? { modelDiagnosticsView } : {}),
    ...(current.operator
      ? {
        operator: {
          nativeId: current.identity.builderId,
          name: current.operator.name,
          instruction: current.operator.instruction,
        },
      }
      : {}),
    ...(workBudget ? { workBudget } : {}),
    mandate: decisionMandate(
      current,
      record,
      creationScopeOf(this.ports.model, current.identity),
    ),
    executionPolicy: structuredClone(current.policy),
    ...(requestOpening ? { requestOpening } : {}),
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(operatorToolAdmission ? { operatorToolAdmission } : {}),
    ...(operatorCreation ? { operatorCreation } : {}),
    ...(operatorEvolution ? { operatorEvolution } : {}),
    configuration: {
      ...structuredClone(current.configuration),
      changes: (this.state.configuration?.changes ?? []).map(
        changeDecisionMetadata,
      ),
    },
    modelVersion: {
      digest: current.version.digest,
      repositoryVersion: current.version.repositoryVersion,
    },
    admittedModelVersion: {
      digest: this.state.executionModel!.version.digest,
      repositoryVersion: this.state.executionModel!.version.repositoryVersion,
    },
    ...(modelSources ? { modelSources } : {}),
    modelEditing: {
      targetedEdits: mayRevise &&
        !!current.modelEditPolicy?.operations.some((op) =>
          op !== "replace-source"
        ),
      rawRevision: !!this.ports.model.proposeRevision &&
        mayRevise &&
        !!current.modelEditPolicy?.operations.includes(
          "replace-source",
        ),
      ...(current.modelEditPolicy
        ? { policy: structuredClone(current.modelEditPolicy) }
        : {}),
    },
    ...(this.ports.model.proposeDelegation &&
        mayRevise &&
        current.modelAdministration
      ? {
        modelAdministration: structuredClone(
          current.modelAdministration,
        ),
      }
      : {}),
    ...(turn.sourceDecision.modelContext
      ? {
        modelContext: turn.sourceDecision.modelContext,
        modelTools: information?.modelTools ??
          this.ports.information?.modelTools?.(current) ??
          modelContextTools(),
      }
      : {}),
    ...(sourceProposals
      ? { sourceProposals: structuredClone(sourceProposals) }
      : {}),
    ...(this.state.lastToolFailure
      ? {
        lastToolFailure: structuredClone(
          this.state.lastToolFailure,
        ),
      }
      : {}),
    contracts: structuredClone(current.contracts),
    messages,
    activeTools: callableTools,
    artifacts,
    ...(current.modelingGuidance
      ? {
        modelingGuidance: structuredClone(
          current.modelingGuidance,
        ),
      }
      : {}),
    ...(information
      ? {
        memoryGuidance: structuredClone(
          information.memoryGuidance,
        ),
        ...(information.skills
          ? { skills: structuredClone(information.skills) }
          : {}),
      }
      : {}),
    modeledBehaviors: await availableBehaviors(
      current,
      this.ports.behaviors,
    ),
    candidates: this.state.candidates.map((
      { id, name, stage, error, kind },
    ) => ({ id, name, stage, error, kind })),
  };
  return { decisionContext, selectiveModel };
}

/** The ordinary decision and compatibility audit use the same complete payload. */
export async function buildDecisionContext(
  this: ConversationDecisionHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  record: SystemRuntimeState,
): Promise<
  { decisionContext: ChatContext; selectiveModel: boolean | undefined }
> {
  const result = await buildUnprojectedDecisionContext.call(
    this,
    turn,
    current,
    record,
  );
  // Provider history has its own bounded append-only representation. The host's
  // legacy authority projection must not compact or count it a second time.
  const { toolCallHistory, ...hostContext } = result.decisionContext;
  const projected = await projectRuntimeDecisionContext(
    toolCallHistory?.some((exchange) => exchange.turn)
      ? hostContext
      : result.decisionContext,
    current.contextPolicy
      ? {
        kind: current.contextPolicy.kind,
        pattern: current.contextPolicy.pattern,
        recentMessages: current.contextPolicy.recentMessages,
        maxMessageCharacters: current.contextPolicy.maxMessageCharacters,
        maxCollectionItems: current.contextPolicy.maxCollectionItems,
        maxContextCharacters: current.contextPolicy.maxContextCharacters,
      }
      : undefined,
  );
  return {
    ...result,
    decisionContext: {
      ...projected,
      ...(toolCallHistory ? { toolCallHistory } : {}),
    },
  };
}

interface CandidateDecisionContextAudit {
  memoryRecords?:
    readonly import("../../../domain/memory/entities/memory-record.ts").MemoryRecord[];
  memoryAuditAt?: string;
}

/** A hypothetical decision is assembled only from already-read host resources.
 * This function performs no consultation, capability resolution or model read.
 * Its output is used for compatibility checking, never provider dispatch.
 */
export function assembleCandidateDecisionContext(
  admittedContext: ChatContext,
  admitted: ExecutableModel,
  candidate: ExecutableModel,
  record: SystemRuntimeState,
  scope: CreationScope,
  audit: CandidateDecisionContextAudit = {},
): ChatContext {
  const requireContext = (value: unknown, message: string): void => {
    if (!value) throw new Error(`Candidate decision context: ${message}`);
  };
  requireContext(
    !admittedContext.contextEvidence &&
      admittedContext.modelVersion?.digest === admitted.version.digest &&
      admittedContext.modelVersion.repositoryVersion ===
        admitted.version.repositoryVersion &&
      admittedContext.admittedModelVersion?.digest ===
        admitted.version.digest &&
      admittedContext.admittedModelVersion.repositoryVersion ===
        admitted.version.repositoryVersion &&
      candidate.identity.builderId === admitted.identity.builderId &&
      candidate.identity.projectId === admitted.identity.projectId &&
      candidate.identity.systemId === admitted.identity.systemId &&
      record.executionModel?.version.digest === admitted.version.digest,
    "the complete payload must come from the actual admitted pin",
  );
  const completeMessages = structuredClone(caseMessages(record));
  // The legacy provider view omits execution sourceIds without a context policy.
  // Restore only those real journal references, never synthetic observations.
  const withoutSourceIds = (messages: ChatContext["messages"]) =>
    messages.map((message) => {
      const copy = structuredClone(message);
      if (copy.execution) delete copy.execution.sourceIds;
      return copy;
    });
  requireContext(
    canonical(withoutSourceIds(admittedContext.messages)) ===
      canonical(withoutSourceIds(completeMessages)),
    "the admitted payload is not the complete current scoped journal",
  );
  const context = structuredClone(admittedContext);
  context.messages = completeMessages;
  context.executionPolicy = structuredClone(candidate.policy);
  context.mandate = decisionMandate(candidate, record, scope);
  context.contracts = structuredClone(candidate.contracts);
  context.configuration = {
    ...structuredClone(candidate.configuration),
    changes: structuredClone(admittedContext.configuration?.changes ?? []),
  };
  context.modelVersion = {
    digest: candidate.version.digest,
    repositoryVersion: candidate.version.repositoryVersion,
  };
  context.admittedModelVersion = structuredClone(context.modelVersion);
  if (candidate.operator) {
    context.operator = {
      nativeId: candidate.identity.builderId,
      name: candidate.operator.name,
      instruction: candidate.operator.instruction,
    };
  } else delete context.operator;
  const creation = operatorCreationContext(candidate, record, scope);
  if (creation) context.operatorCreation = creation;
  else delete context.operatorCreation;
  if (candidate.modelingGuidance) {
    context.modelingGuidance = structuredClone(candidate.modelingGuidance);
  } else delete context.modelingGuidance;
  if (
    canonical(admitted.behaviors ?? []) !== canonical(candidate.behaviors ?? [])
  ) {
    // Changed native declarations must all fit the next payload. Runtime
    // dispatch still resolves support and authority only after real adoption.
    context.modeledBehaviors = structuredClone(
      (candidate.behaviors ?? []).filter((behavior) =>
        behavior.callerNativeId === candidate.identity.builderId
      ),
    );
  }
  const ownDesigner = record.caseInvocation?.kind === "designer";
  const localCaseId = record.caseInvocation?.kind === "local"
    ? record.caseInvocation.caseId
    : undefined;
  const ownCase = localCaseId
    ? record.cases?.find((entry) => entry.id === localCaseId)
    : undefined;
  const budget = ownDesigner
    ? candidate.workBudgetPolicy
    : ownCase
    ? caseBudgetPolicy(
      candidate,
      ownCase.caseTypeId,
      ownCase.scheduling?.maxInvocations,
    )
    : undefined;
  if (context.workBudget && budget) {
    requireContext(
      context.workBudget.budgetId === budget.id,
      "a retained budget cannot acquire another identity",
    );
    const remaining = Math.max(
      0,
      budget.limit - context.workBudget.consumed - context.workBudget.reserved,
    );
    context.workBudget = {
      ...context.workBudget,
      limit: budget.limit,
      remaining,
      exhausted: remaining === 0,
    };
  }
  if (ownDesigner && context.designer) {
    context.designer.policy = structuredClone(candidate.workBudgetPolicy);
  }
  const memoryChanged = canonical(admitted.memoryPolicy ?? null) !==
    canonical(candidate.memoryPolicy ?? null);
  if (memoryChanged) {
    requireContext(
      audit.memoryRecords && audit.memoryAuditAt,
      "a memory change needs the retained host audit",
    );
    requireContext(
      admitted.memoryPolicy && candidate.memoryPolicy &&
        admitted.memoryPolicy.ownerId === candidate.memoryPolicy.ownerId,
      "the admitted memory owner must be retained",
    );
    const isRecall = (
      model: ExecutableModel,
      behavior: NonNullable<ChatContext["modeledBehaviors"]>[number],
    ) =>
      behavior.callerNativeId === model.identity.builderId &&
      matchesNativeInputSchema(behavior.inputSchema, { id: "string" }, [
        "id",
      ]) &&
      (model.operatorEntries ?? []).some((entry) =>
        entry.kind === "memory-recall" &&
        entry.id === behavior.targetNativeId &&
        entry.typeId === behavior.targetTypeId &&
        entry.performerId === model.identity.builderId
      );
    const recall = (admittedContext.modeledBehaviors ?? []).some((behavior) =>
      isRecall(admitted, behavior)
    );
    const candidateRecall = (candidate.behaviors ?? []).some((behavior) =>
      isRecall(candidate, behavior)
    );
    requireContext(
      admittedContext.memoryGuidance !== undefined,
      "the actual admitted memory reader evidence is missing",
    );
    if (!recall || !candidateRecall) {
      // A policy does not create a recall exposure. An authentic empty read
      // with no declared future recall has no hidden note payload to project.
      requireContext(
        !candidateRecall &&
          (recall || admittedContext.memoryGuidance!.length === 0),
        "the actual admitted payload proves no current memory recall permission",
      );
      context.memoryGuidance = [];
      return context;
    }
    const guidance: NonNullable<ChatContext["memoryGuidance"]>[number][] = [];
    for (const memory of audit.memoryRecords!) {
      requireContext(
        memory.ownerId === admitted.identity.builderId,
        "the memory audit includes a foreign owner",
      );
      const policy = candidate.memoryPolicy!;
      const view = memoryView(memory, audit.memoryAuditAt!, {
        ...policy,
        modelVersion: {
          digest: candidate.version.digest,
          repositoryVersion: candidate.version.repositoryVersion!,
        },
        permissions: {},
      });
      if (!view.usableAsGuidance) continue;
      requireContext(
        memory.content.scope.every((scope) =>
          admitted.memoryPolicy!.allowedScopes.includes(scope)
        ),
        "candidate policy cannot expose notes outside the current admitted recall scope",
      );
      guidance.push(memoryGuidance(view));
    }
    context.memoryGuidance = guidance;
  }
  return context;
}

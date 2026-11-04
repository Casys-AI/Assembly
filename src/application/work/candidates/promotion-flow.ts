import { assertInitialAdmissionCurrentAuthority } from "../runtime/initial-admission-transfer.ts";
import {
  budgetContinuationReplayEvidence,
  recordBudgetContinuationSelection,
} from "../runtime/budget-transition.ts";
import type { ArtifactSourceServicePort } from "../artifacts/publication.ts";
import { resolveCandidateSource } from "../artifacts/candidate-source.ts";
import type { ArtifactSourceBusinessProof } from "../../../domain/work/artifacts/source-publication.ts";
import { nativeCatalogAdvanceEvidence } from "../native-execution/model-advance.ts";
import {
  type NativeExecutionContribution,
  nativeExecutionContribution,
  nativeExecutionIdentity,
  type NativeExecutionPort,
  runtimeRevisionReference,
} from "../native-execution/contract.ts";
import { AgentBudgetWait } from "../budget/agent.ts";
import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import { assertToolName } from "../../../domain/work/value-objects/tool-name.ts";
import {
  delegatedCandidateAuthorityExercise,
  toolAdmissionPreparation,
} from "../../../domain/governance/policies/tool-admission-policy.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { mainExecutionSpace } from "../../../domain/governance/operator-authority.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import { activeBatchCall } from "../conversation/batches.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import type { NativeToolContract } from "../../../domain/work/candidates.ts";
import {
  type CompiledFlowNode,
  type FlowActionResult,
  type FlowValues,
} from "../../../domain/model/execution/flow.ts";
import type { WorkBudgetOperation } from "../../../domain/work/policies/budget.ts";
import type {
  AdmissionRecord,
  ArtifactReuseOrigin,
  Candidate,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { AgentPort, ClockPort, ToolRunnerPort } from "../runtime/ports.ts";
import type { ExactCandidateReview } from "./promotion.ts";
import {
  draftDigest,
  errorText,
  makeEvent,
  valueDigest,
} from "../runtime/values.ts";

export interface PromotionFlowHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    clock: ClockPort;
    agents: Pick<AgentPort, "review" | "admit">;
    execution?: NativeExecutionPort;
    artifactSources?: ArtifactSourceServicePort;
    runner: Pick<ToolRunnerPort, "test">;
  };
  currentModel(): Promise<ExecutableModel>;
  inspectModelVersion(): Promise<ExecutableModel>;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  candidate(id: string): Candidate;
  exactInputCandidate(input: unknown, expectedId?: string): Candidate;
  candidateContract(
    model: ExecutableModel,
    candidate: Candidate,
  ): NativeToolContract;
  exactReview(
    model: ExecutableModel,
    candidate: Candidate,
  ): Promise<ExactCandidateReview>;
  stage(id: string, stage: Stage, label: string): Promise<void>;
  feedback(text: string): Promise<void>;
  activate(
    id: string,
    authority: AdmissionRecord["authority"],
    reason: string,
  ): Promise<void>;
  withExecutionOrigin<T>(
    origin: { effectKey: string; inputMessageId: string },
    effect: () => Promise<T>,
  ): Promise<T>;
  action<T>(
    node: CompiledFlowNode,
    effect: (model: ExecutableModel) => Promise<T>,
  ): Promise<T>;
  agentCall<T>(
    model: ExecutableModel,
    operation: WorkBudgetOperation,
    dispatch: () => Promise<T>,
  ): Promise<T>;
  suspendBudget(
    error: AgentBudgetWait,
    node: CompiledFlowNode,
    operation: WorkBudgetOperation,
    candidateId?: string,
  ): Promise<void>;
  executionReference(
    model: ExecutableModel,
    element?: { actionId?: string; edgeId?: string },
  ): ModelExecutionReference;
}

interface PromotionContext {
  executionSubjectId?: string;
  executionEffectKey?: string;
  inputMessageId?: string;
  id?: string;
  draft?: ToolDraft;
  origin?: ArtifactReuseOrigin;
  initialToolSeed?: Candidate["initialToolSeed"];
}

export async function build(
  this: PromotionFlowHost,
  draft?: ToolDraft,
  resumeId?: string,
  origin?: ArtifactReuseOrigin,
  initialToolSeed?: Candidate["initialToolSeed"],
): Promise<void> {
  await this.currentModel();
  let model = structuredClone(this.state.executionModel!);
  const context: PromotionContext = {
    id: resumeId,
    draft,
    origin,
    initialToolSeed,
  };
  const previous = resumeId ? this.candidate(resumeId) : undefined;
  if (!this.ports.execution) {
    throw new Error("Native promotion execution port is required");
  }
  const budgetTransition = this.state.budgetCeilingTransition;
  const budgetMember = budgetTransition?.resume &&
    budgetTransition.manifest.members.find((member) =>
      member.identity.purpose === "promotion" &&
      member.identity.subjectId === previous?.promotionExecution?.subjectId
    );
  const contribution: NativeExecutionContribution = budgetMember
    ? {
      id: budgetTransition!.resume!.contributionId,
      kind: "resume",
      inputMessageId: budgetTransition!.manifest.family.inputMessageId,
    }
    : previous?.admissionDecision
    ? {
      id: `candidate-decision:${previous.id}:${await valueDigest(
        previous.admissionDecision,
      )}`,
      kind: "resume" as const,
    }
    : initialToolSeed
    ? {
      id:
        `initial-tool:${initialToolSeed.id}:${initialToolSeed.selectionDigest}`,
      kind: "input" as const,
    }
    : nativeExecutionContribution(this.state);
  const active = activeBatchCall(this.state);
  const subjectId = previous?.promotionExecution?.subjectId ??
    await valueDigest({
      input: contribution.id,
      batch: active ? [active.batch.id, active.call.id] : undefined,
      draft: draft ? await draftDigest(draft) : undefined,
    });
  context.executionSubjectId = subjectId;
  context.inputMessageId = previous?.promotionExecution?.inputMessageId ??
    contribution.inputMessageId;
  const identity = nativeExecutionIdentity(this.state, "promotion", subjectId);
  const initialTransfer = previous?.initialAdmissionTransfer;
  if (resumeId && !initialTransfer) {
    const saved = (await this.ports.execution.inspect(identity.operatorId))
      .find((execution) =>
        execution.threadId === previous?.promotionExecution?.threadId &&
        canonical(execution.identity) === canonical(identity) &&
        execution.identity.purpose === "promotion" &&
        execution.identity.subjectId === subjectId &&
        (execution.modelDigest === model.version.digest ||
          budgetMember &&
            execution.modelDigest ===
              budgetTransition!.manifest.from.version.digest) &&
        execution.status === "waiting"
      );
    if (!previous?.promotionExecution || !saved) {
      throw new Error(
        "The exact candidate has no verified native promotion continuation",
      );
    }
  }
  try {
    if (
      initialTransfer &&
      canonical(identity) !== canonical(initialTransfer.target.identity)
    ) {
      throw new Error(
        "Initial admission requires its exact recorded target Case",
      );
    }
    const result = await this.ports.execution.run({
      ...(initialTransfer
        ? { initialAdmissionTransfer: structuredClone(initialTransfer) }
        : {}),
      identity,
      contribution,
      model,
      businessRevision: runtimeRevisionReference(this.state),
      flow: model.flows.promotion,
      maxSteps: model.policy.maxFlowSteps,
    }, {
      readAdoptedModel: async () => {
        const head = await this.inspectModelVersion();
        if (
          head.version.repositoryVersion !==
            this.state.executionModel!.version.repositoryVersion ||
          head.version.digest !== this.state.executionModel!.version.digest
        ) {
          throw new Error(
            "The catalog publication is no longer the exact current source HEAD",
          );
        }
        return structuredClone(this.state.executionModel!);
      },
      continuationSelected: async (receipt) => {
        if (receipt.evidence.kind !== "verified-budget-ceiling-advance") return;
        await this.currentModel();
        const replay = await budgetContinuationReplayEvidence(
          this.state,
          receipt,
          model,
        );
        await this.update((state) =>
          recordBudgetContinuationSelection(state, receipt, replay)
        );
      },
      modelAdvanced: (next) => {
        model = structuredClone(next);
        return Promise.resolve();
      },
      assertBoundary: async () => {
        const current = await this.currentModel();
        if (initialTransfer) {
          assertInitialAdmissionCurrentAuthority(initialTransfer, current);
        }
        if (
          current.version.digest !== model.version.digest ||
          this.state.executionModel?.version.repositoryVersion !==
            model.version.repositoryVersion
        ) {
          throw new Error(
            "Native promotion requires its exact admitted model pin",
          );
        }
      },
      handle: async (node, inputs, _values, execution) => {
        if (typeof execution.localState.promotionId === "string") {
          context.id = execution.localState.promotionId;
        }
        let budgetWait = false;
        context.executionEffectKey = execution.effectKey;
        const output = await this.withExecutionOrigin({
          effectKey: execution.effectKey,
          inputMessageId: context.inputMessageId ?? initialToolSeed?.id ??
            subjectId,
        }, () =>
          this.action(node, async (current) => {
            try {
              return await promotionAction.call(
                this,
                context,
                current,
                node,
                inputs,
              );
            } catch (error) {
              if (!(error instanceof AgentBudgetWait)) throw error;
              budgetWait = true;
              await this.suspendBudget(
                error,
                node,
                node.mechanism === "review_candidate" ? "review" : "admit",
                context.id,
              );
              return { suspend: true };
            }
          }));
        const modelAdvance = await nativeCatalogAdvanceEvidence(
          model,
          this.state,
        );
        return {
          ...output,
          ...(modelAdvance ? { modelAdvance } : {}),
          ...(output.suspend
            ? {
              suspensionKind: budgetWait
                ? "budget" as const
                : "decision" as const,
            }
            : {}),
          localState: context.id ? { promotionId: context.id } : {},
        };
      },
      onEvent: async (event) => {
        const step = (event as typeof event & { step: number }).step;
        const id =
          `native-promotion:${subjectId}:${model.version.digest}:${step}:${event.kind}:${
            event.actionId ?? event.edgeId
          }`;
        await this.update((state) => {
          if (!state.events.some((item) => item.id === id)) {
            state.events.push({
              ...makeEvent(
                this.ports.clock,
                `flow-${event.kind}`,
                `Promotion : ${event.kind}`,
              ),
              id,
              execution: {
                ...this.executionReference(model, {
                  actionId: event.actionId,
                  edgeId: event.edgeId,
                }),
                digest: (event as typeof event & { modelDigest?: string })
                  .modelDigest ?? model.version.digest,
                sourceIds:
                  (event as typeof event & { modelSourceIds?: string[] })
                    .modelSourceIds ?? model.version.sourceIds,
                repositoryVersion:
                  (event as typeof event & { repositoryVersion?: string })
                    .repositoryVersion ?? model.version.repositoryVersion,
              },
            });
          }
        });
      },
    });
    context.id = typeof result.localState?.promotionId === "string"
      ? result.localState.promotionId
      : context.id;
    if (context.id) {
      await this.update((state) => {
        const candidate = state.candidates.find((item) =>
          item.id === context.id
        )!;
        candidate.promotionExecution = {
          subjectId,
          threadId: result.threadId,
          modelDigest: model.version.digest,
          ...(context.inputMessageId
            ? { inputMessageId: context.inputMessageId }
            : {}),
        };
        if (!budgetMember) {
          candidate.promotionModelDigest = model.version.digest;
        }
      });
    }
  } catch (error) {
    const recorded = this.state.candidates.find((candidate) =>
      candidate.id === context.id
    );
    if (!recorded || recorded.stage === "active") throw error;
    const message = errorText(error);
    // An activation refused for good was already settled, with its code and
    // event, by the activation driver: only the caller still has to hear of it.
    const settled = recorded.stage === "failed" &&
      recorded.errorCode !== undefined;
    if (!settled) {
      await this.update((s) => {
        const c = s.candidates.find((c) => c.id === context.id)!;
        if (!hasActivationIntent(c) && !c.initialAdmissionTransfer) {
          c.stage = "failed";
        }
        c.error = message;
        delete c.promotionCursor;
        delete c.promotionContext;
        s.events.push(
          makeEvent(
            this.ports.clock,
            c.stage === "activating"
              ? "tool-activation-interrupted"
              : "tool-failed",
            message,
            c,
          ),
        );
      });
    }
    await this.feedback(
      settled
        ? `Activation refusée [${recorded.errorCode}], aucune activation : ${message}`
        : hasActivationIntent(recorded)
        ? `Activation interrompue ; reprise de la publication requise : ${message}`
        : `Construction interrompue, aucune activation : ${message}`,
    );
    if (resumeId || hasActivationIntent(recorded)) throw error;
  }
}

function promotionAction(
  this: PromotionFlowHost,
  context: PromotionContext,
  currentModel: ExecutableModel,
  node: CompiledFlowNode,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  switch (node.mechanism) {
    case "propose_candidate":
      return proposeCandidate.call(this, context, currentModel);
    case "test_candidate":
      return testCandidate.call(this, context, inputs);
    case "review_candidate":
      return reviewCandidate.call(
        this,
        context,
        currentModel,
        node,
        inputs,
      );
    case "decide_admission":
      return decideAdmission.call(this, context, currentModel, inputs);
    case "activate_candidate":
      return activateCandidate.call(this, context, inputs);
    case "refuse_candidate":
      return refuseCandidate.call(this, context, inputs);
    default:
      throw new Error(
        `Mécanisme natif interdit dans la promotion : ${node.mechanism}`,
      );
  }
}

async function proposeCandidate(
  this: PromotionFlowHost,
  context: PromotionContext,
  currentModel: ExecutableModel,
): Promise<FlowActionResult> {
  const { draft, origin, initialToolSeed } = context;
  if (!draft || context.id) {
    throw new Error(
      "La proposition native exige un candidat nouveau exact.",
    );
  }
  if (!currentModel.mandate.mayPropose.includes(draft.kind)) {
    throw new Error(
      "Le mandat natif ne permet pas ce type de candidat.",
    );
  }
  // The name becomes a SysML literal at activation: refuse what cannot be
  // written now, before tests, review and admission spend anything on it.
  assertToolName(draft.name);
  const caseId = caseExecutionContext(this.state)?.caseId;
  const designer = designerExecutionContext(this.state);
  const toolAdmissionPolicyPins = toolAdmissionPreparation(
    currentModel,
    draft.kind,
    mainExecutionSpace(currentModel.identity),
  );
  if (!caseId && !designer) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "A new candidate requires an explicit Case",
      { operatorId: currentModel.identity.builderId },
      "Open a Case before proposing a candidate.",
    );
  }
  if (!context.executionEffectKey) {
    throw new Error("The exact native proposal invocation is absent");
  }
  const stable = await valueDigest({
    kind: "native-candidate",
    ownerId: currentModel.identity.builderId,
    invocationId: context.executionEffectKey,
  });
  // Stable host-issued UUID shape across queue/Git/SQL recovery of this action.
  const candidateId = `${stable.slice(0, 8)}-${stable.slice(8, 12)}-8${
    stable.slice(13, 16)
  }-${((Number.parseInt(stable[16], 16) & 3) | 8).toString(16)}${
    stable.slice(17, 20)
  }-${stable.slice(20, 32)}`;
  const candidate: Candidate = {
    ...structuredClone(draft),
    id: candidateId,
    ...(caseId ? { caseId } : { designerScopeId: designer!.scopeId }),
    digest: await draftDigest(draft),
    stage: "proposed",
    createdAt: this.ports.clock.now(),
    baseCatalogRevision: this.state.catalogRevision,
    ...(context.executionSubjectId
      ? {
        promotionExecution: {
          subjectId: context.executionSubjectId,
          modelDigest: currentModel.version.digest,
          ...(context.inputMessageId
            ? { inputMessageId: context.inputMessageId }
            : {}),
        },
      }
      : {}),
    ...(activeBatchCall(this.state)
      ? {
        batchCall: {
          batchId: activeBatchCall(this.state)!.batch.id,
          callId: activeBatchCall(this.state)!.call.id,
        },
      }
      : {}),
    requiredAuthority: currentModel.configuration.builder.admissionAuthority,
    proposedConfigurationRevision: currentModel.configuration.revision,
    ...(toolAdmissionPolicyPins?.length ? { toolAdmissionPolicyPins } : {}),
    ...(origin ? { reusedFrom: structuredClone(origin) } : {}),
    ...(initialToolSeed
      ? { initialToolSeed: structuredClone(initialToolSeed) }
      : {}),
  };
  if (
    candidate.requiredAuthority === "human" && toolAdmissionPolicyPins?.length
  ) {
    candidate.toolAdmissionContract = structuredClone(
      this.candidateContract(currentModel, candidate),
    );
  }
  if (
    !this.ports.artifactSources || !currentModel.version.repositoryVersion ||
    !context.executionEffectKey
  ) {
    throw new Error(
      "The retained artifact source service and exact native invocation are required",
    );
  }
  const proposalNode = currentModel.flows.promotion.nodes.find((node) =>
    node.mechanism === "propose_candidate"
  );
  if (!proposalNode) {
    throw new Error("The admitted promotion primitive is absent");
  }
  const proof: ArtifactSourceBusinessProof = initialToolSeed
    ? {
      kind: "admitted-model-seed",
      ownerId: currentModel.identity.builderId,
      sourceElementId: initialToolSeed.nativeId,
      modelVersion: initialToolSeed.modelVersion,
    }
    : {
      kind: "native-action",
      ownerId: currentModel.identity.builderId,
      modelVersion: {
        digest: currentModel.version.digest,
        repositoryVersion: currentModel.version.repositoryVersion,
      },
      flowRootNativeId: currentModel.flows.promotion.rootNativeId,
      nativeActionId: proposalNode.nativeId,
      mechanism: "propose_candidate",
      invocationId: context.executionEffectKey,
    };
  candidate.sourceBinding = await this.ports.artifactSources.publishTool({
    artifactId: candidate.id,
    ownerId: currentModel.identity.builderId,
    localArtifactId: candidate.id,
    invocationId: context.executionEffectKey,
    baseVersion: initialToolSeed?.modelVersion.repositoryVersion ??
      currentModel.version.repositoryVersion,
    expectedDigest: candidate.digest,
    draft: structuredClone(draft),
    proof,
    ...(origin?.sourceReference ? { upstream: origin.sourceReference } : {}),
  });
  context.id = candidate.id;
  await this.update((s) => {
    s.candidates.push(candidate);
    if (candidate.batchCall) {
      const call = s.conversationBatches?.find((batch) =>
        batch.id === candidate.batchCall!.batchId
      )
        ?.calls.find((call) => call.id === candidate.batchCall!.callId);
      if (call) call.candidateId = candidate.id;
    }
    s.events.push(
      makeEvent(
        this.ports.clock,
        "tool-proposed",
        `Proposition : ${candidate.name}`,
        candidate,
      ),
    );
  });
  return {
    outputs: {
      candidate: {
        id: candidate.id,
        candidateId: candidate.id,
        digest: candidate.digest,
        baseCatalogRevision: candidate.baseCatalogRevision,
      },
    },
  };
}

async function testCandidate(
  this: PromotionFlowHost,
  context: PromotionContext,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const c = this.exactInputCandidate(inputs.candidate, context.id);
  await this.stage(c.id, "testing", "Essai du code généré");
  const testingModel = await this.currentModel();
  const contract = this.candidateContract(testingModel, c);
  const tests = await this.ports.runner.test(
    await resolveCandidateSource(
      c,
      testingModel.identity.builderId,
      this.ports.artifactSources,
    ),
  );
  const after = await this.currentModel();
  if (canonical(contract) !== canonical(this.candidateContract(after, c))) {
    throw new Error("Le contrat du candidat a changé pendant les essais.");
  }
  const preparationEvidence = {
    modelDigest: testingModel.version.digest,
    testsDigest: await valueDigest(tests),
    contractDigest: await valueDigest(contract),
  };
  await this.update((s) => {
    const stored = s.candidates.find((c) => c.id === context.id)!;
    stored.tests = tests;
    stored.preparationEvidence = preparationEvidence;
  });
  return { outputs: { result: tests } };
}

async function reviewCandidate(
  this: PromotionFlowHost,
  context: PromotionContext,
  currentModel: ExecutableModel,
  node: CompiledFlowNode,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const c = this.exactInputCandidate(inputs.candidate, context.id);
  if (
    !c.tests ||
    JSON.stringify(inputs.tests) !== JSON.stringify(c.tests)
  ) {
    throw new Error(
      "La revue native exige les essais du candidat exact.",
    );
  }
  const reviewerId = currentModel.configuration.reviewer?.id;
  if (
    !reviewerId || !currentModel.identity.reviewerId ||
    node.performerId !== currentModel.identity.reviewerId
  ) {
    throw new Error(
      "La revue native exige son reviewer alloué exact.",
    );
  }
  const contract = this.candidateContract(currentModel, c);
  const proof = {
    modelDigest: currentModel.version.digest,
    actionId: node.nativeId,
    reviewerId,
    testsDigest: await valueDigest(c.tests),
    contractDigest: await valueDigest(contract),
  };
  await this.stage(
    c.id,
    "reviewing",
    "Le reviewer examine le candidat",
  );
  const reviewArgs: Parameters<AgentPort["review"]> = [
    await resolveCandidateSource(
      c,
      currentModel.identity.builderId,
      this.ports.artifactSources,
    ),
    structuredClone(c.tests!),
    {
      contract: structuredClone(contract),
      modelVersion: {
        digest: currentModel.version.digest,
        repositoryVersion: currentModel.version.repositoryVersion,
      },
      reviewerId,
      mandate: {
        mayReviewExactCandidate: true,
        mayAdmitReviewedCandidates: true,
        mayActivate: false,
      },
    },
  ];
  const review = await this.agentCall(
    currentModel,
    "review",
    () => this.ports.agents.review(...reviewArgs),
  );
  await this.update((s) => {
    delete s.budgetSuspension;
  });
  await this.currentModel();
  if (
    review.candidateDigest !== c.digest ||
    !["approve", "refuse"].includes(review.verdict) ||
    typeof review.reason !== "string" || !review.reason.trim()
  ) {
    throw new Error(
      "La décision de revue ne correspond pas au candidat examiné.",
    );
  }
  await this.update((s) => {
    const stored = s.candidates.find((candidate) =>
      candidate.id === context.id
    )!;
    stored.review = structuredClone(review);
    stored.reviewExecution = proof;
    s.events.push(
      makeEvent(
        this.ports.clock,
        "review-decided",
        `${reviewerId} : ${review.verdict} — ${review.reason}`,
        stored,
      ),
    );
  });
  return {
    outputs: {
      decision: await this.exactReview(
        currentModel,
        this.candidate(c.id),
      ),
    },
  };
}

async function decideAdmission(
  this: PromotionFlowHost,
  context: PromotionContext,
  currentModel: ExecutableModel,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const c = this.exactInputCandidate(inputs.candidate, context.id);
  if (
    !c.tests ||
    JSON.stringify(inputs.tests) !== JSON.stringify(c.tests)
  ) {
    throw new Error(
      "La décision native exige les essais du candidat exact.",
    );
  }
  const contract = this.candidateContract(currentModel, c);
  const delegation = c.admissionDecision?.authorityExercise
    ?.candidateDelegation;
  const authority = c.requiredAuthority === "human" && delegation
    ? "delegate"
    : c.requiredAuthority!;
  if (authority === "delegate") {
    const exact = delegatedCandidateAuthorityExercise(
      currentModel,
      c,
      delegation!,
      mainExecutionSpace(currentModel.identity),
    );
    if (
      canonical(exact) !== canonical(c.admissionDecision!.authorityExercise)
    ) {
      throw new Error(
        "The delegated admission proof no longer matches the exact candidate.",
      );
    }
  }
  if (authority === "human" && !c.admissionDecision) {
    // Human admission is the default; an exact prepared delegation can supply
    // another decision maker. Only the later decision revalidates its grant.
    const delegatedRoutePrepared = Boolean(c.toolAdmissionPolicyPins?.length);
    await this.stage(
      c.id,
      "awaiting-admission",
      delegatedRoutePrepared
        ? "Essais réussis : admission explicite attendue"
        : "Essais réussis : admission humaine attendue",
    );
    await this.feedback(
      `Le candidat ${c.name} et ses essais sont visibles. ${
        delegatedRoutePrepared
          ? "Une décision d’admission explicite par une autorité compétente"
          : "Une décision humaine explicite"
      } est requise pour le digest ${c.digest}. Un message de chat ne vaut pas admission.`,
    );
    return { suspend: true };
  }
  let decision = c.admissionDecision;
  if (authority !== "human" && authority !== "delegate") {
    if (
      currentModel.configuration.builder.admissionAuthority !==
        authority
    ) {
      throw new Error(
        "Le mandat a changé depuis la proposition du candidat.",
      );
    }
    const configuration = currentModel.configuration;
    const sourceContext = {
      contract: structuredClone(contract),
      modelVersion: {
        digest: currentModel.version.digest,
        repositoryVersion: currentModel.version.repositoryVersion,
      },
    };
    if (authority === "builder") {
      await this.stage(
        c.id,
        "reviewing",
        "Le constructeur décide de l’admission sous son mandat révisé",
      );
      if (
        !currentModel.mandate.mayAdmitOwnCandidates ||
        !this.ports.agents.admit
      ) {
        throw new Error(
          "Le constructeur ne détient pas le mandat d’admission.",
        );
      }
      const admissionArgs: Parameters<
        NonNullable<AgentPort["admit"]>
      > = [
        await resolveCandidateSource(
          c,
          currentModel.identity.builderId,
          this.ports.artifactSources,
        ),
        structuredClone(c.tests!),
        {
          ...sourceContext,
          builderId: configuration.builder.id,
          mandateRevision: configuration.builder.mandateRevision,
          configurationRevision: configuration.revision,
          mayAdmitOwnCandidates: true,
        },
      ];
      decision = await this.agentCall(
        currentModel,
        "admit",
        () => this.ports.agents.admit!(...admissionArgs),
      );
    } else {
      const review = await this.exactReview(currentModel, c);
      if (
        JSON.stringify(inputs.review) !== JSON.stringify(review)
      ) {
        throw new Error(
          "L’admission native exige la sortie de revue exacte.",
        );
      }
      decision = structuredClone(c.review);
    }
    await this.update((s) => {
      delete s.budgetSuspension;
    });
    await this.currentModel();
  }
  if (!decision || decision.candidateDigest !== c.digest) {
    throw new Error(
      "La décision de revue ne correspond pas au candidat examiné.",
    );
  }
  await this.update((s) => {
    const stored = s.candidates.find((c) => c.id === context.id)!;
    stored.admissionDecision = decision;
    s.events.push(
      makeEvent(
        this.ports.clock,
        "admission-decided",
        `${authority} : ${decision!.verdict} — ${decision!.reason}`,
        stored,
      ),
    );
  });
  return {
    outputs: {
      decision: {
        admitted: decision.verdict === "approve",
        candidateDigest: c.digest,
        reason: decision.reason,
        authority,
      },
    },
  };
}

async function activateCandidate(
  this: PromotionFlowHost,
  context: PromotionContext,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const c = this.exactInputCandidate(inputs.candidate, context.id);
  const admission = inputs.admission as {
    admitted?: boolean;
    candidateDigest?: string;
  };
  if (
    admission?.candidateDigest !== c.digest ||
    admission.admitted !== true ||
    c.admissionDecision?.verdict !== "approve"
  ) {
    throw new Error(
      "L’activation exige l’admission native du candidat exact.",
    );
  }
  await this.activate(
    c.id,
    c.requiredAuthority === "human" &&
      c.admissionDecision.authorityExercise?.candidateDelegation
      ? "delegate"
      : c.requiredAuthority!,
    c.admissionDecision.reason,
  );
  return {};
}

async function refuseCandidate(
  this: PromotionFlowHost,
  context: PromotionContext,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const c = this.exactInputCandidate(inputs.candidate, context.id);
  await this.stage(
    c.id,
    "refused",
    "Le candidat n’a pas été admis",
  );
  await this.feedback(
    `Admission refusée pour ${c.name} : ${
      c.admissionDecision?.reason ?? c.review?.reason ??
        JSON.stringify(c.tests)
    }`,
  );
  return {};
}

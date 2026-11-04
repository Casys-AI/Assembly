import type { OperatorExecutionDelivery } from "../operators/execution.ts";
import { parseAcceptedCommand } from "../operators/command-delivery.ts";
import type {
  NativeExecutionActionResult,
  NativeExecutionRequest,
  NativeExecutionSnapshot,
} from "../native-execution/contract.ts";
import {
  effectResultDigest,
  type NativeWaitEvidence,
} from "../native-execution/wait-evidence.ts";
import type {
  Candidate,
  InitialToolAdmissionTransfer,
} from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { type Case, isOpenCase } from "../../../domain/work/entities/cases.ts";
import { invocationKey } from "../operators/journal.ts";
import { draftDigest, valueDigest } from "./values.ts";
import { nativeFlowContractDigest } from "../../../domain/model/execution/flow-contract.ts";

/** Bounded verification for the one initial-tool admission transition.
 * No database, graph scheduling or historical authority grant lives here. */

export class InitialAdmissionTransferRefused extends Error {
  readonly code = "INITIAL_ADMISSION_TRANSFER_REFUSED";
  constructor(readonly reason: string) {
    super(`Initial admission transfer refused: ${reason}`);
    this.name = "InitialAdmissionTransferRefused";
  }
}
function requireTransfer(value: unknown, reason: string): asserts value {
  if (!value) throw new InitialAdmissionTransferRefused(reason);
}
export async function initialAdmissionDecisionKey(
  state: SystemRuntimeState,
  candidate: Candidate,
): Promise<string> {
  return `initial-admission:${await executionDigest({
    runtimeId: state.id,
    operatorId: state.executionModel?.identity.builderId,
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    seedId: candidate.initialToolSeed?.id,
  })}`;
}

/** B's birth identity is frozen, while ordinary worker transitions may move
 * its lifecycle between open and waiting. Closure is checked separately.
 * A's historical digest deliberately remains the complete closed record. */
export async function initialAdmissionTargetCaseDigest(
  record: Case,
): Promise<string> {
  const {
    status: _status,
    closedAt: _closedAt,
    closedBy: _closedBy,
    verdict: _verdict,
    ...birth
  } = record;
  return await valueDigest(birth);
}

/** The immutable source revision was captured before opening B. The target is
 * read again under the adapter's current claim/publication fence. */
export async function verifyInitialAdmissionTransfer(
  request: NativeExecutionRequest,
  source: SystemRuntimeState,
  current: SystemRuntimeState,
): Promise<InitialToolAdmissionTransfer> {
  const intent = request.initialAdmissionTransfer;
  requireTransfer(
    intent?.kind === "initial-tool-admission-transfer",
    "missing-intent",
  );
  const historical = source.candidates.find((c) => c.id === intent.candidateId);
  const candidate = current.candidates.find((c) => c.id === intent.candidateId);
  const model = current.executionModel;
  requireTransfer(
    historical && candidate && model && source.executionModel,
    "missing-source",
  );
  requireTransfer(
    current.id === intent.runtimeId && source.id === intent.runtimeId &&
      source.revision === intent.sourceRevision &&
      model.identity.projectId === intent.projectId &&
      model.identity.systemId === intent.systemId &&
      model.identity.builderId === intent.operatorId &&
      canonical(source.executionModel.identity) === canonical(model.identity) &&
      canonical(source.executionModel.version) === canonical(model.version) &&
      canonical(request.model.identity) === canonical(model.identity) &&
      canonical(request.model.version) === canonical(model.version),
    "foreign-scope-or-pin",
  );
  requireTransfer(
    intent.key === await initialAdmissionDecisionKey(source, historical),
    "logical-key",
  );
  requireTransfer(
    historical.stage === "awaiting-admission" &&
      historical.requiredAuthority === "human" &&
      historical.admissionDecision === undefined &&
      historical.admission === undefined &&
      historical.digest === intent.candidateDigest &&
      candidate.digest === intent.candidateDigest &&
      historical.promotionModelDigest === intent.pin.modelDigest &&
      candidate.promotionModelDigest === intent.pin.modelDigest &&
      historical.baseCatalogRevision === candidate.baseCatalogRevision &&
      candidate.baseCatalogRevision === current.catalogRevision &&
      historical.caseId === intent.source.caseId &&
      candidate.caseId === intent.source.caseId &&
      await draftDigest(historical) === intent.candidateDigest &&
      await draftDigest(candidate) === intent.candidateDigest &&
      historical.tests?.passed === true && candidate.tests?.passed === true &&
      await valueDigest(historical.tests) === intent.testsDigest &&
      await valueDigest(candidate.tests) === intent.testsDigest &&
      historical.preparationEvidence?.testsDigest === intent.testsDigest &&
      canonical(historical.preparationEvidence) ===
        canonical(intent.preparationEvidence) &&
      canonical(candidate.preparationEvidence) ===
        canonical(intent.preparationEvidence) &&
      canonical(historical.initialToolSeed) === canonical(intent.seed) &&
      canonical(candidate.initialToolSeed) === canonical(intent.seed) &&
      canonical(historical.sourceBinding) === canonical(intent.sourceBinding) &&
      canonical(candidate.sourceBinding) === canonical(intent.sourceBinding) &&
      intent.sourceBinding.ownerId === intent.operatorId &&
      intent.sourceBinding.localArtifactId === intent.candidateId &&
      intent.sourceBinding.reference.contentDigest === intent.candidateDigest &&
      intent.seed.selectionDigest === intent.candidateDigest,
    "candidate-seed-tests-or-source",
  );
  const seed = model.initialTools?.find((item) => item.id === intent.seed.id);
  requireTransfer(
    seed && seed.nativeId === intent.seed.nativeId &&
      await draftDigest(seed.draft) === intent.seed.selectionDigest &&
      intent.seed.modelVersion.digest ===
        intent.preparationEvidence.modelDigest &&
      intent.seed.modelVersion.digest === intent.pin.modelDigest &&
      intent.seed.modelVersion.repositoryVersion ===
        intent.pin.repositoryVersion,
    "selection",
  );
  const contracts = model.contracts.filter((contract) =>
    contract.kind === candidate.kind
  );
  requireTransfer(
    contracts.length === 1 &&
      await valueDigest(contracts[0]) ===
        intent.preparationEvidence.contractDigest,
    "preparation-contract",
  );
  requireTransfer(
    canonical(candidate.admissionDecision) === canonical(intent.decision) &&
      canonical(candidate.initialAdmissionTransfer) === canonical(intent) &&
      intent.decision.candidateDigest === intent.candidateDigest &&
      ["approve", "refuse"].includes(intent.decision.verdict) &&
      !!intent.decision.reason.trim() &&
      intent.decisionDigest === await valueDigest(intent.decision) &&
      canonical(intent.decision.authorityExercise) ===
        canonical(exerciseOwnerAuthority(model, "candidate-admission")) &&
      !intent.decision.authorityExercise?.candidateDelegation &&
      canonical(request.contribution) === canonical(intent.contribution) &&
      intent.contribution.id ===
        `candidate-decision:${intent.candidateId}:${intent.decisionDigest}` &&
      intent.contribution.kind === "resume",
    "decision-or-current-authority",
  );
  const oldCase = source.cases?.find((record) =>
    record.id === intent.source.caseId
  );
  const stillOld = current.cases?.find((record) =>
    record.id === intent.source.caseId
  );
  const target = current.cases?.find((record) =>
    record.id === intent.target.caseId
  );
  requireTransfer(
    oldCase?.status === "closed-done" && oldCase.closedAt &&
      oldCase.openedFrom.origin === "initialization" &&
      oldCase.owner === intent.operatorId &&
      canonical(stillOld) === canonical(oldCase) &&
      await valueDigest(oldCase) === intent.source.caseDigest &&
      target && isOpenCase(target) && target.closedAt === undefined &&
      target.openedFrom.origin === "initialization" &&
      target.owner === intent.operatorId &&
      await initialAdmissionTargetCaseDigest(target) ===
        intent.target.caseDigest &&
      target.id !== oldCase.id &&
      current.caseInvocation?.kind === "local" &&
      current.caseInvocation.caseId === target.id &&
      invocationKey(current.caseInvocation) ===
        intent.target.identity.invocationKey &&
      canonical(request.identity) === canonical(intent.target.identity) &&
      intent.source.identity.operatorId === intent.operatorId &&
      intent.target.identity.operatorId === intent.operatorId &&
      intent.source.identity.purpose === "promotion" &&
      intent.target.identity.purpose === "promotion" &&
      intent.source.identity.subjectId ===
        historical.promotionExecution?.subjectId &&
      intent.target.identity.subjectId === intent.source.identity.subjectId &&
      historical.promotionExecution?.threadId === intent.source.threadId &&
      intent.source.identity.scope.kind === "request" &&
      intent.source.identity.scope.scopeId === oldCase.id &&
      intent.source.identity.scope.rootRequestId === oldCase.id &&
      intent.source.identity.invocationKey ===
        invocationKey({ kind: "local", caseId: oldCase.id }) &&
      intent.target.identity.scope.kind === "request" &&
      intent.target.identity.scope.scopeId === target.id &&
      intent.target.identity.scope.rootRequestId === target.id,
    "source-or-target-case",
  );
  requireTransfer(
    !current.budgetSuspension && !current.workBudget?.suspended &&
      !current.workBudget?.exhausted && !(current.workBudget?.reserved ?? 0) &&
      !source.budgetSuspension && !source.workBudget?.suspended &&
      !(source.workBudget?.reserved ?? 0),
    "unsafe-budget",
  );
  requireTransfer(
    model.version.digest === intent.pin.modelDigest &&
      model.version.repositoryVersion === intent.pin.repositoryVersion &&
      request.flow.rootNativeId === intent.pin.flowRootId &&
      request.flow.rootOccurrenceId === intent.pin.flowOccurrenceId &&
      await nativeFlowContractDigest(request.model) === intent.pin.flowDigest &&
      canonical(request.flow) === canonical(model.flows.promotion) &&
      request.maxSteps === intent.pin.maxSteps &&
      request.maxSteps === model.policy.maxFlowSteps,
    "flow-or-profile",
  );
  return intent;
}

export async function verifyInitialAdmissionSourceSnapshot(
  intent: InitialToolAdmissionTransfer,
  snapshot: NativeExecutionSnapshot,
): Promise<void> {
  requireTransfer(
    snapshot.status === "waiting" && snapshot.unsettledEffects.length === 0 &&
      !snapshot.openImmutableConsultationGroups?.length &&
      snapshot.pendingContributions.length === 0 &&
      snapshot.threadId === intent.source.threadId &&
      snapshot.runId === intent.source.runId &&
      snapshot.checkpointNamespace === intent.source.checkpointNamespace &&
      snapshot.checkpointId === intent.source.checkpointId &&
      snapshot.contributionId === intent.source.contributionId &&
      canonical(snapshot.identity) === canonical(intent.source.identity) &&
      snapshot.modelDigest === intent.pin.modelDigest &&
      snapshot.repositoryVersion === intent.pin.repositoryVersion &&
      snapshot.flowRootId === intent.pin.flowRootId &&
      snapshot.waits.length === 1 &&
      snapshot.waits[0].kind === "decision" &&
      snapshot.waits[0].mechanism === "decide_admission" &&
      snapshot.waits[0].nodeId === intent.source.occurrenceId &&
      canonical(snapshot.initialAdmissionSource) === canonical({
          occurrenceId: intent.source.occurrenceId,
          actionId: intent.source.actionId,
          preparedNodeId: intent.source.preparedNodeId,
          settledEffectKey: intent.source.settledEffectKey,
        }) &&
      await executionDigest(snapshot) === intent.source.snapshotDigest,
    "source-checkpoint-or-wait",
  );
}

/** A selected successor can drain known receipts after its own catalog
 * publication. Historical authority is never used to admit a fresh operation;
 * the handler boundary separately checks the current pin and owner again. */
export async function verifySelectedInitialAdmissionTransfer(
  original: NativeExecutionRequest,
  source: SystemRuntimeState,
  acceptedTarget: SystemRuntimeState,
  current: SystemRuntimeState,
): Promise<void> {
  const intent = await verifyInitialAdmissionTransfer(
    original,
    source,
    acceptedTarget,
  );
  const candidate = current.candidates.find((c) => c.id === intent.candidateId);
  const before = acceptedTarget.candidates.find((c) =>
    c.id === intent.candidateId
  )!;
  const target = current.cases?.find((c) => c.id === intent.target.caseId);
  const old = current.cases?.find((c) => c.id === intent.source.caseId);
  const model = current.executionModel;
  requireTransfer(
    candidate && model && target && isOpenCase(target) &&
      target.closedAt === undefined &&
      current.id === intent.runtimeId &&
      canonical(model.identity) === canonical(original.model.identity) &&
      canonical(candidate.initialAdmissionTransfer) === canonical(intent) &&
      canonical(candidate.admissionDecision) === canonical(intent.decision) &&
      canonical(candidate.initialToolSeed) ===
        canonical(before.initialToolSeed) &&
      canonical(candidate.sourceBinding) === canonical(before.sourceBinding) &&
      canonical(candidate.preparationEvidence) ===
        canonical(before.preparationEvidence) &&
      await draftDigest(candidate) === intent.candidateDigest &&
      await valueDigest(candidate.tests) === intent.testsDigest &&
      await initialAdmissionTargetCaseDigest(target) ===
        intent.target.caseDigest &&
      await valueDigest(old) === intent.source.caseDigest &&
      current.caseInvocation?.kind === "local" &&
      current.caseInvocation.caseId === intent.target.caseId &&
      await nativeFlowContractDigest(model) === intent.pin.flowDigest,
    "selected-lineage-or-current-case",
  );
  assertInitialAdmissionCurrentAuthority(intent, model);
  if (
    model.version.digest !== intent.pin.modelDigest ||
    model.version.repositoryVersion !== intent.pin.repositoryVersion
  ) {
    const { nativeCatalogAdvanceEvidence } = await import(
      "../native-execution/model-advance.ts"
    );
    const evidence = await nativeCatalogAdvanceEvidence(
      original.model,
      current,
    );
    requireTransfer(
      evidence?.candidateId === intent.candidateId &&
        evidence.candidateDigest === intent.candidateDigest,
      "selected-publication-pin",
    );
  }
}

/** Comparing current ownership excludes only the historical decision's pin;
 * a catalog publication changes that pin without issuing a new owner grant. */
export function assertInitialAdmissionCurrentAuthority(
  intent: InitialToolAdmissionTransfer,
  model: NativeExecutionRequest["model"],
): void {
  const { baseModelDigest: _currentPin, ...actual } = exerciseOwnerAuthority(
    model,
    "candidate-admission",
  );
  const { baseModelDigest: _decisionPin, ...expected } =
    intent.decision.authorityExercise ?? {};
  requireTransfer(
    canonical(actual) === canonical(expected),
    "current-authority",
  );
}

export function verifyInitialAdmissionClaim(
  intent: NativeExecutionRequest["initialAdmissionTransfer"],
  delivery: OperatorExecutionDelivery,
) {
  const command = parseAcceptedCommand(delivery);
  if (
    !intent || !command ||
    command.command.kind !== "decide-candidate" ||
    command.command.delegated ||
    command.command.input.candidateId !== intent.candidateId ||
    command.command.input.candidateDigest !== intent.candidateDigest ||
    (command.command.input.caseId !== undefined &&
      command.command.input.caseId !== intent.source.caseId) ||
    command.command.input.verdict !== intent.decision.verdict ||
    command.command.input.reason.trim() !== intent.decision.reason ||
    delivery.identity.operatorId !== intent.operatorId ||
    delivery.identity.scope.kind !== "designer" ||
    delivery.modelPin.modelDigest !== intent.pin.modelDigest ||
    delivery.modelPin.repositoryVersion !== intent.pin.repositoryVersion
  ) {
    throw new InitialAdmissionTransferRefused("claim-or-command");
  }

  return intent;
}

export function verifyInitialAdmissionEffect(
  result: NativeExecutionActionResult,
) {
  if (
    !result.suspend || result.suspensionKind !== "decision" ||
    result.modelAdvance
  ) {
    throw new InitialAdmissionTransferRefused("source-effect-result");
  }
}

export async function verifyInitialAdmissionWait(
  intent: InitialToolAdmissionTransfer,
  sourceWait: NativeWaitEvidence,
  sourceEffectResult: NativeExecutionActionResult | undefined,
) {
  if (
    sourceWait.kind !== "decision" ||
    sourceWait.nodeId !== intent.source.occurrenceId ||
    sourceWait.actionId !== intent.source.actionId ||
    sourceWait.effectKey !== intent.source.settledEffectKey ||
    sourceWait.preparedNodeId !== intent.source.preparedNodeId ||
    sourceWait.rootRequestId !== intent.source.caseId ||
    await effectResultDigest(sourceEffectResult) !== sourceWait.resultDigest
  ) throw new InitialAdmissionTransferRefused("source-wait-proof");
}

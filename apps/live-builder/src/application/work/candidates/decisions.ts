import { nativeFlowContractDigest } from "../runtime/model-advance.ts";
import {
  assertInitialAdmissionCurrentAuthority,
  initialAdmissionDecisionKey,
  initialAdmissionTargetCaseDigest,
  InitialAdmissionTransferRefused,
  verifyInitialAdmissionSourceSnapshot,
} from "../runtime/initial-admission-transfer.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { nativeExecutionIdentity } from "../runtime/execution.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import type {
  InitialToolAdmissionTransfer,
  ReviewDecision,
} from "../../../domain/work/candidates.ts";
import type {
  NativeExecutionContribution,
  NativeExecutionPort,
  NativeExecutionSnapshot,
} from "../runtime/execution.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import type { MessageObservation } from "../../../domain/work/policies/context-separation.ts";
import type {
  ArtifactReuseOrigin,
  Candidate,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import {
  candidateCaseInvocation,
  invocationInput,
  invocationKey,
  isInitializationAdmission,
  type OperatorWorkCompletion,
  type OperatorWorkContinuationStart,
  type OperatorWorkMessage,
  type OperatorWorkMessageRange,
  type SettledOperatorWork,
  waitingOperatorWork,
  workReceipt,
} from "../operators/journal.ts";
import { type OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";
import {
  closeCaseById,
  openInitializationCase,
  selectCaseInvocation,
  selectDesignerInvocation,
} from "../cases/runtime.ts";
import type { ClockPort } from "../runtime/ports.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import {
  draftDigest,
  errorText,
  makeEvent,
  valueDigest,
} from "../runtime/values.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import {
  mainExecutionSpace,
  OperatorAuthorityError,
} from "../../../domain/governance/operator-authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  type CandidateDelegatedActor,
  delegatedCandidateAuthorityExercise,
} from "../../../domain/governance/policies/tool-admission-policy.ts";

export interface CandidateDecisionInput {
  candidateId: string;
  candidateDigest: string;
  caseId?: string;
  verdict: "approve" | "refuse";
  reason: string;
}

/** A host-bound Main read of exactly one candidate; returned content is data. */
export async function inspectCandidate(
  this: CandidateDecisionsHost,
  input: { candidateId: string; candidateDigest: string; caseId: string },
  delegated: CandidateDelegatedActor,
) {
  const model = await this.currentModel();
  const candidate = this.candidate(input.candidateId);
  if (candidate.admissionDecision !== undefined) {
    throw new OperatorAuthorityError(
      "AUTHORITY_REQUEST_STALE",
      "An admission decision is already recorded; resume its exact continuation",
      { candidateId: candidate.id, caseId: candidate.caseId ?? "" },
    );
  }
  if (
    candidate.caseId !== input.caseId ||
    !candidateCaseInvocation(this.state, candidate) ||
    candidate.stage !== "awaiting-admission" ||
    candidate.requiredAuthority !== "human" ||
    candidate.digest !== input.candidateDigest ||
    await draftDigest(candidate) !== candidate.digest ||
    candidate.baseCatalogRevision !== this.state.catalogRevision
  ) {
    throw new Error(
      "The inspection requires an exact tested candidate in its open Request.",
    );
  }
  const authorityExercise = delegatedCandidateAuthorityExercise(
    model,
    candidate,
    delegated,
    mainExecutionSpace(model.identity),
  );
  const contract = model.contracts.find((entry) =>
    entry.kind === candidate.kind
  )!;
  return structuredClone({
    operatorId: model.identity.builderId,
    candidate: {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      kind: candidate.kind,
      code: candidate.code,
      digest: candidate.digest,
      caseId: candidate.caseId,
      stage: candidate.stage,
      baseCatalogRevision: candidate.baseCatalogRevision,
      requiredAuthority: candidate.requiredAuthority,
      tests: candidate.tests,
    },
    contract,
    authorityExercise,
  });
}

export interface CandidateDecisionsHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    clock: ClockPort;
    caseNumbers: CaseNumberPort;
    execution?: NativeExecutionPort;
  };
  control(
    action: () => Promise<void>,
    onSettled?: () => Promise<SettledOperatorWork | undefined>,
    preserve?: boolean,
    settleCommit?: (state: SystemRuntimeState) => void,
  ): Promise<void>;
  currentModel(): Promise<ExecutableModel>;
  candidate(id: string): Candidate;
  continuationFingerprint(): Promise<string | undefined>;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  action<T>(
    node: CompiledFlowNode,
    effect: (model: ExecutableModel) => Promise<T>,
  ): Promise<T>;
  build(
    draft?: ToolDraft,
    resumeId?: string,
    origin?: ArtifactReuseOrigin,
    initialToolSeed?: Candidate["initialToolSeed"],
  ): Promise<void>;
  prepareSelectedTools(): Promise<void>;
  feedback(text: string, observation?: MessageObservation): Promise<void>;
  runTurn(
    onReply?: (reply: Extract<ChatDecision, { kind: "reply" }>) => void,
    contribution?: NativeExecutionContribution,
  ): Promise<void>;
  workCompletion(
    work: OperatorWorkReceipt,
    bounds: {
      messageRanges: OperatorWorkMessageRange[];
      candidateIds: string[];
    },
  ): Promise<OperatorWorkCompletion>;
}

/** The work a decision resumed, with its completion: the settled control
 * journals it, then wakes the caller unless the work still waits. */
async function settledWork(
  host: CandidateDecisionsHost,
  receipt: OperatorWorkReceipt,
  bounds: Parameters<CandidateDecisionsHost["workCompletion"]>[1],
): Promise<SettledOperatorWork> {
  return { receipt, completion: await host.workCompletion(receipt, bounds) };
}

/** A business stage cannot prove that its native decision contribution drained.
 * inspect returns selected executions; match the complete B identity and exact
 * contribution, never the historical promotion subject or candidate stage. */
async function completedInitialAdmission(
  host: CandidateDecisionsHost,
  intent: InitialToolAdmissionTransfer,
): Promise<NativeExecutionSnapshot | undefined> {
  const selected =
    (await host.ports.execution?.inspect(intent.operatorId) ?? [])
      .filter((snapshot) =>
        canonical(snapshot.identity) === canonical(intent.target.identity)
      );
  if (selected.length !== 1) return undefined;
  const snapshot = selected[0];
  return snapshot.status === "completed" &&
      snapshot.contributionId === intent.contribution.id &&
      snapshot.threadId !== intent.source.threadId &&
      !!snapshot.runId && !!snapshot.checkpointNamespace &&
      !!snapshot.checkpointId &&
      snapshot.flowRootId === intent.pin.flowRootId &&
      snapshot.waits.length === 0 && snapshot.unsettledEffects.length === 0 &&
      !snapshot.openImmutableConsultationGroups?.length &&
      snapshot.pendingContributions.length === 0 &&
      snapshot.localState?.promotionId === intent.candidateId
    ? snapshot
    : undefined;
}

/** A chat assertion such as “approved” never reaches this command. */
export async function decideCandidate(
  this: CandidateDecisionsHost,
  input: CandidateDecisionInput,
  delegated?: CandidateDelegatedActor,
): Promise<void> {
  if (
    !["approve", "refuse"].includes(input.verdict) || !input.reason?.trim() ||
    input.reason.length > 2000
  ) {
    throw new Error(
      "L’admission exige une décision et une justification courte.",
    );
  }
  // Reject ownership errors before entering control: a decision must not emit
  // failures or consume a continuation under whichever Case is selected now.
  const target = this.candidate(input.candidateId);
  const frozenTransfer = target.initialAdmissionTransfer;
  if (frozenTransfer) {
    if (
      target.digest !== input.candidateDigest ||
      frozenTransfer.decision.verdict !== input.verdict ||
      frozenTransfer.decision.reason !== input.reason.trim() ||
      canonical(target.admissionDecision) !== canonical(frozenTransfer.decision)
    ) {
      throw new InitialAdmissionTransferRefused("conflicting-decision");
    }
    // A known completed result is a receipt, not another authority exercise.
    if (target.stage === "active" || target.stage === "refused") {
      const selected =
        (await this.ports.execution?.inspect(frozenTransfer.operatorId) ?? [])
          .find((snapshot) =>
            canonical(snapshot.identity) ===
              canonical(frozenTransfer.target.identity)
          );
      if (selected?.unsettledEffects.length) {
        throw new InitialAdmissionTransferRefused(
          "terminal-has-unsettled-effects",
        );
      }
      if (await completedInitialAdmission(this, frozenTransfer)) {
        const record = this.state.cases?.find((value) =>
          value.id === frozenTransfer.target.caseId
        );
        if (record && isOpenCase(record)) {
          await this.update((state) => {
            closeCaseById(state, record.id, "done", this.ports.clock);
            if (!state.caseInvocation) selectDesignerInvocation(state);
          });
        }
        return;
      }
    }
  }

  if (delegated) {
    await inspectCandidate.call(this, {
      candidateId: input.candidateId,
      candidateDigest: input.candidateDigest,
      caseId: input.caseId ?? "",
    }, delegated);
  }
  if (
    !candidateCaseInvocation(this.state, target) &&
    !isInitializationAdmission(this.state, target)
  ) {
    throw new CaseError(
      "CASE_CLOSED",
      "The candidate's Case is no longer active",
      {
        conversationId: this.state.id,
        candidateId: target.id,
        caseId: target.caseId!,
      },
      "Open a new Case and propose a new candidate; a closed Case cannot be resumed.",
    );
  }
  let continuation:
    | {
      receipt: OperatorWorkReceipt;
      completion: OperatorWorkCompletion;
      messageStart: number;
      priorCandidateIds: string[];
    }
    | undefined;
  let initialization:
    | {
      id: string;
      previous: Pick<
        SystemRuntimeState,
        | "caseInvocation"
        | "workBudgetBinding"
        | "workBudget"
        | "caseBudgetPending"
        | "budgetSuspension"
        | "budgetPromotionCandidateId"
        | "conversationCursor"
        | "conversationContext"
        | "conversationFlow"
      >;
    }
    | undefined;
  let conversationReturned = false;
  await this.control(async () => {
    await this.currentModel();
    const candidate = this.candidate(input.candidateId);
    const initialAdmission = isInitializationAdmission(this.state, candidate);
    const invocation = candidateCaseInvocation(this.state, candidate);
    const priorInvocationKey = this.state.caseInvocation &&
      invocationKey(this.state.caseInvocation);
    if (
      !invocation && !initialAdmission
    ) {
      throw new CaseError(
        "CASE_CLOSED",
        "The candidate's Case is no longer active",
      );
    }
    if (
      candidate.stage !== "awaiting-admission" &&
        !(candidate.initialAdmissionTransfer &&
          (candidate.stage === "active" || candidate.stage === "refused" ||
            hasActivationIntent(candidate))) ||
      candidate.requiredAuthority !== "human"
    ) {
      throw new Error("Ce candidat n’attend pas de décision humaine.");
    }
    if (
      candidate.digest !== input.candidateDigest ||
      await draftDigest(candidate) !== input.candidateDigest
    ) {
      throw new Error("La décision ne correspond pas au candidat exact.");
    }
    const native = await this.currentModel();
    const authorityExercise = delegated
      ? (await inspectCandidate.call(this, {
        candidateId: input.candidateId,
        candidateDigest: input.candidateDigest,
        caseId: input.caseId ?? "",
      }, delegated)).authorityExercise
      : exerciseOwnerAuthority(native, "candidate-admission");
    if (
      !candidate.initialAdmissionTransfer &&
      candidate.promotionModelDigest !== native.version.digest
    ) {
      throw new Error(
        "La continuation de promotion ne correspond plus à la version du modèle admise.",
      );
    }
    const executions =
      await this.ports.execution?.inspect(native.identity.builderId) ?? [];
    const promotion = executions.find((execution) =>
      execution.threadId === candidate.promotionExecution?.threadId &&
      execution.identity.purpose === "promotion" &&
      execution.identity.subjectId ===
        candidate.promotionExecution?.subjectId &&
      execution.status === "waiting" && !execution.unsettledEffects.length &&
      execution.modelDigest === native.version.digest
    );
    const admissionNode = native.flows.promotion.nodes.find((node) =>
      (candidate.initialAdmissionTransfer
        ? candidate.initialAdmissionTransfer.source.occurrenceId === node.id
        : promotion?.waits.some((wait) =>
          wait.nodeId === node.id && wait.kind === "decision"
        )) &&
      node.mechanism === "decide_admission"
    );
    if (!admissionNode) {
      throw new Error(
        "La décision humaine ne possède pas de continuation d’admission native.",
      );
    }
    if (initialAdmission) {
      const previous = structuredClone({
        caseInvocation: this.state.caseInvocation,
        workBudgetBinding: this.state.workBudgetBinding,
        workBudget: this.state.workBudget,
        caseBudgetPending: this.state.caseBudgetPending,
        budgetSuspension: this.state.budgetSuspension,
        budgetPromotionCandidateId: this.state.budgetPromotionCandidateId,
        conversationCursor: this.state.conversationCursor,
        conversationContext: this.state.conversationContext,
        conversationFlow: this.state.conversationFlow,
      });
      if (candidate.initialAdmissionTransfer) {
        const intent = candidate.initialAdmissionTransfer;
        const record = this.state.cases?.find((value) =>
          value.id === intent.target.caseId
        );
        assertInitialAdmissionCurrentAuthority(intent, native);
        if (!record || !isOpenCase(record)) {
          throw new InitialAdmissionTransferRefused(
            "closed-target-or-current-authority",
          );
        }
        await this.update((state) =>
          selectCaseInvocation(state, { kind: "local", caseId: record.id })
        );
        initialization = { id: record.id, previous };
      } else {
        if (
          !promotion?.initialAdmissionSource || !promotion.runId ||
          !promotion.checkpointNamespace || !promotion.checkpointId ||
          promotion.identity.scope.kind !== "request" ||
          !candidate.initialToolSeed || !candidate.sourceBinding ||
          !candidate.preparationEvidence || candidate.tests?.passed !== true ||
          !native.version.repositoryVersion
        ) {
          throw new InitialAdmissionTransferRefused(
            "missing-exact-preparation",
          );
        }
        const oldCase = this.state.cases?.find((record) =>
          record.id === candidate.caseId
        );
        if (!oldCase || oldCase.status !== "closed-done") {
          throw new InitialAdmissionTransferRefused("source-not-completed");
        }
        const decision: ReviewDecision = {
          candidateDigest: input.candidateDigest,
          verdict: input.verdict,
          reason: input.reason.trim(),
          authorityExercise,
        };
        const decisionDigest = await valueDigest(decision);
        const key = await initialAdmissionDecisionKey(this.state, candidate);
        const sourceRevision = this.state.revision;
        const number = await this.ports.caseNumbers.allocate();
        // Prepare the target off-state so its complete identity, Case and
        // decision are committed together by the following canonical CAS.
        const prepared = structuredClone(this.state);
        const id = openInitializationCase(prepared, this.ports.clock, number);
        const targetCase = prepared.cases!.find((record) => record.id === id)!;
        const targetIdentity = nativeExecutionIdentity(
          prepared,
          "promotion",
          promotion.identity.subjectId,
        );
        const intent: InitialToolAdmissionTransfer = {
          kind: "initial-tool-admission-transfer",
          key,
          runtimeId: this.state.id,
          projectId: native.identity.projectId,
          systemId: native.identity.systemId,
          operatorId: native.identity.builderId,
          candidateId: candidate.id,
          candidateDigest: candidate.digest,
          seed: structuredClone(candidate.initialToolSeed),
          sourceBinding: structuredClone(candidate.sourceBinding),
          preparationEvidence: structuredClone(candidate.preparationEvidence),
          testsDigest: await valueDigest(candidate.tests),
          decision,
          decisionDigest,
          contribution: {
            id: `candidate-decision:${candidate.id}:${decisionDigest}`,
            kind: "resume",
          },
          sourceRevision,
          source: {
            ...structuredClone(promotion.initialAdmissionSource),
            identity: structuredClone(
              promotion.identity,
            ) as InitialToolAdmissionTransfer["source"]["identity"],
            threadId: promotion.threadId,
            runId: promotion.runId,
            checkpointNamespace: promotion.checkpointNamespace,
            checkpointId: promotion.checkpointId,
            contributionId: promotion.contributionId,
            snapshotDigest: await executionDigest(promotion),
            caseId: oldCase.id,
            caseDigest: await valueDigest(oldCase),
          },
          target: {
            identity: targetIdentity as InitialToolAdmissionTransfer["target"][
              "identity"
            ],
            caseId: id,
            caseDigest: await initialAdmissionTargetCaseDigest(targetCase),
          },
          pin: {
            modelDigest: native.version.digest,
            repositoryVersion: native.version.repositoryVersion,
            flowRootId: native.flows.promotion.rootNativeId,
            flowOccurrenceId: native.flows.promotion.rootOccurrenceId,
            flowDigest: await nativeFlowContractDigest(native),
            maxSteps: native.policy.maxFlowSteps,
          },
        };
        await verifyInitialAdmissionSourceSnapshot(intent, promotion);
        await this.update((state) => {
          state.cases!.push(structuredClone(targetCase));
          selectCaseInvocation(state, { kind: "local", caseId: id });
          if (prepared.caseBudgetPending) state.caseBudgetPending = true;
          const c = state.candidates.find((value) =>
            value.id === candidate.id
          )!;
          if (c.initialAdmissionTransfer || c.admissionDecision) {
            throw new InitialAdmissionTransferRefused("conflicting-intent");
          }
          c.admissionDecision = structuredClone(decision);
          c.initialAdmissionTransfer = structuredClone(intent);
        });
        initialization = { id, previous };
      }
    } else if (invocation) {
      await this.update((state) => selectCaseInvocation(state, invocation));
    }
    const waiting = waitingOperatorWork(this.state, candidate.id);
    if (
      waiting && waiting.completion.work.continuation ===
        await this.continuationFingerprint()
    ) {
      const start: OperatorWorkContinuationStart = {
        ...makeEvent(
          "operator-work-continuation-started",
          delegated
            ? "Continuation du travail après décision déléguée"
            : "Continuation du travail après décision humaine",
        ),
        work: {
          ...(waiting.receipt.caseId ? { caseId: waiting.receipt.caseId } : {}),
          callerId: waiting.receipt.callerId,
          correlationId: waiting.receipt.correlationId,
          fingerprint: waiting.receipt.fingerprint,
        },
      };
      const bounds = {
        ...waiting,
        messageStart: this.state.messages.length,
        priorCandidateIds: this.state.candidates.map((value) => value.id),
      };
      await this.update((s) => s.events.push(start));
      continuation = bounds;
    }
    const fingerprint = delegated
      ? await this.continuationFingerprint()
      : undefined;
    const inputMessage = invocationInput(this.state);
    await this.action(admissionNode, async () =>
      await this.update((s) => {
        const c = s.candidates.find((c) => c.id === candidate.id)!;
        c.admissionDecision = c.initialAdmissionTransfer?.decision ?? {
          candidateDigest: input.candidateDigest,
          verdict: input.verdict,
          reason: input.reason.trim(),
          authorityExercise,
        };
        if (fingerprint && inputMessage) {
          c.admissionContinuation = {
            modelDigest: native.version.digest,
            fingerprint,
            inputMessageId: inputMessage.id,
            messageStart: continuation?.messageStart ?? s.messages.length,
            priorCandidateIds: s.candidates.map((value) => value.id),
            ...(continuation
              ? {
                work: {
                  receipt: structuredClone(continuation.receipt),
                  messageRanges: structuredClone(
                    continuation.completion.work.messageRanges ?? [{
                      start: s.messages.findIndex((message) =>
                        workReceipt(message)?.fingerprint ===
                          continuation!.receipt.fingerprint
                      ),
                      end: continuation.completion.work.messageCount,
                    }],
                  ),
                  candidateIds: [...continuation.completion.work.candidateIds],
                },
              }
              : {}),
          };
        }
        if (
          !c.initialAdmissionTransfer ||
          !s.events.some((event) =>
            event.kind === "human-admission-decided" &&
            event.candidateId === c.id
          )
        ) {
          s.events.push(
            {
              ...makeEvent(
                delegated
                  ? "delegated-admission-decided"
                  : "human-admission-decided",
                `${input.verdict} : ${input.reason.trim()}`,
                c,
              ),
              authorityExercise,
            },
          );
        }
      }));
    await this.build(undefined, candidate.id);
    if (this.state.executionModel?.initialTools?.length) {
      try {
        await this.prepareSelectedTools();
      } catch (error) {
        const detail = errorText(error);
        await this.update((s) => {
          s.events.push(makeEvent(
            "initial-tools-preparation-failed",
            `Suite du catalogue initial interrompue : ${detail}`,
          ));
        });
        // The primary admission already settled. A failure preparing another
        // selection must not report that its confirmed effect was rejected.
        await this.feedback(
          `La décision sur ${candidate.name} est enregistrée. La préparation de la sélection initiale suivante est interrompue : ${detail}`,
          {
            kind: "tool-failure",
            value: {
              code: "INITIAL_TOOLS_PREPARATION_FAILED",
              details: detail,
            },
          },
        );
      }
    }
    // Selecting a parked local conversation solely to admit its candidate is
    // not new conversational input. Keep a terminal await_input parked unless
    // an exact correlated work receipt proves an unfinished contribution.
    const nativeConversation =
      (await this.ports.execution?.inspect(native.identity.builderId) ?? [])
        .find((execution) =>
          execution.identity.purpose === "conversation" &&
          this.state.caseInvocation &&
          execution.identity.invocationKey ===
            invocationKey(this.state.caseInvocation) &&
          execution.identity.subjectId === this.state.activeInputMessageId
        );
    const selectedLocalWait = invocation?.kind === "local" &&
      priorInvocationKey !== invocationKey(invocation) && !continuation &&
      !delegated &&
      nativeConversation?.waits.every((wait) => wait.kind === "input");
    if (nativeConversation?.status === "waiting" && !selectedLocalWait) {
      await this.runTurn(undefined, {
        id: `candidate-decision:${candidate.id}:${await valueDigest(
          this.candidate(candidate.id).admissionDecision,
        )}`,
        kind: "resume",
      });
    }
    conversationReturned = true;
  }, async () => {
    if (initialization) {
      const current = this.candidate(input.candidateId);
      const recoverable = current.initialAdmissionTransfer &&
        !await completedInitialAdmission(
          this,
          current.initialAdmissionTransfer,
        );
      const { id, previous } = initialization;
      if (recoverable) {
        // Even an active/refused candidate can precede the final graph checkpoint
        // or run receipt. Keep B open until its exact selected contribution drains.
        // Restore the prior UI scope without closing that durable target.
        if (previous.caseInvocation) {
          await this.update((state) => Object.assign(state, previous));
        }
        return;
      }
      const failed = current.initialAdmissionTransfer
        ? current.stage === "failed"
        : !!this.state.error || !!this.state.budgetSuspension ||
          current.stage === "failed";
      await this.update((state) => {
        closeCaseById(
          state,
          id,
          failed ? "abandoned" : "done",
          this.ports.clock,
        );
        const prior = previous.caseInvocation;
        if (
          prior?.kind === "local" &&
          !state.cases?.some((record) =>
            record.id === prior.caseId && isOpenCase(record)
          )
        ) {
          // A crash can leave B selected before recovery begins. Its saved
          // invocation and budget cannot be restored once B has just closed.
          selectDesignerInvocation(state);
        } else if (prior) {
          Object.assign(state, previous);
        }
      });
    }
    if (!continuation) return;
    const { receipt, completion, messageStart, priorCandidateIds } =
      continuation;
    const inputIndex = this.state.messages.findIndex((message) =>
      (message as Partial<OperatorWorkMessage>).work?.fingerprint ===
        receipt.fingerprint
    );
    return await settledWork(this, receipt, {
      messageRanges: [
        ...(completion.work.messageRanges ?? [{
          start: inputIndex,
          end: completion.work.messageCount,
        }]),
        { start: messageStart, end: this.state.messages.length },
      ],
      candidateIds: [
        ...new Set([
          ...completion.work.candidateIds,
          ...this.state.candidates.filter((value) =>
            !priorCandidateIds.includes(value.id)
          ).map((value) => value.id),
        ]),
      ],
    });
  }).catch(async (error) => {
    // A failed native conversation keeps the ordinary failed-work contract.
    // Once it returned, a failed receipt write must retain exact recovery.
    const candidate = this.candidate(input.candidateId);
    if (
      candidate.admissionContinuation && !hasActivationIntent(candidate) &&
      !conversationReturned
    ) {
      await this.update((s) => {
        delete s.candidates.find((value) => value.id === candidate.id)!
          .admissionContinuation;
      });
    }
    throw error;
  });
  if (this.candidate(input.candidateId).admissionContinuation) {
    await this.update((s) => {
      delete s.candidates.find((value) => value.id === input.candidateId)!
        .admissionContinuation;
    });
  }
}

/** Finish only the native continuation recorded with a delegated decision.
 * Publication recovery is independent; a changed pin, Case, input or budget
 * never turns that recovery into a new authority exercise or provider replay. */
export async function resumeCandidateDecisions(
  this: CandidateDecisionsHost,
  candidateId?: string,
  verifiedCatalogAdvance = false,
  nativeRetryPin?: { modelDigest: string; repositoryVersion?: string },
  acceptedDigest?: string,
): Promise<void> {
  for (const target of this.state.candidates) {
    if (candidateId && target.id !== candidateId) continue;
    const continuation = target.admissionContinuation;
    if (!continuation || hasActivationIntent(target)) continue;
    const ownsContribution = () => {
      const current = this.candidate(target.id);
      const input = invocationInput(this.state);
      const invocation = candidateCaseInvocation(this.state, current);
      return invocation && input?.id === continuation.inputMessageId &&
        canonical(current.admissionContinuation) === canonical(continuation) &&
        canonical(invocation) === canonical(this.state.caseInvocation);
    };
    const blocked = () =>
      this.state.budgetSuspension || this.state.workBudget?.exhausted ||
      this.state.workBudget?.suspended || this.state.caseBudgetPending ||
      (this.state.workBudget?.reserved ?? 0) > 0 ||
      this.state.availableExecutionModel ||
      !verifiedCatalogAdvance &&
        this.state.executionModel?.version.digest !== continuation.modelDigest;
    const nativeTerminal = async () => {
      const execution = (await this.ports.execution?.inspect(
        this.state.executionModel!.identity.builderId,
      ) ?? []).find((value) =>
        value.identity.purpose === "conversation" &&
        this.state.caseInvocation &&
        value.identity.invocationKey ===
          invocationKey(this.state.caseInvocation) &&
        value.identity.subjectId === this.state.activeInputMessageId
      );
      return !execution || execution.status === "completed" ||
        execution.status === "waiting" &&
          execution.waits.every((wait) => wait.kind === "input") &&
          !execution.unsettledEffects.length;
    };
    if (!ownsContribution()) {
      // A different selected Request does not supersede persisted work. The host
      // will select and refresh that exact invocation before it can resume.
      const invocation = candidateCaseInvocation(
        this.state,
        this.candidate(target.id),
      );
      if (
        invocation && (!this.state.caseInvocation ||
          invocationKey(invocation) !==
            invocationKey(this.state.caseInvocation)) &&
        this.state.invocationContinuations?.[
          invocationKey(invocation)
        ]
      ) continue;
      if (candidateId) {
        throw new Error("The exact candidate contribution changed");
      }
      await this.update((s) => {
        delete s.candidates.find((value) => value.id === target.id)!
          .admissionContinuation;
      });
      continue;
    }
    if (blocked()) continue;
    const awaitingPromotion = target.stage === "awaiting-admission" &&
      !target.admission &&
      target.admissionDecision?.authorityExercise?.candidateDelegation;
    const settledPromotion = target.stage === "active" &&
        target.admission?.authority === "delegate" ||
      target.stage === "refused" &&
        target.admissionDecision?.verdict === "refuse" ||
      target.stage === "failed" && target.admission?.authority === "delegate";
    const decisionContributionId =
      `candidate-decision:${target.id}:${await valueDigest(
        target.admissionDecision,
      )}`;
    const decisionState = async (): Promise<"new" | "known" | "owned"> => {
      if (!candidateId) return "new";
      if (
        !this.ports.execution || !this.state.caseInvocation ||
        !nativeRetryPin || !acceptedDigest
      ) {
        throw new Error("The exact native candidate receipt is unavailable");
      }
      const identity = nativeExecutionIdentity(
        this.state,
        "conversation",
        continuation.inputMessageId,
      );
      const matches = (await this.ports.execution.inspect(identity.operatorId))
        .filter((snapshot) =>
          canonical(snapshot.identity) === canonical(identity)
        );
      if (matches.length !== 1) {
        throw new Error(
          "The exact native candidate receipt is ambiguous or missing",
        );
      }
      const snapshot = matches[0];
      if (snapshot.contributionId !== decisionContributionId) return "new";
      const expectedPin = verifiedCatalogAdvance
        ? this.state.executionModel!.version
        : {
          digest: nativeRetryPin.modelDigest,
          repositoryVersion: nativeRetryPin.repositoryVersion,
        };
      if (
        (!verifiedCatalogAdvance &&
          snapshot.modelDigest !== continuation.modelDigest) ||
        snapshot.modelDigest !== expectedPin.digest ||
        snapshot.repositoryVersion !== expectedPin.repositoryVersion ||
        !snapshot.checkpointId ||
        snapshot.unsettledEffects.length ||
        snapshot.openImmutableConsultationGroups?.length
      ) {
        throw new Error(
          "The native candidate contribution requires explicit reconciliation",
        );
      }
      if (
        (snapshot.status === "completed" ||
          snapshot.status === "waiting" && snapshot.waits.length > 0 &&
            snapshot.waits.every((wait) => wait.kind === "input")) &&
        settledPromotion
      ) return "known";
      if (
        await this.ports.execution.ownsCandidateRecoveryContribution?.({
          snapshot,
          acceptedDigest,
        })
      ) return "owned";
      throw new Error(
        "The native candidate contribution belongs to another delivery or lacks exact ownership proof",
      );
    };
    const beforeControl = await decisionState();
    const exactBeforeControl = await this.continuationFingerprint() ===
      continuation.fingerprint;
    if (
      !awaitingPromotion && !settledPromotion ||
      beforeControl === "new" && !exactBeforeControl &&
        (awaitingPromotion || !(await nativeTerminal()))
    ) {
      if (candidateId) throw new Error("The exact native continuation changed");
      await this.update((s) => {
        delete s.candidates.find((value) => value.id === target.id)!
          .admissionContinuation;
      });
      continue;
    }
    // Reading current source can discover a revocation while the effect already
    // exists. Keep the pending continuation until ordinary pin handling allows it.
    try {
      await this.currentModel();
    } catch (error) {
      if (!this.state.availableExecutionModel) {
        const detail = errorText(error);
        await this.update((s) => {
          s.error = detail;
          s.events.push(
            makeEvent("candidate-continuation-interrupted", detail, target),
          );
        });
      }
      continue;
    }
    let complete = false;
    let discard = false;
    let conversationReturned = false;
    let durablySettled = false;
    const resumedMessageStart = this.state.messages.length;
    const selectedKey = this.state.caseInvocation &&
      invocationKey(this.state.caseInvocation);
    const priorMessageEnd = selectedKey &&
      this.state.invocationContinuations?.[selectedKey]?.messageCount;
    try {
      await this.control(
        async () => {
          // The control reservation closes the awaits above against another input.
          // Never select an old invocation: that would reset a different Case's
          // cursor, context and budget before discovering the mismatch.
          if (!ownsContribution()) {
            discard = true;
            return;
          }
          if (blocked()) return;
          await this.currentModel();
          if (!ownsContribution()) {
            discard = true;
            return;
          }
          if (blocked()) return;
          const exact = await this.continuationFingerprint() ===
            continuation.fingerprint;
          if (
            await decisionState() === "new" && !exact &&
            (awaitingPromotion || !(await nativeTerminal()))
          ) {
            discard = true;
            return;
          }
          complete = true;
          const ownership = await decisionState();
          if (awaitingPromotion && ownership !== "known") {
            await this.build(undefined, target.id);
          }
          if (ownership === "owned" || exact && ownership === "new") {
            await this.runTurn(undefined, {
              id: decisionContributionId,
              kind: "resume",
            });
          }
          conversationReturned = true;
        },
        async () => {
          if (!complete || candidateId && !conversationReturned) {
            return;
          }
          const work = continuation.work;
          if (!work) return;
          const journal = candidateId
            ? this.state.candidateRecoverySelection
            : undefined;
          if (
            candidateId &&
            (!journal || journal.candidateId !== candidateId ||
              journal.phase !== "entered" ||
              !Number.isSafeInteger(journal.baseMessageEnd) ||
              !Number.isSafeInteger(journal.segmentStart) ||
              journal.baseMessageEnd < continuation.messageStart ||
              journal.baseMessageEnd > journal.segmentStart ||
              journal.segmentStart > this.state.messages.length ||
              journal.messageRanges.some((range, index) =>
                !Number.isSafeInteger(range.start) ||
                !Number.isSafeInteger(range.end) ||
                range.start <
                  (index
                    ? journal.messageRanges[index - 1].end
                    : journal.baseMessageEnd) ||
                range.end < range.start || range.end > journal.segmentStart
              ))
          ) {
            throw new Error(
              "The candidate recovery message boundaries changed",
            );
          }
          return await settledWork(this, work.receipt, {
            messageRanges: journal
              ? [
                ...work.messageRanges,
                {
                  start: continuation.messageStart,
                  end: journal.baseMessageEnd,
                },
                ...structuredClone(journal.messageRanges),
                {
                  start: journal.segmentStart,
                  end: this.state.messages.length,
                },
              ]
              : [
                ...work.messageRanges,
                {
                  start: continuation.messageStart,
                  end: typeof priorMessageEnd === "number" &&
                      priorMessageEnd >= continuation.messageStart
                    ? priorMessageEnd
                    : resumedMessageStart,
                },
                { start: resumedMessageStart, end: this.state.messages.length },
              ],
            candidateIds: [
              ...new Set([
                ...work.candidateIds,
                ...this.state.candidates.filter((value) =>
                  !continuation.priorCandidateIds.includes(value.id)
                ).map((value) => value.id),
              ]),
            ],
          });
        },
        undefined,
        candidateId
          ? (s) => {
            if (
              !complete || !conversationReturned || discard ||
              hasActivationIntent(
                s.candidates.find((value) => value.id === target.id)!,
              )
            ) return;
            const journal = s.candidateRecoverySelection;
            if (
              !journal || journal.phase !== "entered" ||
              journal.candidateId !== candidateId
            ) {
              throw new Error(
                "The candidate recovery completion fence changed",
              );
            }
            const current = s.candidates.find((value) =>
              value.id === candidateId
            );
            if (
              !current?.admissionContinuation ||
              canonical(current.admissionContinuation) !==
                canonical(continuation)
            ) {
              throw new Error(
                "The candidate recovery continuation changed before completion",
              );
            }
            delete current.admissionContinuation;
            journal.phase = "control-settled";
          }
          : undefined,
      );
      // The exact recovery completion and consumption share control's final CAS.
      durablySettled = true;
    } finally {
      if (
        !candidateId && (discard ||
          complete && !hasActivationIntent(this.candidate(target.id)) &&
            (durablySettled || !conversationReturned))
      ) {
        await this.update((s) => {
          delete s.candidates.find((value) => value.id === target.id)!
            .admissionContinuation;
        });
      }
    }
  }
}

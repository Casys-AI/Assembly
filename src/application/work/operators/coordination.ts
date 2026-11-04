import { CONTRIBUTION_OBSERVATION_MESSAGE_PREFIX } from "./host-observations.ts";
import {
  assertBudgetResumeAdmission,
  bindBudgetResume,
} from "../runtime/budget-transition.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { authorityNoticeInput } from "../conversation/notice-turn.ts";
import type {
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "./execution.ts";
import {
  type NativeExecutionContribution,
  nativeExecutionIdentity,
  type NativeExecutionPort,
  type NativeExecutionSnapshot,
  parseRequestNetworkContinuation,
  parseRequestNetworkRefusalContinuation,
  parseRequestTeamContinuation,
  parseRequestTeamRefusalContinuation,
  runtimeRevisionReference,
} from "../native-execution/contract.ts";
import {
  evolutionHumanSettlement,
  type EvolutionInputSettlement,
} from "../runtime/evolution.ts";
import {
  humanRequestCase,
  selectCaseInvocation,
  selectDesignerInvocation,
  selectHumanRequestCase,
} from "../cases/runtime.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../domain/work/records/conversations.ts";
import { validDesignerContext } from "../../../domain/work/execution/case-context.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  ArtifactEvidence,
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type {
  ArtifactReuseOrigin,
  Candidate,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { ClockPort, ModelPort } from "../runtime/ports.ts";
import type { OperatorWorkContribution } from "./conversations.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { unresumedTeamCreation } from "../../../domain/governance/records/request-change.ts";
import {
  changeWorkReceipt,
  invocationInput,
  invocationKey,
  type OperatorWorkCompletion,
  operatorWorkFingerprint,
  type OperatorWorkMessageRange,
  recordedOperatorWork,
  workReceipt,
} from "./journal.ts";
import { type OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";
import { errorText, makeEvent, valueDigest } from "../runtime/values.ts";
import { recordRequestNetworkOutcome } from "./request-network-outcome.ts";

export interface OperatorWorkHost {
  readonly state: SystemRuntimeState;
  pending: Promise<void> | null;
  readonly ports: {
    model: Pick<ModelPort, "readExecutableModel">;
    clock: ClockPort;
    caseNumbers: CaseNumberPort;
    execution?: NativeExecutionPort;
    dispatch?: OperatorExecutionDispatchPort;
  };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  build(
    draft?: ToolDraft,
    resumeId?: string,
    origin?: ArtifactReuseOrigin,
    initialToolSeed?: Candidate["initialToolSeed"],
  ): Promise<void>;
  runTurn(
    onReply?: (reply: Extract<ChatDecision, { kind: "reply" }>) => void,
    contribution?: NativeExecutionContribution,
  ): Promise<void>;
  notifyWorkCompletion?(
    work: OperatorWorkReceipt,
    completion: OperatorWorkCompletion,
  ): Promise<void>;
  /** Retry admitted activations interrupted by a transient failure. */
  resumeActivations(): Promise<void>;
  enqueueContribution(
    text: string,
    work?: OperatorWorkReceipt,
    origin?: "human" | "delegation",
    caseId?: string,
    newConversation?: true,
  ): Promise<string | undefined>;
  assertWorkAdmission?(
    work?: OperatorWorkReceipt,
    settlement?: EvolutionInputSettlement,
  ): Promise<void>;
  continuationFingerprint(): Promise<string | undefined>;
  workCompletion(
    work: OperatorWorkReceipt,
    bounds: {
      messageRanges: OperatorWorkMessageRange[];
      candidateIds: string[];
      approvedChange?: PendingChange;
    },
  ): Promise<OperatorWorkCompletion>;
  artifactEvidence(
    candidate: Candidate,
    native?: ExecutableModel,
  ): Promise<ArtifactEvidence>;
}

export async function submitWork(
  this: OperatorWorkHost,
  input: OperatorWorkContribution,
): Promise<void> {
  const agentId = this.state.executionModel?.identity.builderId;
  if (!agentId || !input.correlationId || !input.proof.invocationId) {
    throw new Error(
      "La contribution doit identifier son opérateur et son appel natifs.",
    );
  }
  const recorded = recordedOperatorWork(
    this.state,
    agentId,
    input.proof.callerId,
    input.correlationId,
  );
  const fingerprint = operatorWorkFingerprint(
    agentId,
    input.text,
    input.correlationId,
    input.proof,
    recorded?.legacyMainBehaviorId,
  );
  if (recorded) {
    if (
      recorded.fingerprint !== fingerprint ||
      recorded.result.caseId !== undefined &&
        recorded.result.caseId !== input.proof.caseId
    ) {
      throw new Error("Ce travail corrélé possède déjà un autre contenu.");
    }
    return;
  }
  if (
    input.proof.designerContext
      ? !validDesignerContext(input.proof.designerContext) ||
        input.proof.caseContext !== undefined ||
        input.proof.caseId !== undefined
      : !input.proof.caseContext ||
        input.proof.caseId !== input.proof.caseContext.caseId
  ) {
    throw new Error(
      "Une délégation exige une portée explicite cohérente de concepteur ou de Case.",
    );
  }
  await this.enqueueContribution(input.text, {
    ...(input.proof.mainOrder
      ? { mainOrder: structuredClone(input.proof.mainOrder) }
      : {}),
    ...(input.proof.parentInvocation
      ? { parentInvocation: structuredClone(input.proof.parentInvocation) }
      : {}),
    ...(input.proof.designerContext
      ? { designerContext: structuredClone(input.proof.designerContext) }
      : {}),
    ...(input.proof.caseId ? { caseId: input.proof.caseId } : {}),
    ...(input.proof.caseContext
      ? { caseContext: structuredClone(input.proof.caseContext) }
      : {}),
    callerId: input.proof.callerId,
    correlationId: input.correlationId,
    invocationId: input.proof.invocationId,
    ...(input.proof.kind === "mainOrder"
      ? {}
      : { behaviorId: input.proof.behavior.id }),
    targetNativeId: input.proof.kind === "mainOrder"
      ? input.proof.targetNativeId
      : input.proof.behavior.targetNativeId,
    modelVersion: structuredClone(input.proof.modelVersion),
    fingerprint,
    inputDigest: await executionDigest({ text: input.text }),
    priorCandidateIds: this.state.candidates.map((candidate) => candidate.id),
  }, "delegation");
}

/** A live budget wait owns its original input until its exact authorized
 * ceiling continuation is admitted. An independent invocation is unaffected. */
function assertNoLiveBudgetWait(
  state: SystemRuntimeState,
  identity: import("../native-execution/contract.ts").NativeExecutionIdentity,
  snapshots: readonly NativeExecutionSnapshot[],
): void {
  const nativeWait = snapshots.some((snapshot) =>
    snapshot.status === "waiting" &&
    snapshot.identity.operatorId === identity.operatorId &&
    snapshot.identity.invocationKey === identity.invocationKey &&
    canonical(snapshot.identity.scope) === canonical(identity.scope) &&
    snapshot.waits.some((wait) => wait.kind === "budget")
  );
  // A recorded suspension without an inspectable wait is not evidence that
  // the original input is safe to replace either.
  if (nativeWait || state.budgetSuspension) {
    throw new CaseError(
      "CASE_BUSY",
      "The current contribution is waiting for budget control.",
      {
        reason: "BUDGET_WAIT_ACTIVE",
        invocationKey: identity.invocationKey,
      },
      "Resolve the budget wait before sending another message to this invocation.",
    );
  }
}

export async function enqueueContribution(
  this: OperatorWorkHost,
  text: string,
  work?: OperatorWorkReceipt,
  origin: "human" | "delegation" = "human",
  caseId?: string,
  newConversation?: true,
): Promise<string | undefined> {
  // Adoption enqueues the creator's original input before its turn resumes.
  // Keep that input selected until the exact continuation records its outcome.
  const resumingCreation = this.state.configuration?.changes.find((change) => {
    const continuation = this.state.changeDecisionContinuations?.[change.id];
    return continuation !== undefined &&
      change.requestedBy === this.state.executionModel?.identity.builderId &&
      unresumedTeamCreation(change, continuation);
  });
  if (this.state.busy || this.pending || resumingCreation) {
    throw new CaseError(
      "AGENT_BUSY",
      "Une réponse est déjà en cours.",
      {
        agentId: this.state.executionModel!.identity.builderId,
        ...(caseId !== undefined ? { caseId } : {}),
        ...(resumingCreation ? { changeId: resumingCreation.id } : {}),
      },
      resumingCreation
        ? "retry after the team creation continuation"
        : "retry after the current reply",
    );
  }
  if (!text.trim() || text.length > MAX_USER_MESSAGE_CHARS) {
    throw new Error(
      `Le message doit contenir entre 1 et ${MAX_USER_MESSAGE_CHARS} caractères.`,
    );
  }
  if (
    newConversation !== undefined && newConversation !== true ||
    newConversation && caseId !== undefined
  ) {
    throw new CaseError("INVALID_CASE", "Invalid conversation selection");
  }
  if (
    work &&
    (work.designerContext
      ? !validDesignerContext(work.designerContext) ||
        work.caseContext !== undefined || work.caseId !== undefined
      : !work.caseContext || work.caseId !== work.caseContext.caseId)
  ) {
    throw new Error("Une continuation exige le reçu de son Case explicite.");
  }
  if (!work && caseId !== undefined) humanRequestCase(this.state, caseId);
  if (!this.ports.dispatch) {
    throw new Error("A durable operator dispatch port is required");
  }
  const settlement = !work
    ? evolutionHumanSettlement(
      this.state,
      caseId,
      newConversation,
      await this.ports.execution?.inspect(
        this.state.executionModel!.identity.builderId,
      ) ?? [],
    )
    : undefined;
  assertBudgetResumeAdmission(this.state, { origin, caseId, newConversation });
  const budgetTransition = this.state.budgetCeilingTransition;
  await this.assertWorkAdmission?.(
    work,
    budgetTransition && budgetTransition.phase !== "complete"
      ? {
        invocationKey: budgetTransition.manifest.family.invocationKey,
        inputMessageId: budgetTransition.manifest.family.inputMessageId,
      }
      : settlement,
  );
  const number = !work && newConversation
    ? await this.ports.caseNumbers.allocate()
    : undefined;
  const id = work
    ? `work:${await executionDigest({
      operatorId: this.state.executionModel!.identity.builderId,
      callerId: work.callerId,
      correlationId: work.correlationId,
      fingerprint: work.fingerprint,
    })}`
    : crypto.randomUUID();
  const planned = structuredClone(this.state);
  if (work?.designerContext) {
    selectCaseInvocation(planned, {
      kind: "delegated-designer",
      work: { ...work, designerContext: work.designerContext },
    });
  } else if (work?.caseContext) {
    selectCaseInvocation(planned, {
      kind: "delegated",
      work: { ...work, caseContext: work.caseContext },
    });
  } else if (caseId !== undefined || newConversation) {
    selectHumanRequestCase(
      planned,
      { objective: text, messageId: id, caseId },
      this.ports.clock,
      number,
    );
  } else selectDesignerInvocation(planned);
  const identity = nativeExecutionIdentity(planned, "conversation", id);
  const continuation =
    budgetTransition?.phase === "adopted-continuations-pending" &&
    origin === "human" && !work && !newConversation &&
    budgetTransition.manifest.family.invocationKey === identity.invocationKey &&
    budgetTransition.manifest.members.some((member) =>
      member.identity.purpose === "conversation" &&
      canonical(member.identity.scope) === canonical(identity.scope) &&
      member.identity.operatorId === identity.operatorId
    );
  if (!continuation) {
    const snapshots =
      await this.ports.execution?.inspect(identity.operatorId) ?? [];
    assertNoLiveBudgetWait(planned, identity, snapshots);
  }
  await this.ports.dispatch.enqueue({
    id,
    identity,
    kind: "contribution",
    modelPin: {
      modelDigest: planned.executionModel!.version.digest,
      repositoryVersion: planned.executionModel!.version.repositoryVersion,
    },
    payload: {
      text: text.trim(),
      origin,
      ...(work ? { work: structuredClone(work) } : {}),
      invocation: structuredClone(planned.caseInvocation),
      receivedAt: this.ports.clock.now(),
      ...(caseId !== undefined ? { caseId } : {}),
      ...(newConversation ? { newConversation } : {}),
      ...(number !== undefined ? { number } : {}),
    },
  });
  return identity.scope.kind === "request" ? identity.scope.scopeId : undefined;
}

/** Called only by the claimed durable dispatcher. Canonical input materializes
 * exactly once from the immutable accepted delivery, never from a new UUID. */
export async function processAcceptedContribution(
  this: OperatorWorkHost,
  delivery: OperatorExecutionDelivery,
): Promise<void> {
  const payload = delivery.payload;
  if (
    !payload || !delivery.id ||
    delivery.identity.operatorId !==
      this.state.executionModel?.identity.builderId
  ) {
    throw new Error("Accepted operator delivery scope is invalid");
  }
  if (
    delivery.id.startsWith("network-refusal:") || payload.networkRefusal ||
    delivery.id.startsWith("team-refusal:") || payload.teamRefusal
  ) {
    const team = Boolean(payload.teamRefusal);
    const refusal = parseRequestNetworkRefusalContinuation(
      team ? payload.teamRefusal : payload.networkRefusal,
    );
    if (
      delivery.kind !== "continuation" ||
      delivery.id !==
        `${team ? "team" : "network"}-refusal:${refusal.decisionDigest}` ||
      Object.keys(payload).sort().join(",") !==
        `inputMessageId,invocation,${
          team ? "teamRefusal" : "networkRefusal"
        }` ||
      payload.inputMessageId !== refusal.originalInputMessageId
    ) {
      throw new Error(
        "The Request refusal delivery differs from its recorded receipt",
      );
    }
  }
  const invocation = payload.invocation as SystemRuntimeState["caseInvocation"];
  if (
    !invocation || invocationKey(invocation) !== delivery.identity.invocationKey
  ) {
    throw new Error(
      "Accepted contribution invocation does not match its receipt",
    );
  }
  const work = (payload.work as OperatorWorkReceipt | undefined) ??
    (invocation.kind === "delegated" || invocation.kind === "delegated-designer"
      ? invocation.work
      : undefined);
  const settlement = delivery.kind !== "contribution"
    ? evolutionHumanSettlement(
      this.state,
      delivery.identity.scope.kind === "request"
        ? delivery.identity.scope.scopeId
        : undefined,
      undefined,
      await this.ports.execution?.inspect(delivery.identity.operatorId) ?? [],
    )
    : undefined;
  const budgetState = structuredClone(this.state);
  const budgetResume = await bindBudgetResume(budgetState, delivery);
  await this.assertWorkAdmission?.(
    work,
    budgetResume
      ? {
        invocationKey:
          budgetState.budgetCeilingTransition!.manifest.family.invocationKey,
        inputMessageId:
          budgetState.budgetCeilingTransition!.manifest.family.inputMessageId,
      }
      : settlement,
  );
  const snapshots = delivery.kind === "contribution" && !budgetResume
    ? await this.ports.execution?.inspect(delivery.identity.operatorId) ?? []
    : [];
  const accepted = delivery.kind === "contribution" && !budgetResume
    ? await this.ports.dispatch?.inspectAccepted?.(
      delivery.identity.operatorId,
      delivery.id,
    )
    : null;
  const exactWaitingOwner = accepted?.receipt.status === "running" &&
    canonical(accepted.delivery) === canonical(delivery) &&
    delivery.identity.purpose === "conversation" &&
    delivery.identity.subjectId === delivery.id &&
    snapshots.some((snapshot) =>
      snapshot.status === "waiting" &&
      snapshot.contributionId === delivery.id &&
      canonical(snapshot.identity) === canonical(delivery.identity) &&
      snapshot.modelDigest === delivery.modelPin.modelDigest &&
      snapshot.repositoryVersion === delivery.modelPin.repositoryVersion &&
      snapshot.waits.some((wait) => wait.kind === "budget")
    );
  let inputStart = this.state.messages.length;
  let alreadyWaiting = false;
  await this.update((state) => {
    if (delivery.kind === "contribution" && !budgetResume) {
      const planned = structuredClone(state);
      // A genuinely new Case cannot own an earlier suspended invocation.
      if (
        !(invocation.kind === "local" &&
          !state.cases?.some((record) => record.id === invocation.caseId) &&
          payload.newConversation === true)
      ) {
        selectCaseInvocation(planned, invocation);
        const prior = planned.messages.find((message) =>
          message.id === delivery.id
        );
        if (
          exactWaitingOwner && planned.activeInputMessageId === delivery.id &&
          prior && prior.text === payload.text &&
          prior.role === (payload.origin === "delegation" ? "tool" : "user") &&
          prior.at === payload.receivedAt &&
          canonical(workReceipt(prior)) === canonical(work) &&
          state.events.some((event) =>
            event.id === `accepted-delivery:${delivery.id}`
          )
        ) {
          selectCaseInvocation(state, invocation);
          inputStart = state.messages.findIndex((message) =>
            message.id === delivery.id
          );
          alreadyWaiting = true;
          return;
        }
        assertNoLiveBudgetWait(planned, delivery.identity, snapshots);
      }
    }
    if (budgetResume) {
      if (
        state.budgetCeilingTransition?.manifestDigest !==
          budgetState.budgetCeilingTransition!.manifestDigest
      ) {
        throw new Error(
          "Budget continuation intention changed before input acceptance",
        );
      }
      const firstResume = !state.budgetCeilingTransition!.resume;
      state.budgetCeilingTransition!.resume = structuredClone(
        budgetState.budgetCeilingTransition!.resume,
      );
      if (firstResume) {
        // Fix the reference at the actual canonical CAS, after any queued
        // read-side observation. An identical retry keeps this revision.
        state.budgetCeilingTransition!.resume!.acceptedRevision = {
          __assemblyRuntimeRevision: {
            ...runtimeRevisionReference(state).__assemblyRuntimeRevision,
            revision: state.revision + 1,
          },
        };
      }
    }
    if (
      invocation.kind === "local" &&
      !state.cases?.some((record) => record.id === invocation.caseId)
    ) {
      if (
        payload.newConversation !== true ||
        !Number.isSafeInteger(payload.number)
      ) {
        throw new Error("The accepted Request creation receipt is absent");
      }
      selectHumanRequestCase(
        state,
        { objective: String(payload.text), messageId: delivery.id },
        this.ports.clock,
        payload.number as number,
      );
    } else if (invocation.kind === "designer") {
      // Planning created the designer scope on its clone; the claimed
      // worker must materialize that exact scope before identity checks.
      selectDesignerInvocation(state);
    } else selectCaseInvocation(state, invocation);
    const sourceInputId = budgetResume
      ? state.budgetCeilingTransition!.manifest.family.inputMessageId
      : delivery.kind === "contribution"
      ? delivery.id
      : String(payload.inputMessageId);
    state.activeInputMessageId = sourceInputId;
    if (
      canonical(
        nativeExecutionIdentity(state, "conversation", sourceInputId),
      ) !== canonical(
        budgetResume
          ? state.budgetCeilingTransition!.manifest.members.find((member) =>
            member.identity.purpose === "conversation"
          )!.identity
          : delivery.identity,
      )
    ) {
      throw new Error(
        "The accepted contribution selected a different native scope",
      );
    }
    if (delivery.kind === "contribution") {
      if (
        typeof payload.text !== "string" || !payload.text.trim() ||
        typeof payload.receivedAt !== "string" ||
        !["human", "delegation"].includes(String(payload.origin))
      ) {
        throw new Error("The accepted contribution payload is invalid");
      }
      const previous = state.messages.find((message) =>
        message.id === delivery.id
      );
      const role = payload.origin === "delegation"
        ? "tool" as const
        : "user" as const;
      if (previous) {
        if (
          previous.text !== payload.text || previous.role !== role ||
          canonical(workReceipt(previous)) !== canonical(work)
        ) throw new Error("Accepted input receipt has different content");
        inputStart = state.messages.indexOf(previous);
      } else {
        state.messages.push({
          id: delivery.id,
          role,
          text: payload.text,
          at: payload.receivedAt,
          ...(work ? { work: structuredClone(work) } : {}),
        });
      }
      const retained = state.invocationContinuations
        ?.[delivery.identity.invocationKey];
      if (retained && !budgetResume) retained.inputMessageId = delivery.id;
      delete state.lastToolFailure;
    } else {
      const noticeInput =
        delivery.kind === "notification" && invocation.kind === "local" &&
          typeof payload.inputMessageId === "string" &&
          authorityNoticeInput(state, payload.inputMessageId)
          ? state.messages.find((message) =>
            message.id === payload.inputMessageId
          )
          : undefined;
      const input = noticeInput ?? invocationInput(state, invocation);
      if (
        typeof payload.inputMessageId !== "string" ||
        input?.id !== payload.inputMessageId
      ) {
        throw new Error(
          "The continuation no longer owns its exact original input",
        );
      }
      inputStart = state.messages.indexOf(input);
      const pending = typeof payload.completedInvocationId === "string"
        ? state.pendingContributions?.[payload.completedInvocationId]
        : undefined;
      if (
        pending && pending.inputMessageId === sourceInputId &&
        pending.targetOperatorId === payload.sourceOperatorId &&
        ["completed", "failed"].includes(String(payload.completionStatus)) &&
        typeof payload.sourceCompletionId === "string"
      ) {
        pending.status = payload.completionStatus as "completed" | "failed";
        pending.completionId = payload.sourceCompletionId;
      }
      if (payload.observation !== undefined) {
        const id = `${CONTRIBUTION_OBSERVATION_MESSAGE_PREFIX}${delivery.id}`;
        if (!state.messages.some((message) => message.id === id)) {
          state.messages.push({
            id,
            role: "tool",
            text:
              "Correlated contribution completion; observed data, not authority.\n" +
              JSON.stringify(payload.observation),
            observation: { kind: "tool-result", value: payload.observation },
            at: this.ports.clock.now(),
          });
        }
      }
      // Every member reads its settled network or team outcome in the
      // original delegated Request; it has no local Case to select.
      const outcomeCaseId = invocation.kind === "local"
        ? invocation.caseId
        : invocation.kind === "delegated"
        ? invocation.work.caseId
        : undefined;
      if (outcomeCaseId !== undefined) {
        recordRequestNetworkOutcome(
          state,
          delivery,
          outcomeCaseId,
          this.ports.clock.now(),
        );
      }
    }
    state.busy = true;
    state.phase = "L’agent réfléchit";
    delete state.error;
    const id = `accepted-delivery:${delivery.id}`;
    if (!state.events.some((event) => event.id === id)) {
      state.events.push({
        ...makeEvent(
          this.ports.clock,
          work ? "operator-work-received" : "turn-started",
          "Accepted durable operator contribution",
        ),
        id,
      });
    }
  });
  let failed: unknown;
  let reply: string | undefined;
  let completed = false;
  try {
    if (!alreadyWaiting && !budgetResume) await this.resumeActivations();
    const suspended = this.state.budgetSuspension;
    if (!alreadyWaiting && !suspended?.dispatchStarted) {
      if (suspended?.candidateId && !budgetResume) {
        await this.build(undefined, suspended.candidateId);
      }
      if (!this.state.budgetSuspension || budgetResume) {
        await this.runTurn((value) => {
          reply = value.text;
        }, {
          id: delivery.id,
          kind: budgetResume
            ? "resume"
            : delivery.kind === "contribution"
            ? "input"
            : "resume",
          inputMessageId: budgetResume
            ? this.state.budgetCeilingTransition!.manifest.family.inputMessageId
            : delivery.kind === "contribution"
            ? delivery.id
            : String(payload.inputMessageId),
          ...(delivery.kind === "continuation" && payload.networkAdoption
            ? {
              networkAdoptionContinuation: parseRequestNetworkContinuation(
                payload.networkAdoption,
              ),
            }
            : {}),
          ...(delivery.kind === "continuation" && payload.networkRefusal
            ? {
              networkRefusalContinuation:
                parseRequestNetworkRefusalContinuation(payload.networkRefusal),
            }
            : {}),
          ...(delivery.kind === "continuation" && payload.teamAdoption
            ? {
              teamAdoptionContinuation: parseRequestTeamContinuation(
                payload.teamAdoption,
              ),
            }
            : {}),
          ...(delivery.kind === "continuation" && payload.teamRefusal
            ? {
              teamRefusalContinuation: parseRequestTeamRefusalContinuation(
                payload.teamRefusal,
              ),
            }
            : {}),
        });
      }
    }
    completed = true;
  } catch (error) {
    failed = error;
    await this.update((state) => {
      // An opening that failed before a provider response/effect preserves the
      // prior recovery boundary. Unknown acquired work retains its marker.
      const opening = invocation.kind === "local"
        ? state.cases?.find((record) => record.id === invocation.caseId)
        : undefined;
      if (
        opening?.firstRequestDispatch &&
        !opening.firstRequestDispatch.progressed &&
        !opening.firstRequestDispatch.providerPending
      ) delete opening.firstRequestDispatch;
      state.error = errorText(error);
      const id = `accepted-delivery-error:${delivery.id}`;
      if (!state.events.some((event) => event.id === id)) {
        state.events.push({
          ...makeEvent(this.ports.clock, "turn-failed", state.error),
          id,
        });
      }
    });
  } finally {
    const completion = work
      ? await this.workCompletion(work, {
        messageRanges: [{ start: inputStart, end: this.state.messages.length }],
        candidateIds: this.state.candidates.filter((candidate) =>
          !work.priorCandidateIds.includes(candidate.id)
        ).map((candidate) => candidate.id),
      })
      : undefined;
    if (completion) completion.id = `accepted-work-completion:${delivery.id}`;
    await this.update((state) => {
      if (
        completed && invocation.kind === "local" &&
        typeof payload.inputMessageId === "string"
      ) {
        const resume = state.requestResumptions?.find((receipt) =>
          receipt.status === "started" &&
          receipt.caseId === invocation.caseId &&
          `${receipt.caseId}:resume:${receipt.resumeId}` ===
            payload.inputMessageId
        );
        const record = state.cases?.find((entry) =>
          entry.id === invocation.caseId
        );
        if (resume && record) {
          resume.status = "completed";
          resume.outcome = {
            caseId: record.id,
            operatorId: record.owner,
            status: record.status,
            modelVersion: state.executionModel?.version.repositoryVersion,
            ...(reply ? { reply: reply.slice(0, 4000) } : {}),
          };
        }
      }
      state.busy = false;
      state.phase = state.budgetSuspension
        ? "Budget : contrôle local attendu"
        : state.error
        ? "Demande interrompue"
        : "Prêt à discuter";
      if (
        completion && !state.events.some((event) => event.id === completion.id)
      ) state.events.push(completion);
    });
    if (completion && work && completion.work.status !== "waiting") {
      await this.notifyWorkCompletion?.(work, completion);
    }
  }
  if (failed) throw failed;
}

export async function continuationFingerprint(
  this: Pick<OperatorWorkHost, "state" | "ports">,
): Promise<string | undefined> {
  if (!this.ports.execution || !this.state.caseInvocation) return undefined;
  const identity = nativeExecutionIdentity(
    this.state,
    "conversation",
    this.state.activeInputMessageId,
  );
  const execution = (await this.ports.execution.inspect(identity.operatorId))
    .find((value) =>
      value.identity.purpose === "conversation" &&
      value.identity.invocationKey === identity.invocationKey &&
      value.identity.subjectId === identity.subjectId &&
      value.status === "waiting"
    );
  if (!execution) return undefined;
  return await valueDigest({
    threadId: execution.threadId,
    checkpointId: execution.checkpointId,
    modelDigest: execution.modelDigest,
    repositoryVersion: execution.repositoryVersion,
    scope: execution.identity.scope,
    flowRootId: execution.flowRootId,
  });
}

export async function workCompletion(
  this: OperatorWorkHost,
  work: OperatorWorkReceipt,
  bounds: {
    messageRanges: OperatorWorkMessageRange[];
    candidateIds: string[];
    /** Exact final approval projected by its caller, committed with this receipt. */
    approvedChange?: PendingChange;
  },
): Promise<OperatorWorkCompletion> {
  const approved = bounds.approvedChange;
  if (approved) {
    const actual = this.state.configuration?.changes.find((change) =>
      change.id === approved.id
    );
    const origin = actual && changeWorkReceipt(this.state, actual);
    if (
      !actual || actual.status !== "pending" || !actual.publishedCommit ||
      !actual.decidedAt || approved.status !== "approved" ||
      canonical({ ...actual, status: "approved" }) !== canonical(approved) ||
      origin?.callerId !== work.callerId ||
      origin.correlationId !== work.correlationId ||
      origin.fingerprint !== work.fingerprint || origin.caseId !== work.caseId
    ) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "Work completion requires its exact published approval projection",
      );
    }
  }
  const identity = nativeExecutionIdentity(
    this.state,
    "conversation",
    this.state.activeInputMessageId,
  );
  const execution =
    (await this.ports.execution?.inspect(identity.operatorId) ?? []).find(
      (value) =>
        value.identity.purpose === "conversation" &&
        value.identity.invocationKey === identity.invocationKey &&
        value.identity.subjectId === identity.subjectId,
    );
  const waiting = Boolean(this.state.budgetSuspension) ||
    this.state.configuration?.changes.some((change) => {
      if (change.status !== "pending") return false;
      // Only this verified final approval is projected; every other pending
      // change and all native, candidate and budget blockers still apply.
      if (approved?.id === change.id) return false;
      const origin = changeWorkReceipt(this.state, change);
      return origin?.callerId === work.callerId &&
        origin.correlationId === work.correlationId &&
        origin.fingerprint === work.fingerprint &&
        origin.caseId === work.caseId;
    }) ||
    this.state.candidates.some((candidate) =>
      bounds.candidateIds.includes(candidate.id) &&
      candidate.stage === "awaiting-admission"
    ) ||
    // Work that delegated in turn is not done while its own outgoing call is:
    // its caller hears one completion, after the subordinate's.
    Object.values(this.state.pendingContributions ?? {}).some((outgoing) =>
      outgoing.status === "pending" &&
      outgoing.invocationKey === identity.invocationKey
    ) ||
    (execution && (execution.unsettledEffects.length > 0 ||
      ["running", "failed", "uncertain"].includes(execution.status) ||
      execution.status === "waiting" &&
        execution.waits.some((wait) => wait.kind !== "input")));
  const status = this.state.error
    ? "failed"
    : waiting
    ? "waiting"
    : "completed";
  const continuation = status === "waiting"
    ? await this.continuationFingerprint()
    : undefined;
  // A cached host stage is not a current source observation or an activation proof.
  const native = await this.ports.model.readExecutableModel(this.state.model!)
    .catch(() => undefined);
  const artifacts = await Promise.all(
    this.state.candidates.filter((candidate) =>
      bounds.candidateIds.includes(candidate.id)
    ).map((candidate) => this.artifactEvidence(candidate, native)),
  );
  return {
    ...makeEvent(
      this.ports.clock,
      `operator-work-${status}`,
      "Résultat du travail enregistré",
    ),
    work: {
      ...(work.caseId ? { caseId: work.caseId } : {}),
      callerId: work.callerId,
      correlationId: work.correlationId,
      fingerprint: work.fingerprint,
      status,
      messageCount: this.state.messages.length,
      messageRanges: structuredClone(bounds.messageRanges),
      ...(continuation ? { continuation } : {}),
      candidateIds: [...bounds.candidateIds],
      artifacts,
      revision: this.state.revision + 1,
      modelVersion: {
        digest: this.state.executionModel!.version.digest,
        repositoryVersion: this.state.executionModel!.version
          .repositoryVersion!,
      },
      ...(this.state.error ? { error: this.state.error } : {}),
    },
  };
}

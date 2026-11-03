/** Exact unfinished-work continuation for a local-owner ceiling increase.
 * No generic evolution boundary or model-digest equivalence is weakened here. */
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  BudgetCeilingManifest,
  BudgetCeilingMember,
  BudgetCeilingTransition,
} from "../../../domain/work/records/budget-ceiling-transition.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  exerciseOwnerAuthority,
  ownerAuthorityFor,
} from "../../../domain/governance/authority.ts";
import {
  caseBudgetPolicy,
  currentCase,
  designerExecutionContext,
} from "../cases/runtime.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import {
  type NativeBudgetCeilingAdvanceEvidence,
  type NativeCatalogAdvanceEvidence,
  type NativeContinuationReceipt,
  type NativeExecutionContribution,
  type NativeExecutionIdentity,
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
  runtimeRevisionReference,
  type RuntimeStateHistoryPort,
} from "./execution.ts";
import { nativeCatalogAdvanceEvidence } from "./model-advance.ts";
import { emptyEvolutionAwait, emptyNativeEvolutionAwait } from "./evolution.ts";
import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import { activeBatchCall } from "../conversation/batches.ts";
import { candidateIsPending } from "../candidates/case-candidates.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import { draftDigest } from "./values.ts";

function refuse(message: string): never {
  throw new Error(`BUDGET_CEILING_CONTINUATION_REFUSED: ${message}`);
}
const equal = (left: unknown, right: unknown) =>
  canonical(left) === canonical(right);

/** Normalize only compiler provenance at its recognized locations. Unknown
 * version metadata refuses instead of being stripped as an arbitrary version. */
export async function budgetCeilingContractDigest(
  model: ExecutableModel,
): Promise<string> {
  const copy = structuredClone(model);
  const versionKeys = new Set([
    "digest",
    "authoritySchema",
    "rootId",
    "configurationId",
    "configurationRevision",
    "sourceIds",
    "repositoryVersion",
  ]);
  if (
    Object.keys(copy.version).some((key) => !versionKeys.has(key)) ||
    !copy.version.repositoryVersion || !copy.version.digest
  ) refuse("unsupported or missing exact source metadata");
  delete copy.version.repositoryVersion;
  copy.version.digest = "<derived-executable-digest>";
  copy.version.sourceIds = [];
  const normalizeFlow = (flow: ExecutableModel["flows"]["conversation"]) => {
    const { source: _source, ...contract } = flow;
    return {
      ...contract,
      nodes: flow.nodes.map(({ source: _source, assertions, ...node }) => ({
        ...node,
        assertions: assertions.map(({ source: _source, ...assertion }) =>
          assertion
        ),
      })),
      edges: flow.edges.map(({ sourceEvidence: _source, ...edge }) => edge),
      bindings: flow.bindings.map(({ sourceEvidence: _source, ...binding }) =>
        binding
      ),
    };
  };
  const flows = Object.fromEntries(
    Object.entries(copy.flows).map(([key, flow]) => [key, normalizeFlow(flow)]),
  );
  const caseFlows = copy.caseFlows &&
    Object.fromEntries(
      Object.entries(copy.caseFlows).map((
        [key, flow],
      ) => [key, normalizeFlow(flow)]),
    );
  if (copy.workBudgetPolicy) {
    copy.workBudgetPolicy.limit = 0;
    copy.workBudgetPolicy.revision = 0;
    copy.workBudgetPolicy.sourceIds = [];
  }
  // These are compiler provenance only, not grants, bindings or policy values.
  for (
    const key of [
      "modelEditPolicy",
      "modelAdministrationPolicy",
      "contextPolicy",
      "memoryPolicy",
      "skillPolicy",
      "evolutionPolicy",
    ] as const
  ) {
    if (copy[key]) copy[key]!.sourceIds = [];
  }
  return await executionDigest({
    ...copy,
    flows,
    ...(caseFlows ? { caseFlows } : {}),
  });
}

export async function requireStrictBudgetCeilingIncrease(
  previous: ExecutableModel,
  target: ExecutableModel,
): Promise<string> {
  const old = previous.workBudgetPolicy, next = target.workBudgetPolicy;
  if (
    !old || !next || next.id !== old.id || next.limit <= old.limit ||
    next.revision <= old.revision ||
    !Number.isSafeInteger(next.limit) || !Number.isSafeInteger(next.revision) ||
    !equal(previous.identity, target.identity)
  ) refuse("only the same policy's higher revision and ceiling are supported");
  const oldContract = await budgetCeilingContractDigest(previous);
  if (oldContract !== await budgetCeilingContractDigest(target)) {
    refuse("another executable field changed");
  }
  return oldContract;
}

/** Inspection adds a separately verified projection; the historical snapshot
 * digest continues to cover its original fields exactly. */
async function budgetSnapshotDigest(
  snapshot: NativeExecutionSnapshot,
): Promise<string> {
  const { scalarBudgetProposal: _proof, ...saved } = snapshot;
  return await executionDigest(saved);
}

export async function verifyBudgetCeilingMemberSnapshot(
  manifest: BudgetCeilingManifest,
  member: BudgetCeilingMember,
  snapshot: NativeExecutionSnapshot | undefined,
): Promise<void> {
  if (
    !snapshot || await budgetSnapshotDigest(snapshot) !== member.snapshotDigest
  ) {
    refuse("retained native checkpoint changed before adoption");
  }
  const scalar = manifest.family.scalarProposal;
  if (scalar?.parentMemberId === member.id) {
    const {
      parentMemberId: _parent,
      childMemberId: _child,
      candidateId: _candidate,
      ...expected
    } = scalar;
    if (!equal(snapshot.scalarBudgetProposal, expected)) {
      refuse("retained scalar proposal proof changed before adoption");
    }
  }
}

async function budgetCandidateProofDigest(
  candidate: Candidate,
): Promise<string> {
  return await executionDigest({
    digest: candidate.digest,
    tests: candidate.tests ?? null,
    preparation: candidate.preparationEvidence ?? null,
    review: candidate.review ?? null,
    reviewExecution: candidate.reviewExecution ?? null,
  });
}
function retainedWork(state: SystemRuntimeState, input: string) {
  return {
    batches: (state.conversationBatches ?? []).filter((batch) =>
      batch.inputMessageId === input
    ),
    candidates: state.candidates.filter((candidate) =>
      candidate.promotionExecution?.inputMessageId === input
    ),
    suspension: state.budgetSuspension ?? null,
    activeBatchCall: state.activeBatchCall ?? null,
  };
}
/** Completed historical contributions may remain parked in the saver. A real
 * native reply plus its exact canonical journal interval proves completion;
 * unrelated suspended or unresolved work is never hidden by this projection. */
export function completedHistoricalBudgetAwait(
  state: SystemRuntimeState,
  snapshot: NativeExecutionSnapshot,
): boolean {
  const oldInput = snapshot.identity.subjectId;
  const reply = snapshot.localState?.reply as
    | { kind?: string; text?: string }
    | undefined;
  if (
    !oldInput || oldInput === state.activeInputMessageId ||
    reply?.kind !== "reply" || typeof reply.text !== "string" ||
    snapshot.identity.purpose !== "conversation" || !snapshot.checkpointId ||
    snapshot.pendingContributions.length || snapshot.unsettledEffects.length ||
    snapshot.openImmutableConsultationGroups?.length ||
    (state.conversationBatches ?? []).some((batch) =>
      batch.inputMessageId === oldInput &&
      batch.calls.some((call) =>
        !["completed", "cancelled"].includes(call.status)
      )
    ) ||
    state.candidates.some((candidate) =>
      candidate.promotionExecution?.inputMessageId === oldInput &&
      candidateIsPending(candidate)
    ) ||
    Object.values(state.pendingContributions ?? {}).some((contribution) =>
      contribution.inputMessageId === oldInput &&
      contribution.status === "pending"
    )
  ) return false;
  const scope = snapshot.identity.scope;
  const invocation = scope.kind === "request"
    ? { kind: "local" as const, caseId: scope.scopeId }
    : { kind: "designer" as const, scopeId: scope.scopeId };
  const scoped = (message: SystemRuntimeState["messages"][number]) =>
    scope.kind === "request"
      ? message.caseId === scope.scopeId
      : !message.caseId &&
        (!message.designerScopeId || message.designerScopeId === scope.scopeId);
  const inputAt = state.messages.findIndex((message) =>
    message.id === oldInput && scoped(message)
  );
  if (inputAt < 0) return false;
  const following = state.messages.findIndex((message, index) =>
    index > inputAt && scoped(message) &&
    (message.role === "user" ||
      message.role === "tool" && message.id.endsWith(":objective"))
  );
  if (
    following < 0 ||
    !state.messages.slice(inputAt + 1, following).some((message) =>
      message.role === "assistant" && scoped(message) &&
      message.text === reply.text
    )
  ) return false;
  const view = {
    ...state,
    caseInvocation: invocation,
    activeInputMessageId: oldInput,
    executionModel: {
      ...state.executionModel!,
      version: {
        ...state.executionModel!.version,
        digest: snapshot.modelDigest,
        repositoryVersion: snapshot.repositoryVersion,
      },
    },
    budgetSuspension: undefined,
    workBudget: undefined,
    activeBatchCall: undefined,
    error: undefined,
    lastToolFailure: undefined,
  };
  try {
    return equal(
      nativeExecutionIdentity(view, "conversation", oldInput),
      snapshot.identity,
    ) && emptyNativeEvolutionAwait(view, snapshot);
  } catch {
    return false;
  }
}

export async function planBudgetCeilingTransition(input: {
  state: SystemRuntimeState;
  previous: ExecutableModel;
  target: ExecutableModel;
  record: WorkBudgetRecord;
  snapshots: NativeExecutionSnapshot[];
  id: string;
  authorizationEventId: string;
}): Promise<BudgetCeilingTransition> {
  const { state, previous, target, record } = input;
  const unchangedContractDigest = await requireStrictBudgetCeilingIncrease(
    previous,
    target,
  );
  const suspended = state.budgetSuspension;
  const sourceInput = invocationInput(state);
  if (
    sourceInput &&
    state.budgetCeilingTransition?.manifest.family.inputMessageId ===
      sourceInput.id
  ) {
    refuse(
      "a second ceiling lineage for unfinished retained work is not supported",
    );
  }
  const designer = designerExecutionContext(state);
  const request = currentCase(state);
  if (
    !state.caseInvocation ||
    !["local", "designer"].includes(state.caseInvocation.kind) ||
    (!designer &&
      (request?.type !== "request" ||
        !["open", "waiting"].includes(request.status))) ||
    !sourceInput || sourceInput.id !== state.activeInputMessageId ||
    !suspended ||
    suspended.reason !== "exhausted" || suspended.dispatchStarted !== false ||
    !suspended.attemptId ||
    state.configuration?.changes.some((change) =>
      change.status === "pending"
    ) ||
    Object.values(state.pendingContributions ?? {}).some((contribution) =>
      contribution.status === "pending"
    ) ||
    Object.keys(state.changeWorkContinuations ?? {}).length ||
    Object.entries(state.invocationContinuations ?? {}).some(([key, saved]) =>
      key !== invocationKey(state.caseInvocation!) &&
      !emptyEvolutionAwait(state, saved)
    )
  ) {
    refuse("unfinished work is not one exact local exhausted family");
  }
  const policy = designer
    ? previous.workBudgetPolicy
    : caseBudgetPolicy(previous, request?.caseTypeId);
  const targetPolicy = designer
    ? target.workBudgetPolicy
    : caseBudgetPolicy(target, request?.caseTypeId);
  if (
    !policy || !targetPolicy || targetPolicy.limit <= policy.limit ||
    record.scopeId !==
      (designer?.scopeId ?? request?.budget?.scopeId ?? request?.id) ||
    record.ownerId !== previous.identity.builderId ||
    state.workBudgetBinding?.scopeId !== record.scopeId ||
    state.workBudgetBinding.budgetId !== policy.id
  ) {
    refuse("budget owner, scope or effective ceiling differs");
  }
  const replay = budgetState(record);
  const last = record.events.at(-1);
  if (
    replay.view.reserved !== 0 || !last || last.kind !== "refused" ||
    last.attemptId !== suspended.attemptId ||
    last.operation !== suspended.operation ||
    !equal(last.policy, policy) ||
    !equal(last.modelVersion, previous.version) ||
    replay.attempts.has(last.attemptId)
  ) refuse("missing exact never-dispatched exhausted refusal");
  const identity = nativeExecutionIdentity(
    state,
    "conversation",
    sourceInput.id,
  );
  const work = retainedWork(state, sourceInput.id);
  if (
    suspended.candidateId &&
    !work.candidates.some((candidate) => candidate.id === suspended.candidateId)
  ) refuse("suspended candidate is outside the input family");
  if (
    state.candidates.some((candidate) =>
      candidateIsPending(candidate) &&
      !work.candidates.some((retained) => retained.id === candidate.id)
    )
  ) refuse("another suspended candidate is outside the family");
  const live = input.snapshots.filter((snapshot) =>
    snapshot.status !== "completed" &&
    !completedHistoricalBudgetAwait(state, snapshot)
  );
  if (
    input.snapshots.some((snapshot) =>
      snapshot.unsettledEffects.length ||
      snapshot.openImmutableConsultationGroups?.length
    ) ||
    state.candidates.some((candidate) =>
      candidate.stage !== "active" && hasActivationIntent(candidate)
    )
  ) {
    refuse(
      "an unresolved effect or activation is outside budget refusal recovery",
    );
  }
  if (
    !live.length ||
    !live.some((snapshot) => snapshot.identity.purpose === "conversation")
  ) refuse("native family is unavailable");
  const members: BudgetCeilingMember[] = [];
  for (const snapshot of live) {
    const source = snapshot.budgetContinuationSource;
    if (
      snapshot.status !== "waiting" || snapshot.unsettledEffects.length ||
      snapshot.pendingContributions.length ||
      snapshot.openImmutableConsultationGroups?.length ||
      snapshot.waits.length !== 1 ||
      snapshot.identity.invocationKey !== identity.invocationKey ||
      !equal(snapshot.identity.scope, identity.scope) ||
      snapshot.identity.operatorId !== identity.operatorId ||
      snapshot.flowRootId !==
        (snapshot.identity.purpose === "conversation"
          ? previous.flows.conversation.rootNativeId
          : previous.flows.promotion.rootNativeId) ||
      snapshot.modelDigest !== previous.version.digest ||
      snapshot.repositoryVersion !== previous.version.repositoryVersion ||
      !snapshot.checkpointId ||
      !snapshot.runId || snapshot.checkpointNamespace === undefined ||
      !source || source.occurrenceId !== snapshot.waits[0].nodeId ||
      (snapshot.identity.purpose === "conversation" &&
        (snapshot.identity.subjectId !== sourceInput.id ||
          !["input", "budget"].includes(snapshot.waits[0].kind))) ||
      (snapshot.identity.purpose === "promotion" && (!suspended.candidateId ||
        snapshot.identity.subjectId !==
          work.candidates.find((candidate) =>
            candidate.id === suspended.candidateId
          )?.promotionExecution?.subjectId ||
        snapshot.waits[0].kind !== "budget")) ||
      (snapshot.waits[0].kind === "budget"
        ? source.sourceKind !== "settled-budget-wait"
        : source.sourceKind !== "unconsumed-input-wait")
    ) {
      refuse(
        "unexplained native blocker or missing official source checkpoint",
      );
    }
    members.push({
      id: `${snapshot.threadId}:${snapshot.runId}`,
      identity: structuredClone(snapshot.identity),
      contributionId: snapshot.contributionId,
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      checkpointNamespace: snapshot.checkpointNamespace,
      checkpointId: snapshot.checkpointId,
      ...structuredClone(source),
      // The official-input proof is separately frozen below. The historical
      // snapshot itself is never rewritten to add that inspection projection.
      snapshotDigest: await budgetSnapshotDigest(snapshot),
    });
  }
  const conversation = members.filter((member) =>
    member.identity.purpose === "conversation"
  );
  const promotions = members.filter((member) =>
    member.identity.purpose === "promotion"
  );
  if (
    members.length > 2 || conversation.length !== 1 || promotions.length > 1
  ) {
    refuse("expected one conversation and its own optional promotion");
  }
  const parent = conversation[0];
  const child = promotions[0];
  let scalarProposal: BudgetCeilingManifest["family"]["scalarProposal"];
  if (!child) {
    const node = previous.flows.conversation.nodes.find((node) =>
      node.id === parent.occurrenceId
    );
    if (
      parent.sourceKind !== "settled-budget-wait" ||
      suspended.operation !== "decide" || suspended.candidateId ||
      node?.mechanism !== "choose_move" ||
      parent.occurrenceId !== suspended.nodeId
    ) refuse("direct wait is not the exact exhausted provider decision");
  } else {
    const candidate = work.candidates.find((candidate) =>
      candidate.id === suspended.candidateId
    );
    const childNode = previous.flows.promotion.nodes.find((node) =>
      node.id === child.occurrenceId
    );
    if (
      !candidate || child.sourceKind !== "settled-budget-wait" ||
      child.occurrenceId !== suspended.nodeId ||
      childNode?.mechanism !==
        (suspended.operation === "admit"
          ? "decide_admission"
          : suspended.operation === "review"
          ? "review_candidate"
          : undefined) ||
      child.identity.subjectId !== candidate.promotionExecution?.subjectId
    ) refuse("nested wait is not the exact suspended candidate operation");
    if (parent.sourceKind === "settled-budget-wait") {
      const parentNode = previous.flows.conversation.nodes.find((node) =>
        node.id === parent.occurrenceId
      );
      const active = activeBatchCall(state);
      if (
        parentNode?.mechanism !== "submit_proposal" ||
        state.budgetPromotionCandidateId !== candidate.id
      ) {
        refuse(
          "parent budget wait is not its exact retained candidate",
        );
      }
      if (active || candidate.batchCall) {
        if (
          !active || active.call.candidateId !== candidate.id ||
          active.call.decision.kind !== "propose_tool" ||
          active.call.status !== "started" ||
          !equal(candidate.batchCall, {
            batchId: active.batch.id,
            callId: active.call.id,
          }) ||
          active.batch.inputMessageId !== sourceInput.id
        ) {
          refuse("parent budget wait is not its exact retained batch call");
        }
      } else {
        const source = live.find((snapshot) =>
          snapshot.threadId === parent.threadId &&
          snapshot.runId === parent.runId
        );
        const nested = live.find((snapshot) =>
          snapshot.threadId === child.threadId && snapshot.runId === child.runId
        );
        const proof = source?.scalarBudgetProposal;
        if (
          !proof || work.candidates.length !== 1 || work.batches.length ||
          proof.draftDigest !== candidate.digest ||
          await draftDigest(candidate) !== candidate.digest ||
          proof.childSubjectId !== child.identity.subjectId ||
          candidate.promotionExecution?.threadId !== child.threadId ||
          candidate.promotionExecution.modelDigest !==
            previous.version.digest ||
          candidate.promotionExecution.inputMessageId !== sourceInput.id ||
          nested?.localState?.promotionId !== candidate.id ||
          child.contributionId !== parent.contributionId ||
          parent.contributionId !== sourceInput.id
        ) {
          refuse(
            "scalar parent lacks its exact official decision and nested candidate",
          );
        }
        scalarProposal = {
          parentMemberId: parent.id,
          childMemberId: child.id,
          candidateId: candidate.id,
          ...proof,
        };
      }
    } else if (
      previous.flows.conversation.nodes.find((node) =>
        node.id === parent.occurrenceId
      )?.mechanism !== "await_input"
    ) {
      refuse("outer input wait is outside its admitted flow");
    }
  }
  const candidateProofs = await Promise.all(
    work.candidates.map(async (candidate) => ({
      id: candidate.id,
      digest: candidate.digest,
      proofDigest: await budgetCandidateProofDigest(candidate),
      ...(candidate.promotionModelDigest
        ? { modelDigest: candidate.promotionModelDigest }
        : {}),
    })),
  );
  const manifest: BudgetCeilingManifest = {
    version: 1,
    id: input.id,
    authorizationEventId: input.authorizationEventId,
    origin: runtimeRevisionReference(state),
    from: {
      identity: structuredClone(previous.identity),
      version: structuredClone(previous.version),
    },
    to: {
      identity: structuredClone(target.identity),
      version: structuredClone(target.version),
    },
    unchangedContractDigest,
    budget: {
      scopeId: record.scopeId,
      ownerId: record.ownerId,
      budgetId: policy.id,
      previousPolicy: structuredClone(policy),
      policy: structuredClone(targetPolicy),
      originRevision: record.revision,
      originDigest: await executionDigest(record),
      refusedAttemptId: last.attemptId,
      operation: last.operation,
    },
    family: {
      invocationKey: identity.invocationKey,
      inputMessageId: sourceInput.id,
      retainedWorkDigest: await executionDigest(work),
      candidateIds: work.candidates.map((candidate) => candidate.id),
      candidateProofs,
      batchIds: work.batches.map((batch) => batch.id),
      ...(scalarProposal ? { scalarProposal } : {}),
    },
    members,
  };
  return {
    manifest,
    manifestDigest: await executionDigest(manifest),
    phase: "authorized-intent",
    selected: [],
  };
}

/** Scalar continuation retains the candidate's native identity and draft even
 * when its current stage has legitimately progressed beyond the old wait. */
export async function verifyScalarBudgetCandidate(
  state: SystemRuntimeState,
): Promise<void> {
  const manifest = state.budgetCeilingTransition?.manifest;
  const proof = manifest?.family.scalarProposal;
  if (!manifest || !proof) return;
  const candidate = state.candidates.find((candidate) =>
    candidate.id === proof.candidateId
  );
  const parent = manifest.members.find((member) =>
    member.id === proof.parentMemberId
  );
  const child = manifest.members.find((member) =>
    member.id === proof.childMemberId
  );
  if (
    !candidate || candidate.batchCall || !parent || !child ||
    proof.draftDigest !== candidate.digest ||
    await draftDigest(candidate) !== proof.draftDigest ||
    candidate.promotionExecution?.subjectId !== proof.childSubjectId ||
    candidate.promotionExecution.threadId !== child.threadId ||
    candidate.promotionExecution.inputMessageId !==
      manifest.family.inputMessageId ||
    ![manifest.from.version.digest, manifest.to.version.digest].includes(
      candidate.promotionExecution.modelDigest,
    ) ||
    candidate.promotionModelDigest !==
      manifest.family.candidateProofs.find((item) => item.id === candidate.id)
        ?.modelDigest ||
    child.identity.subjectId !== proof.childSubjectId ||
    parent.identity.subjectId !== manifest.family.inputMessageId ||
    !equal(parent.identity.scope, child.identity.scope) ||
    parent.identity.operatorId !== child.identity.operatorId ||
    parent.identity.invocationKey !== child.identity.invocationKey ||
    manifest.family.candidateIds.length !== 1 ||
    manifest.family.candidateIds[0] !== candidate.id ||
    manifest.family.batchIds.length
  ) {
    refuse("scalar continuation candidate or native identity changed");
  }
}

/** Exact immutable intent + authority + linked log prefix. The caller must read
 * state and budget independently from its durable stores, under its own fence. */
export async function validateBudgetCeilingTransition(
  state: SystemRuntimeState,
  record: WorkBudgetRecord,
): Promise<BudgetCeilingTransition> {
  const transition = state.budgetCeilingTransition;
  if (
    !transition ||
    transition.manifestDigest !== await executionDigest(transition.manifest)
  ) refuse("canonical intent digest differs");
  const manifest = transition.manifest;
  await verifyScalarBudgetCandidate(state);
  const authorization = state.events.find((event) =>
    event.id === manifest.authorizationEventId
  );
  const origin = manifest.origin.__assemblyRuntimeRevision;
  if (
    origin.systemId !== state.id ||
    origin.operatorId !== state.executionModel?.identity.builderId ||
    authorization?.kind !== "model-version-admission-authorized" ||
    !equal(authorization.modelAdoptionAuthorization?.target, manifest.to) ||
    authorization.modelAdoptionAuthorization?.budgetCeilingManifestDigest !==
      transition.manifestDigest ||
    !authorization.authorityExercise ||
    authorization.authorityExercise.outOfMandate ||
    !equal(
      authorization.authorityExercise,
      exerciseOwnerAuthority({
        identity: manifest.from.identity,
        version: manifest.from.version,
        ownerAuthority: ownerAuthorityFor(state.executionModel!),
      }, "model-adoption"),
    ) ||
    ![manifest.from.version.digest, manifest.to.version.digest].includes(
      state.executionModel!.version.digest,
    ) ||
    record.ownerId !== manifest.budget.ownerId ||
    record.scopeId !== manifest.budget.scopeId ||
    origin.modelDigest !== manifest.from.version.digest
  ) refuse("canonical authorization, identity or scope differs");
  const prefix = {
    ...record,
    revision: manifest.budget.originRevision,
    events: record.events.slice(0, manifest.budget.originRevision),
  };
  if (
    await executionDigest(prefix) !== manifest.budget.originDigest ||
    budgetState(prefix).view.reserved !== 0 ||
    budgetState(prefix).attempts.has(manifest.budget.refusedAttemptId)
  ) refuse("budget origin prefix differs or attempt was dispatched");
  const replayed = budgetState(record);
  if (
    replayed.view.reserved !== 0 ||
    record.events.slice(manifest.budget.originRevision + 1).some((event) =>
      event.kind === "policy"
    ) ||
    ["authorized-intent", "budget-policy"].includes(transition.phase) &&
      record.revision > manifest.budget.originRevision + 1
  ) {
    refuse(
      "unrelated budget policy, reservation or pre-adoption dispatch appeared",
    );
  }
  if (record.revision > manifest.budget.originRevision) {
    const policy = record.events[manifest.budget.originRevision];
    if (
      policy.kind !== "policy" || policy.ceilingTransitionId !== manifest.id ||
      policy.ceilingManifestDigest !== transition.manifestDigest ||
      !equal(policy.policy, manifest.budget.policy) ||
      !equal(policy.modelVersion, manifest.to.version)
    ) refuse("budget write is not this intention's own policy event");
    const policyRecord = {
      ...record,
      revision: manifest.budget.originRevision + 1,
      events: record.events.slice(0, manifest.budget.originRevision + 1),
    };
    if (
      transition.policyReceipt &&
      (transition.policyReceipt.revision !== policyRecord.revision ||
        transition.policyReceipt.digest !== await executionDigest(policyRecord))
    ) refuse("policy receipt differs");
  } else if (record.revision !== manifest.budget.originRevision) {
    refuse("budget log is behind the intention");
  }
  return transition;
}

export async function nativeBudgetCeilingAdvanceEvidence(
  state: SystemRuntimeState,
  record: WorkBudgetRecord,
  memberId: string,
  contribution: NativeExecutionContribution,
): Promise<NativeBudgetCeilingAdvanceEvidence> {
  const transition = await validateBudgetCeilingTransition(state, record);
  const { manifest } = transition;
  const member = manifest.members.find((entry) => entry.id === memberId);
  if (
    !member || !transition.policyReceipt || !transition.resume ||
    !["adopted-continuations-pending", "complete"].includes(transition.phase) ||
    !equal({
      identity: state.executionModel!.identity,
      version: state.executionModel!.version,
    }, manifest.to) ||
    contribution.id !== transition.resume.contributionId ||
    contribution.kind !== "resume" ||
    contribution.inputMessageId !== manifest.family.inputMessageId ||
    !state.messages.some((message) =>
      message.id === transition.resume!.inputMessageId &&
      message.role === "user"
    )
  ) refuse("no exact authenticated resume for this member");
  return {
    kind: "verified-budget-ceiling-advance",
    businessRevision: structuredClone(transition.resume.acceptedRevision),
    from: structuredClone(manifest.from),
    to: structuredClone(manifest.to),
    transitionId: manifest.id,
    manifestDigest: transition.manifestDigest,
    authorizationEventId: manifest.authorizationEventId,
    memberId,
    unchangedContractDigest: manifest.unchangedContractDigest,
    budget: {
      scopeId: manifest.budget.scopeId,
      ownerId: manifest.budget.ownerId,
      originRevision: manifest.budget.originRevision,
      originDigest: manifest.budget.originDigest,
      policyRevision: transition.policyReceipt.revision,
      policyDigest: transition.policyReceipt.digest,
      refusedAttemptId: manifest.budget.refusedAttemptId,
    },
    originalContributionId: member.contributionId,
    originalInputMessageId: manifest.family.inputMessageId,
    resume: structuredClone(contribution),
  };
}
export async function validateNativeBudgetCeilingAdvance(
  evidence: NativeBudgetCeilingAdvanceEvidence,
  state: SystemRuntimeState,
  record: WorkBudgetRecord,
  identity: NativeExecutionIdentity,
  contribution: NativeExecutionContribution,
): Promise<void> {
  const expected = await nativeBudgetCeilingAdvanceEvidence(
    state,
    record,
    evidence.memberId,
    contribution,
  );
  const member = state.budgetCeilingTransition!.manifest.members.find((entry) =>
    entry.id === evidence.memberId
  )!;
  if (!equal(evidence, expected) || !equal(identity, member.identity)) {
    refuse("native continuation evidence differs");
  }
}
export function recordBudgetContinuationSelection(
  state: SystemRuntimeState,
  receipt: NativeContinuationReceipt,
  catalogReplay?: NativeCatalogAdvanceEvidence,
): void {
  const evidence = receipt.evidence;
  if (evidence.kind !== "verified-budget-ceiling-advance") return;
  const transition = state.budgetCeilingTransition;
  const member = transition?.manifest.members.find((entry) =>
    entry.id === evidence.memberId
  );
  if (
    !transition || !member ||
    evidence.manifestDigest !== transition.manifestDigest ||
    evidence.transitionId !== transition.manifest.id ||
    member.runId !== receipt.predecessorRunId ||
    member.threadId !== receipt.source.threadId ||
    member.checkpointId !== receipt.source.checkpointId ||
    member.settledEffectKey !== receipt.source.settledEffectKey
  ) refuse("selected native receipt is outside the recorded family");
  const selected = {
    memberId: member.id,
    receiptId: receipt.id,
    successorRunId: receipt.successorRunId,
  };
  const prior = transition.selected.find((entry) =>
    entry.memberId === member.id
  );
  if (prior && !equal(prior, selected)) {
    refuse("member already selected a different successor");
  }
  const exactTarget = !!state.executionModel &&
    equal({
      identity: state.executionModel.identity,
      version: state.executionModel.version,
    }, transition.manifest.to);
  const replayTarget = !!prior && !!catalogReplay &&
    equal(catalogReplay.from, transition.manifest.to) &&
    equal(catalogReplay.to, {
      identity: state.executionModel?.identity,
      version: state.executionModel?.version,
    }) &&
    equal(catalogReplay.businessRevision, runtimeRevisionReference(state)) &&
    transition.manifest.family.candidateProofs.some((candidate) =>
      candidate.id === catalogReplay.candidateId &&
      candidate.digest === catalogReplay.candidateDigest
    );
  const authorization = state.events.find((event) =>
    event.id === transition.manifest.authorizationEventId
  );
  if (
    !state.executionModel || !exactTarget && !replayTarget ||
    !equal(
      authorization?.authorityExercise,
      exerciseOwnerAuthority({
        identity: transition.manifest.from.identity,
        version: transition.manifest.from.version,
        ownerAuthority: ownerAuthorityFor(state.executionModel),
      }, "model-adoption"),
    ) ||
    !equal(
      authorization?.modelAdoptionAuthorization?.target,
      transition.manifest.to,
    ) ||
    authorization?.modelAdoptionAuthorization?.budgetCeilingManifestDigest !==
      transition.manifestDigest ||
    receipt.source.checkpointNamespace !== member.checkpointNamespace ||
    receipt.source.preparedNodeId !== member.preparedNodeId ||
    evidence.authorizationEventId !== authorization?.id ||
    evidence.memberId !== member.id ||
    evidence.resume.id !== transition.resume?.contributionId ||
    evidence.resume.inputMessageId !== transition.manifest.family.inputMessageId
  ) {
    refuse(
      "selected native receipt no longer has its exact current owner, target or resume",
    );
  }
  if (!prior) transition.selected.push(selected);
  if (
    transition.manifest.members.every((entry) =>
      transition.selected.some((selected) => selected.memberId === entry.id)
    )
  ) transition.phase = "complete";
}

/** Only an already-recorded exact selection may follow its own verified
 * catalog publication. The restored source model comes from the fenced ledger;
 * current canonical admission/event readback is independently recalculated. */
export async function budgetContinuationReplayEvidence(
  state: SystemRuntimeState,
  receipt: NativeContinuationReceipt,
  restoredSource: ExecutableModel,
): Promise<NativeCatalogAdvanceEvidence | undefined> {
  const evidence = receipt.evidence;
  if (evidence.kind !== "verified-budget-ceiling-advance") return undefined;
  const transition = state.budgetCeilingTransition;
  if (!transition || !state.executionModel) {
    refuse("budget replay has no canonical intention");
  }
  if (
    equal({
      identity: state.executionModel.identity,
      version: state.executionModel.version,
    }, transition.manifest.to)
  ) return undefined;
  const recorded = transition.selected.find((selected) =>
    selected.memberId === evidence.memberId
  );
  if (
    !recorded || recorded.receiptId !== receipt.id ||
    recorded.successorRunId !== receipt.successorRunId ||
    !equal({
      identity: restoredSource.identity,
      version: restoredSource.version,
    }, transition.manifest.to)
  ) {
    refuse(
      "only an exact recorded selection may follow its own catalog publication",
    );
  }
  const catalog = await nativeCatalogAdvanceEvidence(restoredSource, state);
  if (
    !catalog ||
    !transition.manifest.family.candidateProofs.some((candidate) =>
      candidate.id === catalog.candidateId &&
      candidate.digest === catalog.candidateDigest
    )
  ) refuse("catalog publication is outside the retained budget family");
  return catalog;
}

/** The conversation successor reaches its own suspended admission through the
 * ordinary promotion port; selecting the parent never authorizes an effect. */
export function budgetPromotionPendingSelection(
  state: SystemRuntimeState,
  candidateId: string,
): boolean {
  const transition = state.budgetCeilingTransition;
  const candidate = state.candidates.find((candidate) =>
    candidate.id === candidateId
  );
  const active = activeBatchCall(state);
  if (
    !transition?.resume ||
    transition.phase !== "adopted-continuations-pending" ||
    state.budgetSuspension?.candidateId !== candidateId ||
    state.budgetSuspension.reason !== "exhausted" ||
    state.budgetSuspension.dispatchStarted !== false ||
    state.budgetSuspension.attemptId !==
      transition.manifest.budget.refusedAttemptId ||
    !candidate || state.budgetPromotionCandidateId !== candidateId ||
    (transition.manifest.family.scalarProposal
      ? !!active || !!candidate.batchCall ||
        transition.manifest.family.scalarProposal.candidateId !== candidateId ||
        transition.manifest.family.scalarProposal.draftDigest !==
          candidate.digest ||
        transition.manifest.family.scalarProposal.childSubjectId !==
          candidate.promotionExecution?.subjectId
      : !active || active.call.candidateId !== candidateId ||
        !equal(candidate.batchCall, {
          batchId: active.batch.id,
          callId: active.call.id,
        }) ||
        active.batch.inputMessageId !==
          transition.manifest.family.inputMessageId)
  ) return false;
  const parent = transition.manifest.members.find((member) =>
    member.identity.purpose === "conversation"
  );
  const child = transition.manifest.members.find((member) =>
    member.identity.purpose === "promotion" &&
    member.identity.subjectId === candidate.promotionExecution?.subjectId
  );
  const scalar = transition.manifest.family.scalarProposal;
  return !!parent && !!child &&
    (!scalar ||
      scalar.parentMemberId === parent.id &&
        scalar.childMemberId === child.id &&
        candidate.promotionExecution?.threadId === child.threadId) &&
    transition.selected.some((selected) => selected.memberId === parent.id) &&
    !transition.selected.some((selected) => selected.memberId === child.id);
}

/** Narrow historical equivalence: exact retained object + proof bytes + owner
 * ceiling lineage. Business records and their historical digests are untouched. */
export async function budgetCeilingModelEquivalent(
  state: SystemRuntimeState,
  oldDigest: string,
  targetDigest: string,
  retained: { batchId?: string; candidateId?: string },
  history?: RuntimeStateHistoryPort,
): Promise<boolean> {
  const transition = state.budgetCeilingTransition;
  if (
    !transition ||
    !["adopted-continuations-pending", "complete"].includes(transition.phase) ||
    transition.manifest.from.version.digest !== oldDigest ||
    transition.manifest.to.version.digest !== targetDigest ||
    transition.manifestDigest !== await executionDigest(transition.manifest) ||
    !state.executionModel
  ) return false;
  if (
    await budgetCeilingContractDigest(state.executionModel) !==
      transition.manifest.unchangedContractDigest
  ) {
    const acceptedRef = transition.resume?.acceptedRevision
      .__assemblyRuntimeRevision;
    if (
      !history || !acceptedRef || acceptedRef.systemId !== state.id ||
      acceptedRef.operatorId !== transition.manifest.to.identity.builderId ||
      acceptedRef.modelDigest !== transition.manifest.to.version.digest ||
      acceptedRef.invocationKey !== transition.manifest.family.invocationKey
    ) return false;
    const accepted = await history.loadRevision(acceptedRef.revision);
    if (
      !accepted?.executionModel || accepted.id !== acceptedRef.systemId ||
      accepted.revision !== acceptedRef.revision ||
      !equal({
        identity: accepted.executionModel.identity,
        version: accepted.executionModel.version,
      }, transition.manifest.to) ||
      await budgetCeilingContractDigest(accepted.executionModel) !==
        transition.manifest.unchangedContractDigest
    ) return false;
    // Compose only this ceiling's exact adopted contract and one real, separately
    // admitted publication of its retained family. No catalog or digest bypass.
    try {
      const catalog = await nativeCatalogAdvanceEvidence(
        accepted.executionModel,
        state,
      );
      if (
        !catalog ||
        !transition.manifest.family.candidateProofs.some((candidate) =>
          candidate.id === catalog.candidateId &&
          candidate.digest === catalog.candidateDigest
        )
      ) return false;
    } catch {
      return false;
    }
  }
  const purpose = retained.batchId !== undefined ? "conversation" : "promotion";
  if (
    !transition.manifest.members.some((member) =>
      member.identity.purpose === purpose &&
      transition.selected.some((selected) => selected.memberId === member.id)
    )
  ) return false;
  if (retained.batchId !== undefined) {
    return transition.manifest.family.batchIds.includes(retained.batchId) &&
      !!state.conversationBatches?.some((batch) =>
        batch.id === retained.batchId &&
        batch.inputMessageId === transition.manifest.family.inputMessageId &&
        batch.modelDigest === oldDigest
      );
  }
  const proof = transition.manifest.family.candidateProofs.find((proof) =>
    proof.id === retained.candidateId
  );
  const candidate = state.candidates.find((candidate) =>
    candidate.id === retained.candidateId
  );
  return !!proof && !!candidate && proof.digest === candidate.digest &&
    proof.proofDigest === await budgetCandidateProofDigest(candidate);
}

export interface BudgetCeilingAdoptionHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    model: {
      readExecutableModel(
        identity: ExecutableModel["identity"],
        version?: string,
      ): Promise<ExecutableModel>;
    };
    execution?: import("./execution.ts").NativeExecutionPort;
    workBudget?: import("../budget/ports.ts").WorkBudgetPort;
    clock: { now(): string };
  };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  assertBudgetCeilingAdmission?(): Promise<void>;
}

/** Called inside the existing serialized local-owner control. Each successful
 * save is independently replayable; no cross-store atomicity is implied. */
export async function adoptBudgetCeiling(
  host: BudgetCeilingAdoptionHost,
  target: ExecutableModel,
  recoveryReason?: string,
): Promise<void> {
  if (recoveryReason !== undefined) {
    refuse("recoveryReason cannot replace the prior owner authority");
  }
  await host.assertBudgetCeilingAdmission?.();
  const budget = host.ports.workBudget;
  if (!budget?.readRecord || !budget.advanceCeiling || !host.ports.execution) {
    refuse("durable budget continuation capabilities are unavailable");
  }
  let transition = host.state.budgetCeilingTransition;
  if (!transition || transition.phase === "complete") {
    const previous = host.state.executionModel!;
    if (!previous.version.repositoryVersion) {
      refuse("exact previous source pin is missing");
    }
    const source = await host.ports.model.readExecutableModel(
      previous.identity,
      previous.version.repositoryVersion,
    );
    if (!equal(source, previous)) {
      refuse("exact previous source contract is unavailable");
    }
    const scopeId = host.state.workBudgetBinding?.scopeId;
    if (!scopeId) refuse("previous budget binding is missing");
    const id = `budget-ceiling:${crypto.randomUUID()}`;
    const authorizationEventId = `model-version-admission-authorized:${id}`;
    transition = await planBudgetCeilingTransition({
      state: host.state,
      previous: source,
      target,
      record: await budget.readRecord(scopeId, previous.identity.builderId),
      snapshots: await host.ports.execution.inspect(
        previous.identity.builderId,
      ),
      id,
      authorizationEventId,
    });
    const intent = structuredClone(transition);
    await host.update((state) => {
      if (
        state.budgetCeilingTransition &&
        state.budgetCeilingTransition.phase !== "complete"
      ) refuse("another intention already owns the canonical freeze");
      state.budgetCeilingTransition = intent;
      state.events.push({
        id: authorizationEventId,
        at: host.ports.clock.now(),
        kind: "model-version-admission-authorized",
        label: "Local owner authorized an exact budget ceiling continuation",
        authorityExercise: exerciseOwnerAuthority(source, "model-adoption"),
        modelAdoptionAuthorization: {
          target: structuredClone(intent.manifest.to),
          budgetCeilingManifestDigest: intent.manifestDigest,
        },
      });
    });
  }
  const { manifest } = transition;
  if (
    !equal({ identity: target.identity, version: target.version }, manifest.to)
  ) refuse("another target cannot overwrite the durable intention");
  // Recover exact immutable sources on every phase, including after policy CAS.
  const previous = await host.ports.model.readExecutableModel(
    manifest.from.identity,
    manifest.from.version.repositoryVersion,
  );
  const actualTarget = await host.ports.model.readExecutableModel(
    manifest.to.identity,
    manifest.to.version.repositoryVersion,
  );
  if (
    !equal(
      { identity: previous.identity, version: previous.version },
      manifest.from,
    ) || !equal(actualTarget, target) ||
    await requireStrictBudgetCeilingIncrease(previous, target) !==
      manifest.unchangedContractDigest
  ) refuse("source or target changed during recovery");
  let record = await budget.readRecord(
    manifest.budget.scopeId,
    manifest.budget.ownerId,
  );
  await validateBudgetCeilingTransition(host.state, record);
  if (transition.phase === "complete") return;
  if (
    transition.phase === "adopted-continuations-pending" &&
    transition.blockedReason
  ) {
    await host.update((state) => {
      delete state.budgetCeilingTransition!.blockedReason;
    });
  }
  if (
    transition.phase === "authorized-intent" ||
    transition.phase === "budget-policy"
  ) {
    if (
      await executionDigest(
        retainedWork(host.state, manifest.family.inputMessageId),
      ) !== manifest.family.retainedWorkDigest
    ) refuse("retained work changed before adoption");
    const snapshots = await host.ports.execution.inspect(
      manifest.from.identity.builderId,
    );
    for (const member of manifest.members) {
      const snapshot = snapshots.find((entry) =>
        entry.threadId === member.threadId && entry.runId === member.runId
      );
      await verifyBudgetCeilingMemberSnapshot(manifest, member, snapshot);
    }
    if (
      snapshots.some((snapshot) =>
        snapshot.status !== "completed" &&
        !completedHistoricalBudgetAwait(host.state, snapshot) &&
        !manifest.members.some((member) =>
          member.threadId === snapshot.threadId
        )
      )
    ) refuse("unrelated native work appeared during adoption");
    record = await budget.advanceCeiling({
      scopeId: manifest.budget.scopeId,
      ownerId: manifest.budget.ownerId,
      previousPolicy: manifest.budget.previousPolicy,
      policy: manifest.budget.policy,
      modelVersion: manifest.to.version,
      transitionId: manifest.id,
      manifestDigest: transition.manifestDigest,
      expectedRevision: manifest.budget.originRevision,
      expectedDigest: manifest.budget.originDigest,
    });
    const policyRecord = {
      ...record,
      revision: manifest.budget.originRevision + 1,
      events: record.events.slice(0, manifest.budget.originRevision + 1),
    };
    const receipt = {
      revision: policyRecord.revision,
      digest: await executionDigest(policyRecord),
    };
    await host.update((state) => {
      const current = state.budgetCeilingTransition!;
      if (current.manifestDigest !== transition!.manifestDigest) {
        refuse("canonical intention changed after budget CAS");
      }
      current.policyReceipt = receipt;
      current.phase = "budget-policy";
    });
    await host.assertBudgetCeilingAdmission?.();
    await validateBudgetCeilingTransition(host.state, record);
    const { effectiveModelUpdate } = await import(
      "../../../domain/work/records/effective-model-update.ts"
    );
    await host.update((state) => {
      const current = state.budgetCeilingTransition!;
      const member = manifest.members.find((member) =>
        member.identity.purpose === "conversation"
      )!;
      const scope = member.identity.scope;
      const update = effectiveModelUpdate(state.executionModel, target, {
        journalId: state.id,
        journalPosition: state.events.length,
        activatedAt: host.ports.clock.now(),
        origin: scope.kind === "request"
          ? { caseId: scope.scopeId }
          : { designerScopeId: scope.scopeId },
      });
      state.executionModel = structuredClone(target);
      state.model = structuredClone(target.identity);
      state.configuration = {
        ...structuredClone(target.configuration),
        changes: structuredClone(state.configuration?.changes ?? []),
      };
      state.ownerAuthority = structuredClone(ownerAuthorityFor(target));
      state.workBudget = budgetState(record).view;
      // Cursor, batch, candidate proof and Case birth pins deliberately survive.
      current.phase = "adopted-continuations-pending";
      delete current.blockedReason;
      delete state.availableExecutionModel;
      if (update && !state.events.some((event) => event.id === update.id)) {
        state.events.push({
          id: update.id,
          at: update.activatedAt,
          kind: "effective-model-updated",
          label: "Model updated",
          effectiveModelUpdate: update,
          ...(update.caseId ? { caseId: update.caseId } : {}),
        });
      }
      const admittedId = `model-version-admitted:${manifest.id}`;
      if (!state.events.some((event) => event.id === admittedId)) {
        state.events.push({
          id: admittedId,
          at: host.ports.clock.now(),
          kind: "model-version-admitted",
          label:
            "Exact budget ceiling admitted; unfinished continuations retained",
        });
      }
    });
  }
}

export function assertBudgetResumeAdmission(state: SystemRuntimeState, input: {
  origin?: "human" | "delegation";
  caseId?: string;
  newConversation?: true;
}): void {
  const transition = state.budgetCeilingTransition;
  if (!transition || transition.phase === "complete") return;
  const conversation = transition.manifest.members.find((member) =>
    member.identity.purpose === "conversation"
  )!;
  if (
    transition.blockedReason ||
    transition.phase !== "adopted-continuations-pending" ||
    input.origin !== "human" || input.newConversation ||
    transition.resume ||
    (conversation.identity.scope.kind === "request"
      ? input.caseId !== conversation.identity.scope.scopeId
      : input.caseId !== undefined)
  ) {
    refuse(
      "only the recorded family's subsequent authenticated input may resume",
    );
  }
}

export async function bindBudgetResume(
  state: SystemRuntimeState,
  delivery: import("../operators/execution.ts").OperatorExecutionDelivery,
): Promise<boolean> {
  const transition = state.budgetCeilingTransition;
  if (
    !transition ||
    transition.phase === "complete" &&
      transition.resume?.contributionId !== delivery.id
  ) return false;
  if (!transition.resume) {
    assertBudgetResumeAdmission(state, {
      origin: delivery.payload?.origin as "human" | "delegation",
      ...(delivery.payload?.caseId !== undefined
        ? { caseId: String(delivery.payload.caseId) }
        : {}),
      ...(delivery.payload?.newConversation ? { newConversation: true } : {}),
    });
  }
  const member = transition.manifest.members.find((entry) =>
    entry.identity.purpose === "conversation"
  )!;
  const digest = await executionDigest(delivery);
  if (
    delivery.kind !== "contribution" || delivery.payload?.origin !== "human" ||
    delivery.payload.work ||
    delivery.identity.invocationKey !==
      transition.manifest.family.invocationKey ||
    !equal(delivery.identity.scope, member.identity.scope) ||
    delivery.identity.operatorId !== member.identity.operatorId ||
    delivery.identity.subjectId !== delivery.id ||
    delivery.modelPin.modelDigest !== transition.manifest.to.version.digest ||
    delivery.modelPin.repositoryVersion !==
      transition.manifest.to.version.repositoryVersion ||
    transition.resume &&
      (transition.resume.contributionId !== delivery.id ||
        transition.resume.deliveryDigest !== digest)
  ) refuse("accepted input is outside the exact budget family");
  transition.resume ??= {
    contributionId: delivery.id,
    inputMessageId: delivery.id,
    deliveryDigest: digest,
    acceptedRevision: {
      __assemblyRuntimeRevision: {
        ...runtimeRevisionReference(state).__assemblyRuntimeRevision,
        revision: state.revision + 1,
      },
    },
  };
  return true;
}

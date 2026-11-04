import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { WorkBudgetRecord } from "../../../domain/work/policies/budget.ts";
import type {
  BudgetCeilingManifest,
  BudgetCeilingMember,
} from "../../../domain/work/records/budget-ceiling-transition.ts";
import type {
  NativeExecutionRequest,
  NativeExecutionSnapshot,
  NativeModelAdvanceEvidence,
  RuntimeRevisionReference,
} from "./contract.ts";
import {
  nativeBudgetCeilingAdvanceEvidence,
  validateNativeBudgetCeilingAdvance,
} from "../runtime/budget-transition.ts";
import { immutablePin } from "./encodings.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { draftDigest, valueDigest } from "../runtime/values.ts";
import {
  budgetSourceFromWait,
  effectResultDigest,
  type NativeWaitEvidence,
} from "./wait-evidence.ts";

/** Bounded projection of a scalar proposal from its official prepared checkpoint
 * and completed effect. A request digest alone does not bind action inputs. */

export interface BudgetProposalCheckpoint {
  request: NativeExecutionRequest;
  snapshot: NativeExecutionSnapshot;
  wait: NativeWaitEvidence;
  contributionConsumed: boolean;
  effect?: {
    runId: unknown;
    contributionId: unknown;
    nodeId: unknown;
    status: unknown;
    result: unknown;
  };
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function refuse(): never {
  throw new Error(
    "BUDGET_CEILING_CONTINUATION_REFUSED: scalar proposal checkpoint or receipt differs",
  );
}

async function verifyCheckpoint(
  source: BudgetProposalCheckpoint,
): Promise<void> {
  const { request, snapshot, wait, effect } = source;
  const node = request.flow.nodes.find((node) => node.id === wait.nodeId);
  const projected = budgetSourceFromWait(wait);
  if (
    !node || !projected ||
    projected.sourceKind !== "settled-budget-wait" ||
    snapshot.status !== "waiting" || snapshot.unsettledEffects.length ||
    !snapshot.runId || !snapshot.checkpointId ||
    snapshot.checkpointNamespace === undefined ||
    !equal(snapshot.identity, request.identity) ||
    snapshot.contributionId !== request.contribution.id ||
    snapshot.modelDigest !== request.model.version.digest ||
    snapshot.repositoryVersion !== request.model.version.repositoryVersion ||
    snapshot.flowRootId !== request.flow.rootNativeId ||
    !equal(wait.modelPin, {
      identity: request.model.identity,
      version: request.model.version,
      rootNativeId: request.flow.rootNativeId,
      rootOccurrenceId: request.flow.rootOccurrenceId,
      ...(request.flow.executionProfile
        ? { executionProfile: request.flow.executionProfile }
        : {}),
    }) ||
    !equal(wait.executionScope, request.identity.scope) ||
    wait.operatorId !== request.identity.operatorId ||
    !source.contributionConsumed ||
    !equal(projected, snapshot.budgetContinuationSource) ||
    !effect || effect.status !== "completed" ||
    effect.runId !== snapshot.runId ||
    effect.contributionId !== snapshot.contributionId ||
    effect.nodeId !== node.nativeId ||
    !effect.result || typeof effect.result !== "object"
  ) refuse();
  const { localState: _local, ...result } = effect.result as Record<
    string,
    unknown
  >;
  if (
    await effectResultDigest(result) !== wait.resultDigest ||
    result.suspend !== true ||
    result.suspensionKind !== "budget" || result.modelAdvance
  ) refuse();
}

export async function nativeScalarBudgetProposal(
  source: BudgetProposalCheckpoint,
): Promise<NonNullable<NativeExecutionSnapshot["scalarBudgetProposal"]>> {
  await verifyCheckpoint(source);
  const { request, wait } = source;
  const node = request.flow.nodes.find((node) => node.id === wait.nodeId);
  const choice = wait.inputs.choice as ChatDecision | undefined;
  if (
    request.identity.purpose !== "conversation" ||
    node?.mechanism !== "submit_proposal" || choice?.kind !== "propose_tool" ||
    !choice.tool || typeof choice.text !== "string"
  ) refuse();
  const digest = await draftDigest(choice.tool);
  return {
    decisionDigest: await executionDigest(choice),
    draftDigest: digest,
    childSubjectId: await valueDigest({
      input: request.contribution.id,
      batch: undefined,
      draft: digest,
    }),
    effectResultDigest: await executionDigest(source.effect!.result),
  };
}

/** Re-read both historical source tuples at every fork/selection boundary, even
 * after the parent has already selected its successor. */
export async function verifyScalarBudgetFamily(
  manifest: BudgetCeilingManifest,
  read: (
    member: BudgetCeilingManifest["members"][number],
  ) => Promise<BudgetProposalCheckpoint>,
): Promise<void> {
  const proof = manifest.family.scalarProposal;
  if (!proof) return;
  const parent = manifest.members.find((member) =>
    member.id === proof.parentMemberId
  );
  const child = manifest.members.find((member) =>
    member.id === proof.childMemberId
  );
  if (
    !parent || !child || parent.identity.purpose !== "conversation" ||
    child.identity.purpose !== "promotion"
  ) refuse();
  const parentSource = await read(parent), childSource = await read(child);
  const projected = await nativeScalarBudgetProposal(parentSource);
  await verifyCheckpoint(childSource);
  const {
    parentMemberId: _parent,
    childMemberId: _child,
    candidateId: _candidate,
    ...expected
  } = proof;
  if (
    !equal(projected, expected) ||
    !equal(parentSource.request.identity, parent.identity) ||
    !equal(childSource.request.identity, child.identity) ||
    childSource.wait.promotionId !== proof.candidateId ||
    child.identity.subjectId !== proof.childSubjectId ||
    parentSource.request.contribution.inputMessageId !==
      manifest.family.inputMessageId ||
    childSource.request.contribution.inputMessageId !==
      manifest.family.inputMessageId ||
    child.contributionId !== parent.contributionId ||
    !equal({
      identity: parentSource.request.model.identity,
      version: parentSource.request.model.version,
    }, manifest.from) ||
    !equal({
      identity: childSource.request.model.identity,
      version: childSource.request.model.version,
    }, manifest.from)
  ) refuse();
}

export interface RetainedBudgetIntent {
  readonly evidence: NativeModelAdvanceEvidence;
  readonly evidenceDigest: unknown;
  readonly sourceCheckpointNamespace: unknown;
  readonly sourceCheckpointId: unknown;
  readonly preparedNodeId: unknown;
  readonly settledEffectKey: unknown;
}
export interface BudgetContinuationReader {
  intent(): Promise<RetainedBudgetIntent | undefined>;
  businessRevision(
    reference: RuntimeRevisionReference,
  ): Promise<SystemRuntimeState>;
  currentBusiness(): Promise<SystemRuntimeState>;
}
export async function retainedBudgetAdvanceEvidence(
  current: SystemRuntimeState,
  budget: WorkBudgetRecord,
  memberId: string,
  member: BudgetCeilingMember,
  incoming: NativeExecutionRequest,
  manifest: BudgetCeilingManifest,
  read: BudgetContinuationReader,
) {
  let evidence = await nativeBudgetCeilingAdvanceEvidence(
    current,
    budget,
    memberId,
    incoming.contribution,
  );
  // An interrupted fork already owns a content-addressed intent. Rebuild its
  // evidence against its accepted historical revision instead of minting a
  // second receipt merely because recovery advanced the business revision.
  const intent = await read.intent();
  if (intent) {
    const retained = intent.evidence;
    if (
      retained.kind !== "verified-budget-ceiling-advance" ||
      intent.evidenceDigest !== await executionDigest(retained) ||
      intent.sourceCheckpointNamespace !== member.checkpointNamespace ||
      intent.sourceCheckpointId !== member.checkpointId ||
      intent.preparedNodeId !== member.preparedNodeId ||
      intent.settledEffectKey !== member.settledEffectKey
    ) {
      throw new Error("Retained budget continuation intent changed");
    }
    const accepted = await read.businessRevision(retained.businessRevision);
    await validateNativeBudgetCeilingAdvance(
      retained,
      accepted,
      budget,
      incoming.identity,
      incoming.contribution,
    );
    evidence = retained;
  } else {
    await validateNativeBudgetCeilingAdvance(
      evidence,
      current,
      budget,
      incoming.identity,
      incoming.contribution,
    );
  }
  const latest = await read.currentBusiness();
  const latestEvidence = await nativeBudgetCeilingAdvanceEvidence(
    latest,
    budget,
    memberId,
    incoming.contribution,
  );
  const { businessRevision: _historicalRevision, ...historicalProof } =
    evidence;
  const { businessRevision: _latestRevision, ...latestProof } = latestEvidence;
  if (canonical(historicalProof) !== canonical(latestProof)) {
    throw new Error(
      "Current budget continuation differs from the accepted resume",
    );
  }
  if (
    canonical(evidence.from) !== canonical(manifest.from) ||
    canonical(evidence.to) !== canonical(manifest.to)
  ) {
    throw new Error("Budget continuation evidence pin changed");
  }

  return evidence;
}

export function scalarBudgetSourceRequest(
  member: BudgetCeilingMember,
  source: {
    businessRevision: RuntimeRevisionReference;
    contribution: NativeExecutionRequest["contribution"];
  },
  historical: SystemRuntimeState,
  pinJson: string,
): NativeExecutionRequest {
  const model = historical.executionModel!, pin = JSON.parse(pinJson);
  const flow = Object.values(model.flows).find((flow) =>
    flow.rootNativeId === pin.flowRootId &&
    flow.rootOccurrenceId === pin.flowOccurrenceId
  );
  if (!flow) throw new Error("Scalar budget source flow is unavailable");
  const request: NativeExecutionRequest = {
    identity: structuredClone(member.identity),
    contribution: source.contribution,
    businessRevision: source.businessRevision,
    model,
    flow,
    maxSteps: pin.maxSteps,
  };
  if (immutablePin(request) !== pinJson) {
    throw new Error("Scalar budget source pin changed");
  }

  return request;
}

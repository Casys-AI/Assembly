/** Bounded projection of a scalar proposal from its official prepared checkpoint
 * and completed effect. A request digest alone does not bind action inputs. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  draftDigest,
  valueDigest,
} from "../../../application/work/runtime/values.ts";
import type { ChatDecision } from "../../../domain/work/dialogue.ts";
import type {
  NativeExecutionRequest,
  NativeExecutionSnapshot,
} from "../../../application/work/runtime/execution.ts";
import type { BudgetCeilingManifest } from "../../../domain/work/records/budget-ceiling-transition.ts";
import {
  budgetSourceFromWait,
  effectResultDigest,
  type NativeWaitEvidence,
} from "./checkpoint-wait-evidence.ts";

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

import type { Case } from "../../domain/work/entities/cases.ts";
import type {
  CaseInvocation,
  OperatorWorkReceipt,
} from "../../domain/work/execution/case-context.ts";
import type {
  PendingChange,
} from "../../domain/governance/records/pending-change.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import {
  type AuthorityRouteCode,
  MAIN_EXECUTION_SPACE_ID,
  OperatorAuthorityError,
  type OperatorNotice,
  type RequestAuthorityRoute,
} from "../../domain/governance/operator-authority.ts";
import { type ExecutionSpaceRef } from "../../domain/governance/authority.ts";
import { delegatedAuthorityExercise } from "../../domain/governance/policies/operator-authority-policy.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import {
  changeWorkReceipt,
  invocationKey,
  isLocalRequestInput,
  workReceipt,
} from "../work/operators/journal.ts";

/** The final link of a segment: today's local opener in main, or the verified
 * opening of a Request branch whose parent is MO@main. Only the bridge verifies
 * an opening proof; routing receives it already checked. */
type RequestAuthorityRoot =
  | { kind: "main-opener"; mainOperatorId: string }
  | {
    kind: "verified-opening";
    openingId: string;
    parent: { space: ExecutionSpaceRef; state: SystemRuntimeState };
  };

/** Routing discovers an eligible decider; it never approves, invokes a provider, or grants rights. */
export function requestAuthorityRoute(input: {
  /** The segment: the requester and `states` live here. */
  space: ExecutionSpaceRef;
  requester: SystemRuntimeState;
  change: PendingChange;
  states: readonly SystemRuntimeState[];
  root: RequestAuthorityRoot;
}): RequestAuthorityRoute {
  const { space, requester, change, states } = input;
  const route: RequestAuthorityRoute = {
    version: 2,
    changeId: change.id,
    caseId: change.caseId ?? "",
    requestedBy: change.requestedBy ?? "",
    requester: scopedOperator(space, change.requestedBy ?? ""),
    ...(input.root.kind === "verified-opening"
      ? { openingId: input.root.openingId }
      : {}),
    targetOperatorId: change.requestedBy ?? "",
    baseRevision: change.baseRevision,
    modelDigest: change.baseModelDigest ?? "",
    status: "needs-resolution",
    trace: [],
  };
  const unresolved = (code: AuthorityRouteCode, reason: string) => ({
    ...route,
    status: "needs-resolution" as const,
    code,
    reason,
  });
  const model = requester.executionModel;
  if (
    !model || !change.caseId || change.designerScopeId ||
    change.requestedBy !== model.identity.builderId ||
    change.status !== "pending"
  ) {
    return unresolved(
      "CHANGE_NOT_PENDING",
      "The exact pending Request change and its admitted model must be restored",
    );
  }
  if (
    change.baseRevision !== requester.configuration?.revision ||
    !change.baseModelDigest || change.baseModelDigest !== model.version.digest
  ) {
    return unresolved(
      "CHANGE_STALE",
      "The proposal is stale; re-propose on the current revision",
    );
  }
  const records = states.flatMap((state) =>
    (state.cases ?? []).filter((record) =>
      record.id === change.caseId &&
      record.owner === state.executionModel?.identity.builderId
    )
  );
  if (records.length !== 1) {
    return unresolved(
      "CHAIN_UNVERIFIED",
      "The Request has no unique verified owner",
    );
  }
  const root = records[0];
  if (root.status.startsWith("closed-")) {
    return unresolved("CHANGE_NOT_PENDING", "The Request is closed");
  }
  const byId = new Map(
    states.map((state) => [state.executionModel?.identity.builderId, state]),
  );
  if (byId.size !== states.length || byId.has(undefined)) {
    return unresolved("CHAIN_UNVERIFIED", "Operator identities conflict");
  }
  // Main-local teams are bound to the exact Case. Branch membership has
  // already been verified against the opening roster by the bridge.
  const belongsToRequest = (state: SystemRuntimeState) =>
    input.root.kind !== "main-opener" ||
    !state.executionModel?.operatorTeam ||
    state.executionModel.operatorTeam.requestId === root.id;
  if (!belongsToRequest(requester)) {
    return unresolved(
      "CHAIN_UNVERIFIED",
      "Source membership belongs to another Request",
    );
  }
  const sameRoot = (record: Case | undefined) =>
    !!record && record.id === root.id &&
    record.owner === root.owner && record.openedBy === root.openedBy &&
    record.number === root.number && record.type === root.type &&
    canonical(record.modelPin) === canonical(root.modelPin) &&
    canonical(record.openedFrom) === canonical(root.openedFrom);
  // Instances, not native IDs: a BO shares its MO's native ID.
  const instance = (hop: ExecutionSpaceRef, operatorId: string) =>
    `${hop.executionSpaceId}\u0000${operatorId}`;
  const seen = new Set<string>([instance(space, change.requestedBy)]);
  let receipt: OperatorWorkReceipt | undefined = changeWorkReceipt(
    requester,
    change,
  );
  let child = requester;
  if (requester.changeWorkContinuations?.[change.id] && !receipt) {
    return unresolved(
      "CHAIN_UNVERIFIED",
      "The proposal's exact delegated work receipt is missing",
    );
  }
  if (!receipt && change.requestedBy !== root.owner) {
    return unresolved(
      "CHAIN_UNVERIFIED",
      "The proposal has no verified direct responsible operator",
    );
  }
  let actorId = receipt?.callerId;
  let atRoot = !receipt;
  // Only a verified local Request reaches the final link. Source team metadata
  // corroborates a receipt; it cannot fill a missing invocation or confer a grant.
  for (let depth = 0; depth <= states.length; depth++) {
    if (!atRoot && receipt?.mainOrder) {
      const parent = input.root.kind === "verified-opening"
        ? input.root.parent
        : undefined;
      const parentModel = parent?.state.executionModel;
      const team = child.executionModel?.operatorTeam;
      if (
        !parentModel || input.root.kind !== "verified-opening" ||
        receipt.mainOrder.openingId !== input.root.openingId ||
        receipt.caseId !== root.id || !sameRoot(receipt.caseContext?.record) ||
        receipt.callerId !== parentModel.identity.builderId ||
        canonical(receipt.mainOrder.caller) !== canonical(scopedOperator(
            parent!.space,
            parentModel.identity.builderId,
          )) ||
        !team ||
        team.requestOwnerId !== root.owner
      ) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "The Main order has no verified crossing into this Request",
        );
      }
      // The actual caller is Main@main, even when BO@branch has the same native ID.
      atRoot = true;
    }
    let hop = { space, state: actorId ? byId.get(actorId) : undefined };
    const crossed = atRoot && input.root.kind === "verified-opening";
    if (atRoot) {
      if (input.root.kind === "verified-opening") {
        // The branch Case is opened by the person: its final link is the
        // verified opening, and the next hop is MO@main with main's policies.
        if (root.openedFrom.openingId !== input.root.openingId) {
          return unresolved(
            "CHAIN_UNVERIFIED",
            "The final link is not the verified opening",
          );
        }
        const parentModel = input.root.parent.state.executionModel;
        if (!parentModel) {
          return unresolved(
            "MAIN_UNAVAILABLE",
            "Main is unavailable; availability is not absence of authority",
          );
        }
        hop = input.root.parent;
        actorId = parentModel.identity.builderId;
      } else {
        const { mainOperatorId } = input.root;
        if (
          root.openedBy !== mainOperatorId || root.openedBy === root.owner ||
          (!root.openedFrom.changeId && !root.openedFrom.openingId)
        ) {
          return unresolved(
            "CHAIN_UNVERIFIED",
            "The final Main opening link is not verified",
          );
        }
        const main = byId.get(mainOperatorId);
        if (
          !main || root.openedFrom.conversationId !== main.id ||
          (!!root.openedFrom.caseId === !!root.openedFrom.designerScopeId) ||
          root.openedFrom.designerScopeId !== undefined &&
            root.openedFrom.designerScopeId !== main.designer?.scopeId ||
          root.openedFrom.caseId !== undefined &&
            !(main.cases ?? []).some((record) =>
              record.id === root.openedFrom.caseId &&
              record.owner === mainOperatorId
            )
        ) {
          return unresolved(
            main ? "CHAIN_UNVERIFIED" : "MAIN_UNAVAILABLE",
            "The final Main conversation origin conflicts",
          );
        }
        actorId = mainOperatorId;
        hop = { space, state: main };
      }
    }
    if (!actorId || seen.has(instance(hop.space, actorId))) {
      return unresolved(
        "CHAIN_UNVERIFIED",
        "The responsible chain is missing or cyclic",
      );
    }
    seen.add(instance(hop.space, actorId));
    const actor = hop.state;
    if (!actor?.executionModel) {
      return unresolved(
        atRoot ? "MAIN_UNAVAILABLE" : "CHAIN_UNVERIFIED",
        "A responsible operator is unavailable; availability is not absence of authority",
      );
    }
    if (!belongsToRequest(actor)) {
      return unresolved(
        "CHAIN_UNVERIFIED",
        "Source membership belongs to another Request",
      );
    }
    if (!route.responsibleOperatorId) route.responsibleOperatorId = actorId;
    if (!atRoot) {
      if (
        !receipt || receipt.caseId !== root.id ||
        !sameRoot(receipt.caseContext?.record)
      ) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "The delegated work belongs to a missing or conflicting Request origin",
        );
      }
      const team = child.executionModel?.operatorTeam;
      if (
        team &&
        (team.parentOperatorId !== actorId ||
          team.requestOwnerId !== root.owner)
      ) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "Source membership conflicts with the actual caller receipt",
        );
      }
    }
    // Branch hops read the responsible actor's policy under the requester's
    // composite identity; the historical Main-local path keeps its own model.
    const policyModel = input.root.kind === "verified-opening" || crossed
      ? actor.executionModel
      : model;
    if (input.root.kind === "verified-opening" && !crossed) {
      hop = {
        state: actor,
        space: {
          projectId: policyModel.identity.projectId,
          systemId: policyModel.identity.systemId,
          executionSpaceId: space.executionSpaceId,
        },
      };
    }
    if (!Array.isArray(policyModel.operatorAuthorityPolicies ?? [])) {
      return unresolved(
        crossed ? "MAIN_POLICY_UNREADABLE" : "CHAIN_UNVERIFIED",
        "The responsible operator's current policy is unreadable",
      );
    }
    let eligible: {
      operatorId: string;
      executionSpaceId: string;
      policyId: string;
      policyRevision: number;
    } | undefined;
    for (const policy of policyModel.operatorAuthorityPolicies ?? []) {
      if (policy.holderNativeId !== actorId) continue;
      try {
        delegatedAuthorityExercise({
          target: model,
          targetSpace: space,
          policyModel,
          space: hop.space,
          change,
          command: {
            actorId,
            policyId: policy.id,
            policyRevision: policy.revision,
          },
        });
        eligible = {
          operatorId: actorId,
          executionSpaceId: hop.space.executionSpaceId,
          policyId: policy.id,
          policyRevision: policy.revision,
        };
        break;
      } catch (error) {
        if (
          !(error instanceof OperatorAuthorityError) ||
          error.code !== "AUTHORITY_OUT_OF_BOUNDS" &&
            error.code !== "AUTHORITY_POLICY_STALE"
        ) {
          return unresolved(
            crossed ? "MAIN_POLICY_UNREADABLE" : "CHAIN_UNVERIFIED",
            "Authority evaluation failed; no human fallback was inferred",
          );
        }
      }
    }
    if (eligible) {
      route.trace.push({ ...eligible, eligibility: "eligible" });
      return {
        ...route,
        status: "actor-decision",
        designatedDecider: eligible,
      };
    }
    route.trace.push({
      operatorId: actorId,
      executionSpaceId: hop.space.executionSpaceId,
      eligibility: "not-covered",
    });
    if (atRoot) return { ...route, status: "human-decision" };
    const anchor = receipt!.parentInvocation;
    // The unique Request owner's own opening is a durable local boundary. Legacy
    // direct work can prove this boundary without reconstructing a selected parent.
    if (!anchor && actorId === root.owner) {
      atRoot = true;
      continue;
    }
    if (!anchor || anchor.operatorId !== actorId) {
      return unresolved(
        "CHAIN_UNVERIFIED",
        "The immutable parent invocation anchor is missing",
      );
    }
    const inputMessage = actor.messages.find((message) =>
      message.id === anchor.inputMessageId
    );
    if (!inputMessage || inputMessage.caseId !== root.id) {
      return unresolved(
        "CHAIN_UNVERIFIED",
        "The anchored parent input belongs to another Request",
      );
    }
    const parentReceipt = workReceipt(inputMessage);
    if (!parentReceipt) {
      const invocation: CaseInvocation = { kind: "local", caseId: root.id };
      if (
        actorId !== root.owner ||
        !isLocalRequestInput(actor, inputMessage, root.id) ||
        invocationKey(invocation) !== anchor.invocationKey
      ) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "The anchored parent is not the verified Request owner",
        );
      }
      atRoot = true;
    } else {
      if (!parentReceipt.caseContext || parentReceipt.caseId !== root.id) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "The anchored parent receipt has no Request scope",
        );
      }
      const invocation: CaseInvocation = {
        kind: "delegated",
        work: { ...parentReceipt, caseContext: parentReceipt.caseContext },
      };
      if (invocationKey(invocation) !== anchor.invocationKey) {
        return unresolved(
          "CHAIN_UNVERIFIED",
          "The parent invocation key conflicts with its receipt",
        );
      }
      receipt = parentReceipt;
      child = actor;
      actorId = parentReceipt.callerId;
    }
  }
  return unresolved(
    "CHAIN_UNVERIFIED",
    "The responsible chain exceeds the registered operator bound",
  );
}

/** Persist each checked responsible's trace without starting an operator turn. */
export async function deliverRequestAuthorityRoute(input: {
  /** The main space of the requester's model. */
  space: ExecutionSpaceRef;
  requester: SystemRuntimeState;
  change: PendingChange;
  states: readonly SystemRuntimeState[];
  mainOperatorId: string;
  /** `wake` starts the recipient's turn: only Main, when the route designates
   * it, and then in its current design conversation (as the branch bridge). */
  receive(
    operatorId: string,
    notice: OperatorNotice,
    origin: Case["openedFrom"],
    delivery: { wake: boolean },
  ): Promise<void>;
}): Promise<RequestAuthorityRoute> {
  const route = requestAuthorityRoute({
    ...input,
    root: { kind: "main-opener", mainOperatorId: input.mainOperatorId },
  });
  const roots = input.states.flatMap((state) =>
    (state.cases ?? []).filter((record) =>
      record.id === input.change.caseId &&
      record.owner === state.executionModel?.identity.builderId
    )
  );
  const root = roots.length === 1 ? roots[0] : undefined;
  const responsibleId = route.responsibleOperatorId ?? root?.owner ??
    input.change.requestedBy;
  const actionId = route.status === "actor-decision"
    ? route.designatedDecider!.operatorId
    : input.mainOperatorId;
  const recipients = new Set([
    ...(responsibleId ? [responsibleId] : []),
    ...route.trace.map((step) => step.operatorId),
    actionId,
  ]);
  const mainDecides = route.status === "actor-decision" &&
    route.designatedDecider?.executionSpaceId === MAIN_EXECUTION_SPACE_ID &&
    route.designatedDecider.operatorId === input.mainOperatorId;
  for (const operatorId of recipients) {
    const state = input.states.find((entry) =>
      entry.executionModel?.identity.builderId === operatorId
    );
    if (!state) continue; // Unavailability remains recorded as unresolved, never inferred authority.
    const wake = mainDecides && operatorId === input.mainOperatorId;
    await input.receive(
      operatorId,
      {
        kind: "authority-escalation",
        changeId: input.change.id,
        requestedBy: input.change.requestedBy ?? "",
        caseId: input.change.caseId ?? "",
        recipient: operatorId,
        changeKind: input.change.kind,
        ...(input.change.requestedRights
          ? { requestedRights: structuredClone(input.change.requestedRights) }
          : {}),
        decisionAuthority: route.status === "actor-decision"
          ? "operator"
          : route.status === "human-decision"
          ? "human"
          : "unresolved",
        reason: input.change.reason,
        route,
      },
      wake
        ? { conversationId: state.id, designerScopeId: state.designer?.scopeId }
        : operatorId === input.mainOperatorId
        ? root?.openedFrom ?? {
          conversationId: state.id,
          designerScopeId: state.designer?.scopeId,
        }
        : { conversationId: state.id, caseId: input.change.caseId },
      { wake },
    );
  }
  return route;
}

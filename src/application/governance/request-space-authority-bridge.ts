import type { SystemRuntime } from "../work/runtime/system.ts";
import { type Case, isOpenCase } from "../../domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../work/runtime/state.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import { OperatorAuthorityError } from "../../domain/governance/operator-authority-error.ts";
import {
  MAIN_EXECUTION_SPACE_ID,
  mainExecutionSpace,
  sameScopedOperator,
} from "../../domain/governance/authority.ts";
import {
  type AuthorityRouteCode,
  type OperatorNotice,
  type RequestAuthorityRoute,
} from "../../domain/governance/operator-authority.ts";
import type {
  ExecutionSpaceRef,
  ScopedOperatorRef,
} from "../../domain/governance/authority.ts";
import type { ChatContext } from "../work/conversation/chat-context.ts";
import type { ChatDecision } from "../work/conversation/chat-decision.ts";
import type { OperatorCommandOrigin } from "../work/operators/command-delivery.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { type OpeningRecord } from "../../domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../domain/work/request-spaces/scope.ts";
import { type SpaceExecutionAdmission } from "../../domain/work/request-spaces/space-control.ts";
import { designerScopeId } from "../work/cases/runtime.ts";
import { requestAuthorityRoute } from "./request-authority-routing.ts";
import {
  assertRequestCreationGrantAuthorityCurrent,
  assertRequestDelegatedAuthorityCurrent,
  type RequestCreationGrantAuthorityEnvelope,
  type RequestDelegatedAuthorityEnvelope,
} from "../model/source-admission/request-delegated-authority.ts";
import {
  requestChangeEffect,
  unresumedTeamCreation,
} from "../../domain/governance/records/request-change.ts";
import {
  creationPreviewExercise,
  requestCreationScope,
} from "../../domain/governance/policies/operator-creation-policy.ts";

/** All inputs are resolved by a host-owned adapter, never a caller-supplied proof.
 * Admission lifecycle may be revoked or expired: this route informs, not executes. */
export interface RequestSpaceAuthorityBridgeSnapshot {
  opening: OpeningRecord;
  space: {
    projectId: string;
    systemId: string;
    executionSpaceId: string;
    parentExecutionSpaceId: string | null;
    caseId: string | null;
  };
  admission: SpaceExecutionAdmission;
  request: SystemRuntimeState;
  /** The persisted states of the operators the admission names after the BO
   * (4.8e E5), as read; the bridge verifies each against the admission. */
  members?: SystemRuntimeState[];
  /** Absent until Main registers: unavailability, never absence of authority. */
  main?: SystemRuntimeState;
}
type RequestCreationGrantCapture = (input: {
  snapshot: RequestSpaceAuthorityBridgeSnapshot;
  requester: SystemRuntimeState;
  space: ExecutionSpaceRef;
  branchTeamSize: number;
  change: PendingChange;
}) => Promise<RequestCreationGrantAuthorityEnvelope | undefined>;

export interface RequestSpaceAuthorityBridgePort {
  resolve(caseId: string): Promise<RequestSpaceAuthorityBridgeSnapshot | null>;
  /** `wake` starts the registered Main's turn; only a route designating it sets it. */
  receiveMain(
    notice: OperatorNotice,
    origin: Case["openedFrom"],
    delivery: { wake: boolean },
  ): Promise<void>;
  /** The Cases of the open Requests of this host, for replay. */
  openCases(): Promise<string[]>;
  receiveBranch?(
    caseId: string,
    notice: OperatorNotice,
    origin: Case["openedFrom"],
    delivery: { wake: boolean },
  ): Promise<void>;
  /** Host-internal delegated decision of a covered BO request (C9). Absent
   * until the Request network decision is bound; never a person's API. */
  decide?(input: RequestDelegatedDecisionInput): Promise<void>;
  /** Host-internal (4.8e E4): the creator's envelope when an autonomous
   * grant read in its branch covers this pending creation now; undefined
   * otherwise (per-creation, absent, exhausted or provision out of bounds),
   * and the change routes like any request. Builds; never decides. */
  creationGrant?(): RequestCreationGrantCapture | undefined;
  /** Host-internal: decide, publish and adopt one creation under its
   * envelope. Called only once the creator's turn has settled. */
  decideCreation?(input: {
    snapshot: RequestSpaceAuthorityBridgeSnapshot;
    requester: SystemRuntimeState;
    envelope: RequestCreationGrantAuthorityEnvelope;
    change: PendingChange;
  }): Promise<void>;
  /** Host-internal: resume a recorded creation-grant decision (publication
   * and adoption) from its stored envelope. */
  resumeCreation?(input: {
    snapshot: RequestSpaceAuthorityBridgeSnapshot;
    requester: SystemRuntimeState;
    change: PendingChange;
  }): Promise<void>;
  /** A forgery-like proof is logged by the host; it never reaches Main. */
  refused(
    detail: {
      caseId: string;
      changeId?: string;
      code: "OPENING_PROOF_MISMATCH";
      check: string;
    },
  ): void;
}

/** A covered BO request as the MO reads it: the space is read-only (A6). */
type RequestBranchDecisionEntry = NonNullable<
  ChatContext["operatorAuthority"]
>["requests"][number];

/** An open branch Request as the MO reads it (4.8d D3). */
type RequestBranchOpeningEntry = NonNullable<
  ChatContext["requestOpening"]
>["requests"][number];

/** The registered Main's view of the branches (4.8d D2), from one walk. */
export interface RequestBranchMainView {
  requests: RequestBranchDecisionEntry[];
  awaitingPerson: RequestAwaitingPersonEntry[];
  openRequests: RequestBranchOpeningEntry[];
  recorded: Array<{ id: string; caseId: string }>;
}

/** At most this many open branch Requests reach the MO's context. */
const MAX_LISTED_REQUESTS = 20;

/** A BO request waiting for the person, as the MO reads it (read-only, D2).
 * `requestedAt` orders the context; it is not shown to the operator. */
export type RequestAwaitingPersonEntry =
  & NonNullable<ChatContext["operatorAuthority"]>["awaitingPerson"][number]
  & { requestedAt: string };

/** At most this many requests awaiting the person reach an operator's context. */
export const MAX_AWAITING_PERSON = 20;

/** Requests awaiting the person, newest first then by identity, bounded.
 * `requestedAt` only orders them; it is dropped from the view. */
export function awaitingPersonView<
  T extends { id: string; caseId: string; requestedAt: string },
>(entries: readonly T[]): {
  awaitingPerson: Omit<T, "requestedAt">[];
  awaitingPersonTruncated: boolean;
} {
  const ordered = [...entries].sort((a, b) =>
    a.requestedAt === b.requestedAt
      ? a.caseId === b.caseId
        ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        : a.caseId < b.caseId
        ? -1
        : 1
      : a.requestedAt < b.requestedAt
      ? 1
      : -1
  );
  return {
    awaitingPerson: ordered.slice(0, MAX_AWAITING_PERSON).map((
      { requestedAt: _requestedAt, ...entry },
    ) => entry),
    awaitingPersonTruncated: ordered.length > MAX_AWAITING_PERSON,
  };
}

type ChangeDecisionCommand = Extract<
  ChatDecision,
  { kind: "decide_operator_change" }
>;

/** Everything the host verified for one delegated decision: the opening proof,
 * the registered Main as decider and, while the change is pending, the route
 * that designates it. A replay of a recorded decision carries no route. */
export interface RequestDelegatedDecisionInput {
  snapshot: RequestSpaceAuthorityBridgeSnapshot & { main: SystemRuntimeState };
  space: ExecutionSpaceRef;
  requester: SystemRuntimeState;
  change: PendingChange;
  route?: RequestAuthorityRoute;
  decider: ScopedOperatorRef;
  command: ChangeDecisionCommand;
  origin: OperatorCommandOrigin;
}

/** A segment that cannot be routed now; the change stays pending and is replayed. */
interface RequestAuthorityUnresolved {
  status: "needs-resolution";
  code: AuthorityRouteCode;
  reason: string;
  recovery: string;
}

interface VerifiedOpening {
  snapshot: RequestSpaceAuthorityBridgeSnapshot & { main: SystemRuntimeState };
  /** The BO's segment: its model identity in its execution space. */
  space: ExecutionSpaceRef;
  record: Case;
}

/** A decided creation reserves its slot until adoption and its continuation
 * finish. This conservative count also covers an adopted child still resuming. */
export function reservedBranchTeamSize(
  admission: SpaceExecutionAdmission,
  states: readonly SystemRuntimeState[],
  caseId: string,
): number {
  return admission.permissions.operatorIds.length - 1 + states.reduce(
    (total, state) =>
      total +
      (state.configuration?.changes ?? []).filter((change) =>
        change.caseId === caseId &&
        unresumedTeamCreation(
          change,
          state.changeDecisionContinuations?.[change.id],
        )
      ).length,
    0,
  );
}

/** The only verifier of a Request opening proof. Every pending request of a
 * Branch Operator is routed in segments (C6) and reaches Main as a notice;
 * a forged proof never does. */
export class RequestSpaceAuthorityBridge {
  constructor(private readonly port: RequestSpaceAuthorityBridgePort) {}

  /** Checks one link at a time, so a forgery is told apart from a benign
   * staleness (left to routing) and from an unavailable Main. */
  async #verify(
    caseId: string,
    changeId?: string,
  ): Promise<VerifiedOpening | RequestAuthorityUnresolved> {
    const snapshot = await this.port.resolve(caseId);
    if (!snapshot) {
      return {
        status: "needs-resolution",
        code: "OPENING_PROOF_UNAVAILABLE",
        reason: "The exact Request-to-Main routing evidence is unavailable",
        recovery: "Replayed when the Request is provisioned again",
      };
    }
    const { opening, space, admission, request } = snapshot;
    const model = request.executionModel;
    const roots = request.cases?.filter((item) => item.id === caseId) ?? [];
    const mismatch = async (): Promise<string | undefined> => {
      if (
        !opening.base || !opening.baseDigest || !opening.admissionId ||
        opening.caseId !== caseId ||
        opening.executionSpaceId === MAIN_EXECUTION_SPACE_ID
      ) return "opening";
      if (
        space.projectId !== opening.scope.projectId ||
        space.systemId !== opening.scope.systemId ||
        space.executionSpaceId !== opening.executionSpaceId ||
        space.parentExecutionSpaceId !== MAIN_EXECUTION_SPACE_ID ||
        space.caseId !== caseId
      ) return "space";
      if (
        admission.id !== opening.admissionId ||
        admission.openingId !== opening.id ||
        admission.executionSpaceId !== opening.executionSpaceId ||
        admission.ownerId !== opening.ownerId ||
        admission.baseDigest !== opening.baseDigest ||
        canonical(admission.scope) !== canonical(opening.scope)
      ) return "admission";
      if (await requestSpaceDigest(opening.base) !== opening.baseDigest) {
        return "opening-digest";
      }
      if (
        !model ||
        model.identity.builderId !== opening.base.requestOwner.operatorId ||
        roots.length !== 1 || roots[0].owner !== model.identity.builderId
      ) return "request-owner";
      if (
        admission.permissions.operatorIds[0] !== model.identity.builderId ||
        admission.permissions.modelDigests[0] !== model.version.digest ||
        admission.permissions.sourceVersion !== model.version.repositoryVersion
      ) return "admission-pin";
      // Each member state is one the admission names, at its admitted digest,
      // a sub-operator of this Request (E3/E5).
      const { operatorIds, modelDigests } = admission.permissions;
      if (
        new Set(operatorIds).size !== operatorIds.length ||
        modelDigests.length !== operatorIds.length ||
        (snapshot.members ?? []).length !== operatorIds.length - 1 ||
        new Set(
            (snapshot.members ?? []).map((member) =>
              member.executionModel?.identity.builderId
            ),
          ).size !== operatorIds.length - 1 ||
        (snapshot.members ?? []).some((member) => {
          const memberModel = member.executionModel;
          const team = memberModel?.operatorTeam;
          const index = memberModel
            ? operatorIds.indexOf(memberModel.identity.builderId)
            : -1;
          return !memberModel || index < 1 ||
            modelDigests[index] !== memberModel.version.digest ||
            !team ||
            team.requestOwnerId !==
              model.identity.builderId;
        })
      ) return "team";
      return undefined;
    };
    const check = await mismatch();
    if (check) return this.#refuse(caseId, changeId, check);
    const main = snapshot.main;
    if (!main?.executionModel) {
      return {
        status: "needs-resolution",
        code: "MAIN_UNAVAILABLE",
        reason: "Main is unavailable; availability is not absence of authority",
        recovery: "Replayed when Main registers",
      };
    }
    return {
      snapshot: { ...snapshot, main },
      space: {
        projectId: model!.identity.projectId,
        systemId: model!.identity.systemId,
        executionSpaceId: opening.executionSpaceId,
      },
      record: roots[0],
    };
  }

  #refuse(
    caseId: string,
    changeId: string | undefined,
    check: string,
  ): RequestAuthorityUnresolved {
    this.port.refused({
      caseId,
      ...(changeId ? { changeId } : {}),
      code: "OPENING_PROOF_MISMATCH",
      check,
    });
    return {
      status: "needs-resolution",
      code: "OPENING_PROOF_MISMATCH",
      reason: "The Request opening proof does not match its execution space",
      recovery: "Inspect the Request opening; no notice was sent",
    };
  }

  #origin(main: SystemRuntimeState): Case["openedFrom"] {
    return { conversationId: main.id, designerScopeId: designerScopeId(main) };
  }

  /** Route a BO request across its verified opening to MO@main. */
  async #route(
    caseId: string,
    changeId: string,
  ): Promise<
    | {
      verified: VerifiedOpening;
      change: PendingChange;
      route: RequestAuthorityRoute;
    }
    | RequestAuthorityUnresolved
  > {
    const verified = await this.#verify(caseId, changeId);
    if ("status" in verified) return verified;
    return this.#routeIn(verified, caseId, changeId);
  }

  #routeIn(
    verified: VerifiedOpening,
    caseId: string,
    changeId: string,
  ):
    | {
      verified: VerifiedOpening;
      change: PendingChange;
      route: RequestAuthorityRoute;
    }
    | RequestAuthorityUnresolved {
    const { request, main, opening, admission } = verified.snapshot;
    // Every runtime of the space: the BO and its verified team (E5). The
    // change lives in its requester's own runtime.
    const states = [request, ...verified.snapshot.members ?? []];
    const requester = states.find((state) =>
      state.configuration?.changes.some((item) => item.id === changeId)
    );
    const change = requester?.configuration?.changes.find((item) =>
      item.id === changeId
    );
    if (!requester || !change) {
      return {
        status: "needs-resolution",
        code: "CHANGE_NOT_PENDING",
        reason: "The Request change is unavailable",
        recovery: "Nothing to route",
      };
    }
    const requesterId = requester.executionModel?.identity.builderId;
    if (
      requester !== request &&
      !admission.permissions.operatorIds.slice(1).includes(requesterId ?? "")
    ) return this.#refuse(caseId, changeId, "team");
    if (change.caseId !== caseId || change.requestedBy !== requesterId) {
      return this.#refuse(caseId, changeId, "change-scope");
    }
    if (change.status !== "pending" || change.publishedCommit) {
      return {
        status: "needs-resolution",
        code: "CHANGE_NOT_PENDING",
        reason: "The Request change is already decided",
        recovery: "Nothing to route",
      };
    }
    const route = requestAuthorityRoute({
      space: this.#space(verified, requester),
      requester,
      change,
      states,
      root: {
        kind: "verified-opening",
        openingId: opening.id,
        parent: {
          space: mainExecutionSpace(main.executionModel!.identity),
          state: main,
        },
      },
    });
    return { verified, change, route };
  }

  #states(verified: VerifiedOpening): SystemRuntimeState[] {
    return [verified.snapshot.request, ...verified.snapshot.members ?? []];
  }

  #requester(verified: VerifiedOpening, changeId: string): SystemRuntimeState {
    const matches = this.#states(verified).filter((state) =>
      state.configuration?.changes.some((change) => change.id === changeId)
    );
    if (matches.length !== 1) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The change has no unique admitted requester",
        { changeId, caseId: verified.snapshot.opening.caseId },
      );
    }
    return matches[0];
  }

  #space(
    verified: VerifiedOpening,
    state: SystemRuntimeState,
  ): ExecutionSpaceRef {
    const { projectId, systemId } = state.executionModel!.identity;
    return {
      projectId,
      systemId,
      executionSpaceId: verified.space.executionSpaceId,
    };
  }

  async proposed(
    caseId: string,
    changeId: string,
  ): Promise<RequestAuthorityRoute | RequestAuthorityUnresolved> {
    const routed = await this.#route(caseId, changeId);
    if ("status" in routed) return routed;
    const { verified: { snapshot: { main } }, change, route } = routed;
    // An autonomous team creation is self-approved in its branch (E1/E4),
    // never routed to Main or the person. It is called inside its creator's
    // turn, which holds the runtime: the decision waits for `settled`. A
    // per-creation grant routes below as any request.
    if (this.#defersCreation(routed.verified, change)) return route;
    const mainId = main.executionModel!.identity.builderId;
    const decisionAuthority = route.status === "actor-decision"
      ? "operator" as const
      : route.status === "human-decision"
      ? "human" as const
      : "unresolved" as const;
    // A historical notice already told Main the same decision: no duplicate.
    const historical = main.messages.some((message) => {
      const notice = message.operatorNotice;
      return notice?.kind === "authority-escalation" &&
        notice.caseId === caseId && notice.changeId === changeId &&
        (notice.route?.version ?? 1) !== 2 &&
        notice.decisionAuthority === decisionAuthority;
    });
    if (historical) return route;
    const inBranch = route.status === "actor-decision" &&
      route.designatedDecider?.executionSpaceId ===
        routed.verified.space.executionSpaceId;
    const receiving = inBranch ? routed.verified.snapshot.request : main;
    if (inBranch && !this.port.receiveBranch) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The designated branch decider is unavailable",
        { caseId, changeId },
      );
    }
    const deliver = inBranch
      ? this.port.receiveBranch!.bind(this.port, caseId)
      : this.port.receiveMain.bind(this.port);
    await deliver(
      {
        kind: "authority-escalation",
        changeId,
        caseId,
        requestedBy: change.requestedBy!,
        recipient: receiving.executionModel!.identity.builderId,
        changeKind: change.kind,
        ...(change.requestedRights
          ? { requestedRights: structuredClone(change.requestedRights) }
          : {}),
        decisionAuthority,
        reason: change.reason,
        route,
      },
      inBranch ? { conversationId: receiving.id, caseId } : this.#origin(main),
      {
        wake: inBranch || route.status === "actor-decision" &&
            route.designatedDecider?.executionSpaceId ===
              MAIN_EXECUTION_SPACE_ID &&
            route.designatedDecider.operatorId === mainId,
      },
    );
    return route;
  }

  /** Routing can defer an autonomous creation without capturing publication
   * authority while the creator still holds its turn. */
  #defersCreation(verified: VerifiedOpening, change: PendingChange): boolean {
    if (
      requestChangeEffect(change) !== "team-member" ||
      !this.port.creationGrant?.()
    ) return false;
    const requester = this.#requester(verified, change.id);
    try {
      return !!creationPreviewExercise(
        requester.executionModel!,
        change,
        requestCreationScope(
          this.#space(verified, requester),
          verified.snapshot.opening.caseId,
          reservedBranchTeamSize(
            verified.snapshot.admission,
            this.#states(verified),
            change.caseId!,
          ),
        ),
      ).creationDelegation;
    } catch (error) {
      if (
        error instanceof OperatorAuthorityError &&
        error.code === "AUTHORITY_OUT_OF_BOUNDS"
      ) return false;
      throw error;
    }
  }

  /** The envelope of an autonomous grant covering this pending creation. */
  async #autonomousCreation(
    verified: VerifiedOpening,
    change: PendingChange,
  ): Promise<RequestCreationGrantAuthorityEnvelope | undefined> {
    const creationGrant = this.port.creationGrant?.();
    if (
      requestChangeEffect(change) !== "team-member" ||
      !creationGrant
    ) return undefined;
    const { snapshot } = verified;
    const requester = this.#requester(verified, change.id);
    return await creationGrant({
      snapshot,
      requester,
      space: this.#space(verified, requester),
      branchTeamSize: reservedBranchTeamSize(
        snapshot.admission,
        this.#states(verified),
        change.caseId!,
      ),
      change,
    });
  }

  /** A creator's turn in this Case settled (or its runtime was provisioned
   * again): decide each pending creation an autonomous grant covers. */
  async settled(caseId: string): Promise<void> {
    if (!this.port.decideCreation) return;
    let verified = await this.#verify(caseId);
    if ("status" in verified) return;
    // Finish durable decisions across the whole team before spending any new
    // slot. Revocation never undoes one of these recorded decisions.
    const recoveryIds = this.#states(verified).flatMap((request) =>
      (request.configuration?.changes ?? []).filter((change) =>
        change.caseId === caseId &&
        unresumedTeamCreation(
          change,
          request.changeDecisionContinuations?.[change.id],
        ) &&
        request.requestNetworkDecisions?.[change.id]?.authority?.kind ===
          "creation-grant"
      ).map((change) => change.id)
    );
    for (const changeId of recoveryIds) {
      const request = this.#requester(verified, changeId);
      const change = request.configuration?.changes.find((entry) =>
        entry.id === changeId
      );
      if (
        change?.caseId === caseId && this.port.resumeCreation &&
        unresumedTeamCreation(
          change,
          request.changeDecisionContinuations?.[change.id],
        ) &&
        request.requestNetworkDecisions?.[change.id]?.authority?.kind ===
          "creation-grant"
      ) {
        await this.port.resumeCreation({
          snapshot: verified.snapshot,
          requester: request,
          change,
        });
        verified = await this.#verify(caseId, changeId);
        if ("status" in verified) return;
      }
    }
    const pendingIds = this.#states(verified).flatMap((request) =>
      (request.configuration?.changes ?? []).filter((change) =>
        change.caseId === caseId && change.status === "pending" &&
        !change.publishedCommit
      ).map((change) => change.id)
    );
    let changed = false;
    for (const changeId of pendingIds) {
      // Each completion can change admission, pins and the remaining grant.
      if (changed) {
        verified = await this.#verify(caseId, changeId);
        if ("status" in verified) return;
        changed = false;
      }
      const request = this.#requester(verified, changeId);
      const change = request.configuration?.changes.find((entry) =>
        entry.id === changeId
      );
      if (!change || change.status !== "pending" || change.publishedCommit) {
        continue;
      }
      const routed = this.#routeIn(verified, caseId, changeId);
      if ("status" in routed) continue;
      const envelope = await this.#autonomousCreation(verified, change);
      if (!envelope) {
        await this.proposed(caseId, changeId);
        changed = true;
        continue;
      }
      await this.port.decideCreation({
        snapshot: verified.snapshot,
        requester: request,
        envelope,
        change,
      });
      changed = true;
    }
  }

  /** Re-route every pending BO request of the open Requests: when Main
   * registers or its policies change. Notice IDs are deterministic, so an
   * unchanged route adds nothing and a flipped one notifies Main again. */
  async replay(): Promise<void> {
    const failures: unknown[] = [];
    for (const caseId of await this.port.openCases()) {
      try {
        const snapshot = await this.port.resolve(caseId);
        for (
          const change of [snapshot?.request, ...snapshot?.members ?? []]
            .flatMap((state) => state?.configuration?.changes ?? [])
        ) {
          if (
            change.status === "pending" && change.caseId === caseId &&
            !change.publishedCommit
          ) await this.proposed(caseId, change.id);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Request authority replay failed");
    }
  }

  /** Only the registered Main reads the branches. */
  #isMain(verified: VerifiedOpening, decider: ScopedOperatorRef): boolean {
    const main = verified.snapshot.main.executionModel!;
    return sameScopedOperator(
      decider,
      scopedOperator(
        mainExecutionSpace(main.identity),
        main.identity.builderId,
      ),
    );
  }

  /** The registered Main's whole view of the branches, from one walk over
   * the open Requests (4.8d D2): each change is routed once, so it is either
   * decidable by the MO or waiting for the person, never both. `recorded`
   * names the changes the MO already decided, whose publication or adoption
   * a replay of its command resumes. Never cached. */
  async mainView(decider: ScopedOperatorRef): Promise<RequestBranchMainView> {
    const view: RequestBranchMainView = {
      requests: [],
      awaitingPerson: [],
      openRequests: [],
      recorded: [],
    };
    const openings: Array<RequestBranchOpeningEntry & { createdAt: string }> =
      [];
    for (const caseId of await this.port.openCases()) {
      const verified = await this.#verify(caseId);
      if ("status" in verified || !this.#isMain(verified, decider)) continue;
      const { opening, request, members = [] } = verified.snapshot;
      if (isOpenCase(verified.record)) {
        openings.push({
          caseId,
          caseNumber: opening.caseNumber,
          operatorId: verified.record.owner,
          executionSpaceId: opening.executionSpaceId,
          status: verified.record.status,
          openedBy: opening.command.opener ? "main-operator" : "person",
          team: members.map((member) => {
            const model = member.executionModel!;
            return {
              operatorId: model.identity.builderId,
              name: model.operator?.name ?? model.identity.builderId,
              parentOperatorId: model.operatorTeam!.parentOperatorId,
            };
          }),
          createdAt: opening.createdAt,
        });
      }
      const changes = [request, ...members].flatMap((state) =>
        state.configuration?.changes ?? []
      );
      for (const change of changes) {
        if (change.caseId !== caseId) continue;
        if (change.status !== "pending") {
          if (
            this.#requester(verified, change.id).requestNetworkDecisions
              ?.[change.id]?.authority?.kind ===
              "delegated"
          ) view.recorded.push({ id: change.id, caseId });
          continue;
        }
        const routed = this.#routeIn(verified, caseId, change.id);
        if ("status" in routed) continue;
        const { route } = routed;
        if (route.status === "actor-decision") {
          if (
            route.designatedDecider?.operatorId === decider.operatorId &&
            route.designatedDecider.executionSpaceId ===
              decider.executionSpaceId
          ) {
            view.requests.push({
              id: change.id,
              requestedBy: change.requestedBy,
              caseId,
              baseRevision: change.baseRevision,
              requestedRights: structuredClone(change.requestedRights),
              executionSpaceId: verified.space.executionSpaceId,
              requester: route.requester,
              changeKind: change.kind,
            });
          }
          continue;
        }
        view.awaitingPerson.push({
          id: change.id,
          caseId,
          executionSpaceId: verified.space.executionSpaceId,
          requester: route.requester,
          changeKind: change.kind,
          ...(change.requestedRights
            ? { requestedRights: structuredClone(change.requestedRights) }
            : {}),
          status: route.status,
          ...(route.code ? { code: route.code } : {}),
          requestedAt: change.requestedAt ?? "",
        });
      }
    }
    view.openRequests = openings.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.caseNumber - b.caseNumber
        : a.createdAt < b.createdAt
        ? 1
        : -1
    ).slice(0, MAX_LISTED_REQUESTS).map(({ createdAt: _createdAt, ...entry }) =>
      entry
    );
    return view;
  }

  /** The execution space of an open Request Case of this host, from its
   * verified opening: what the registered Main names as a policy recipient
   * (4.8d D4). Anything else is `INVALID_AUTHORITY_POLICY`. */
  async recipientSpace(
    decider: ScopedOperatorRef,
    caseId: string,
    recipients: readonly string[],
  ): Promise<string> {
    const verified = await this.#verify(caseId);
    if (
      "status" in verified || !this.#isMain(verified, decider) ||
      !isOpenCase(verified.record)
    ) {
      throw new OperatorAuthorityError(
        "INVALID_AUTHORITY_POLICY",
        "The recipient Case is not an open Request of this system",
        { recipientCaseId: caseId, recipients: [...recipients] },
      );
    }
    // Admission membership comes from branchTeam; #verify has checked the
    // corresponding persisted states, digests and exact Request provenance.
    for (const recipient of recipients) {
      if (
        !verified.snapshot.admission.permissions.operatorIds.includes(recipient)
      ) {
        throw new OperatorAuthorityError(
          "INVALID_AUTHORITY_POLICY",
          "The recipient is not a verified member of the Request's admitted team",
          { recipientCaseId: caseId, recipient },
        );
      }
    }
    return verified.space.executionSpaceId;
  }

  /** Verified member requests and policies visible in this BO's Request. */
  async branchView(
    caseId: string,
  ): Promise<NonNullable<ChatContext["operatorAuthority"]>> {
    const verified = await this.#verify(caseId);
    if ("status" in verified) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        verified.reason,
        { caseId, code: verified.code },
      );
    }
    const model = verified.snapshot.request.executionModel!;
    const requests: RequestBranchDecisionEntry[] = [];
    for (const state of this.#states(verified)) {
      for (const change of state.configuration?.changes ?? []) {
        if (change.status !== "pending" || change.caseId !== caseId) {
          continue;
        }
        const routed = this.#routeIn(verified, caseId, change.id);
        if (
          "status" in routed ||
          routed.route.designatedDecider?.operatorId !==
            model.identity.builderId ||
          routed.route.designatedDecider.executionSpaceId !==
            verified.space.executionSpaceId
        ) continue;
        requests.push({
          id: change.id,
          requestedBy: change.requestedBy,
          caseId,
          baseRevision: change.baseRevision,
          requestedRights: structuredClone(change.requestedRights),
          executionSpaceId: verified.space.executionSpaceId,
          requester: routed.route.requester,
          changeKind: change.kind,
        });
      }
    }
    return {
      policies: structuredClone(
        (model.operatorAuthorityPolicies ?? []).filter((policy) =>
          policy.holderNativeId === model.identity.builderId
        ),
      ),
      requests,
      awaitingPerson: [],
      awaitingPersonTruncated: false,
    };
  }
  decide(
    input: {
      caseId: string;
      command: ChangeDecisionCommand;
      origin: OperatorCommandOrigin;
    },
  ): Promise<void> {
    return this.#decide(input, false);
  }
  /** Only bound by the host to the registered BO of this verified opening. */
  decideInBranch(
    input: {
      caseId: string;
      command: ChangeDecisionCommand;
      origin: OperatorCommandOrigin;
    },
  ): Promise<void> {
    return this.#decide(input, true);
  }
  async #decide(input: {
    caseId: string;
    command: ChangeDecisionCommand;
    origin: OperatorCommandOrigin;
  }, inBranch: boolean): Promise<void> {
    const { caseId, command, origin } = input;
    const verified = await this.#verify(caseId, command.changeId);
    if ("status" in verified) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        verified.reason,
        { caseId, changeId: command.changeId, code: verified.code },
      );
    }
    const actor = inBranch ? verified.snapshot.request : verified.snapshot.main;
    const model = actor.executionModel!;
    const decider = scopedOperator(
      inBranch
        ? this.#space(verified, actor)
        : mainExecutionSpace(model.identity),
      model.identity.builderId,
    );
    const requester = this.#requester(verified, command.changeId);
    const change = requester.configuration?.changes.find((
      item,
    ) => item.id === command.changeId);
    if (
      !change || change.caseId !== caseId ||
      change.requestedBy !== command.operatorId
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The decided change is not this Case's request",
        { caseId, changeId: command.changeId },
      );
    }
    let route: RequestAuthorityRoute | undefined;
    if (change.status === "pending") {
      const routed = this.#routeIn(verified, caseId, change.id);
      route = "status" in routed ? undefined : routed.route;
      const designated = route?.designatedDecider;
      if (
        route?.status !== "actor-decision" ||
        designated?.operatorId !== decider.operatorId ||
        designated.executionSpaceId !== decider.executionSpaceId ||
        designated.policyId !== command.policyId ||
        designated.policyRevision !== command.policyRevision ||
        change.baseRevision !== command.expectedRevision
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Only the current designated decider may decide this exact change",
          { caseId, changeId: command.changeId },
        );
      }
    }
    if (!this.port.decide) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "Delegated branch decisions are unavailable on this host",
        { caseId, changeId: command.changeId },
      );
    }
    await this.port.decide({
      snapshot: verified.snapshot,
      space: this.#space(verified, requester),
      requester,
      change,
      ...(route ? { route } : {}),
      decider,
      command,
      origin,
    });
  }

  /** Early check of a delegated decision against the current verified
   * opening, Main and change; the commit repeats it in its fenced step. */
  async revalidateDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
  ): Promise<void> {
    const caseId = envelope.destination.caseId;
    const verified = await this.#verify(caseId, envelope.route.changeId);
    if ("status" in verified) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        verified.reason,
        { caseId, changeId: envelope.route.changeId, code: verified.code },
      );
    }
    const { opening, admission, main } = verified.snapshot;
    const request = this.#requester(verified, envelope.route.changeId);
    const change = request.configuration?.changes.find((item) =>
      item.id === envelope.route.changeId
    );
    if (!change) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The decided change is unavailable",
        { caseId, changeId: envelope.route.changeId },
      );
    }
    assertRequestDelegatedAuthorityCurrent(envelope, {
      opening,
      admission,
      request,
      space: this.#space(verified, request),
      states: this.#states(verified),
      main,
      change,
    });
  }

  /** Early check of a creation-grant decision against the current verified
   * opening and change; the commit repeats it in its fenced step. */
  async revalidateCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
  ): Promise<void> {
    const caseId = envelope.destination.caseId;
    const changeId = envelope.exercise.creationDelegation?.changeId ?? "";
    const verified = await this.#verify(caseId, changeId);
    if ("status" in verified) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        verified.reason,
        { caseId, changeId, code: verified.code },
      );
    }
    const { opening, admission } = verified.snapshot;
    const request = this.#requester(verified, changeId);
    const change = request.configuration?.changes.find((item) =>
      item.id === changeId
    );
    if (!change) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The decided change is unavailable",
        { caseId, changeId },
      );
    }
    assertRequestCreationGrantAuthorityCurrent(envelope, {
      opening,
      admission,
      request,
      space: this.#space(verified, request),
      branchTeamSize: reservedBranchTeamSize(admission, [], caseId),
      change,
    });
  }

  /** A closed BO Request is reported to Main; `approved` stays a no-op. */
  async closed(caseId: string): Promise<void> {
    const verified = await this.#verify(caseId);
    if ("status" in verified) return;
    const { record, snapshot: { request, main } } = verified;
    if (
      record.status !== "closed-done" && record.status !== "closed-abandoned"
    ) return;
    const result =
      request.messages.filter((message) =>
        message.caseId === caseId && message.role === "assistant"
      ).at(-1)?.text ?? "";
    await this.port.receiveMain(
      {
        kind: "request-completed",
        caseId,
        owner: record.owner,
        openedBy: record.openedBy,
        status: record.status,
        result,
      },
      this.#origin(main),
      { wake: false },
    );
  }
}

/** Revision-scoped Main context reads; decisions must read the bridge afresh. */
export function createWorkspaceBranchReads(options: {
  primary: SystemRuntime;
  runtimes: ReadonlyMap<string, { runtime: SystemRuntime }>;
  bridge?: Pick<RequestSpaceAuthorityBridge, "mainView">;
  authorityRoute(
    runtime: SystemRuntime,
    change: PendingChange,
  ): RequestAuthorityRoute;
}) {
  const { runtimes } = options;
  /** The registered Main as a decider; other runtimes read no branch. */
  function branchDecider(runtime: SystemRuntime) {
    const model = runtime.snapshot.executionModel;
    if (!options.bridge || !model || runtime !== options.primary) {
      return undefined;
    }
    return scopedOperator(
      mainExecutionSpace(model.identity),
      model.identity.builderId,
    );
  }

  const emptyBranchView: RequestBranchMainView = {
    requests: [],
    awaitingPerson: [],
    openRequests: [],
    recorded: [],
  };
  /** One walk of the branches per Main revision: the contexts assembled for
   * one turn (authority and Request openings) share it, so a change is never
   * both decidable and waiting. Decisions walk again (4.8d D2). */
  let branchViewOf:
    | { revision: number; view: Promise<RequestBranchMainView> }
    | undefined;
  function branchView(runtime: SystemRuntime): Promise<RequestBranchMainView> {
    const decider = branchDecider(runtime);
    if (!decider) return Promise.resolve(emptyBranchView);
    const revision = runtime.snapshot.revision;
    if (branchViewOf?.revision !== revision) {
      const view = options.bridge!.mainView(decider);
      branchViewOf = { revision, view };
      void view.catch(() => {
        if (branchViewOf?.view === view) branchViewOf = undefined;
      });
    }
    return branchViewOf.view;
  }

  /** Main's read-only view of the requests waiting for the person: main
   * operators' requests from the same routes as its decidable ones, then the
   * Branch Operators' requests (4.8d D2). */
  async function awaitingPersonContext(runtime: SystemRuntime) {
    const entries: RequestAwaitingPersonEntry[] = [];
    if (runtime !== options.primary) return awaitingPersonView(entries);
    const self = runtime.snapshot.executionModel?.identity.builderId;
    for (const entry of runtimes.values()) {
      for (
        const change of entry.runtime.snapshot.configuration?.changes ?? []
      ) {
        if (
          change.status !== "pending" || change.publishedCommit ||
          !change.caseId || change.requestedBy === self
        ) continue;
        const route = options.authorityRoute(entry.runtime, change);
        if (route.status === "actor-decision") continue;
        entries.push({
          id: change.id,
          caseId: change.caseId,
          executionSpaceId: MAIN_EXECUTION_SPACE_ID,
          requester: route.requester,
          changeKind: change.kind,
          ...(change.requestedRights
            ? { requestedRights: structuredClone(change.requestedRights) }
            : {}),
          status: route.status,
          ...(route.code ? { code: route.code } : {}),
          requestedAt: change.requestedAt,
        });
      }
    }
    entries.push(...(await branchView(runtime)).awaitingPerson);
    return awaitingPersonView(entries);
  }

  return { branchDecider, branchView, awaitingPersonContext, emptyBranchView };
}

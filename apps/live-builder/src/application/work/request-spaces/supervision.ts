import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type {
  RequestSupervisionQuery,
  RequestSupervisionReadPort,
  RequestSupervisionSnapshot,
  SupervisionAction,
  SupervisionInstance,
  SupervisionSource,
} from "./supervision-view.ts";
import {
  exactSourceVersion,
  type OpeningRecord,
  RequestSpaceError,
  requestSpaceIdentity,
  type RequestSpaceScope,
  type SpaceController,
} from "../../../domain/work/request-spaces.ts";
import type { RequestExecutionBinding } from "../../model/evolution/request-adoption-ports.ts";
import type { SpaceAdmissions } from "./control.ts";
import type { OpeningStorePort, SpaceControlPort } from "./ports.ts";
import type { ClockPort } from "../runtime/ports.ts";

const SUPERVISION_DEFAULT_LIMIT = 20;
const SUPERVISION_MAX_LIMIT = 50;

export interface SupervisionOpeningStorePort
  extends Pick<OpeningStorePort, "forCase"> {
  /** Descending system Case number; at most limit rows, no unbounded discovery. */
  pageForOwner(ownerId: string, query: {
    limit: number;
    beforeCaseNumber?: number;
  }): Promise<OpeningRecord[]>;
}

/** Host-fixed persisted readers only. Neither method may restore a runtime,
 * open an operator store, backfill, repair, enqueue or invoke a provider. */
export interface SupervisionObservationPort {
  readonly mainActor: ScopedOperatorRef;
  main(): Promise<SystemRuntimeState | null>;
  request(opening: OpeningRecord): Promise<{
    binding: RequestExecutionBinding;
    parentExecutionSpaceId: string | null;
  }>;
  /** Verified persisted states of this space's admitted team members; a
   * member whose state is missing or incoherent is absent from the result. */
  team(opening: OpeningRecord): Promise<SystemRuntimeState[]>;
}

function invalid(): never {
  throw new RequestSpaceError(
    "INVALID_COMMAND",
    "Select a bounded supervision page or one exact Case.",
  );
}
export function supervisionQuery(query: RequestSupervisionQuery = {}) {
  if (
    Object.keys(query).some((key) =>
      !["caseId", "limit", "cursor"].includes(key)
    )
  ) invalid();
  const limit = query.limit ?? SUPERVISION_DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > SUPERVISION_MAX_LIMIT
  ) invalid();
  if (
    query.caseId !== undefined &&
    (!requestSpaceIdentity(query.caseId) || query.cursor !== undefined)
  ) invalid();
  let beforeCaseNumber: number | undefined;
  if (query.cursor !== undefined) {
    if (!/^case-number:[1-9][0-9]{0,15}$/.test(query.cursor)) invalid();
    beforeCaseNumber = Number(query.cursor.slice("case-number:".length));
    if (!Number.isSafeInteger(beforeCaseNumber)) invalid();
  }
  return { caseId: query.caseId, limit, beforeCaseNumber };
}

function observedSource(
  state: SystemRuntimeState,
  branchId: string | null,
): SupervisionSource {
  const model = state.executionModel;
  if (
    !model || !exactSourceVersion(model.version.repositoryVersion) ||
    !/^[a-f0-9]{64}$/.test(model.version.digest) ||
    !Number.isSafeInteger(state.revision) || state.revision < 0
  ) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "The exact persisted execution source is unavailable.",
    );
  }
  return {
    sourceVersion: model.version.repositoryVersion,
    modelDigest: model.version.digest,
    branchId,
    runtimeRevision: state.revision,
  };
}

const unresolved = () => ({
  status: "unresolved" as const,
  reason:
    "Opening provenance and execution-space parentage do not establish a Request-to-Main actor supervision binding.",
});

/** Authenticated operational observations collected independently over a bounded
 * page. No atomic global state, inspected-source parameter, runtime factory or
 * mutation port is implied. Each action retains its own evaluation date. */
export class RequestSupervision implements RequestSupervisionReadPort {
  private readonly scope: RequestSpaceScope;
  private readonly mainActor: ScopedOperatorRef;
  constructor(
    private readonly options: ClockPort & {
      scope: RequestSpaceScope;
      control: SpaceControlPort;
      store: SupervisionOpeningStorePort;
      admissions: Pick<SpaceAdmissions, "assertConversation">;
      observations: SupervisionObservationPort;
    },
  ) {
    this.scope = Object.freeze({ ...options.scope });
    this.mainActor = Object.freeze({ ...options.observations.mainActor });
    if (
      this.mainActor.projectId !== this.scope.projectId ||
      this.mainActor.systemId !== this.scope.systemId ||
      this.mainActor.executionSpaceId !== "main" || !this.mainActor.operatorId
    ) {
      throw new Error("Supervision requires the registered host Main identity");
    }
  }
  private now() {
    return this.options.now();
  }
  private owned(
    record: OpeningRecord | null,
    controller: SpaceController,
  ): asserts record is OpeningRecord {
    if (
      !record?.base || record.ownerId !== controller.ownerId ||
      record.scope.projectId !== this.scope.projectId ||
      record.scope.systemId !== this.scope.systemId ||
      record.executionSpaceId === "main" ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The selected Request is unavailable.",
      );
    }
  }
  private unknownActions(
    actor: ScopedOperatorRef,
    source: SupervisionSource | null,
  ): SupervisionAction[] {
    return (["effects", "supervision-decision"] as const).map<
      SupervisionAction
    >((action) => ({
      action,
      actor: { kind: "operator", ref: { ...actor } },
      target: { ...actor },
      source,
      result: "unevaluated",
      evaluatedAt: null,
      reason:
        "No current action-specific authority evaluation is provided by this readout.",
    }));
  }
  private async main(): Promise<SupervisionInstance> {
    try {
      const state = await this.options.observations.main();
      if (
        !state?.executionModel ||
        state.executionModel.identity.builderId !== this.mainActor.operatorId
      ) throw new Error("Unavailable Main");
      const source = observedSource(state, null);
      return {
        actor: { ...this.mainActor },
        role: "MO",
        name: state.executionModel.operator?.name ?? "Main Operator",
        case: null,
        source,
        availability: "available",
        unavailableReason: null,
        supervision: { status: "global-main" },
        evaluatedActions: this.unknownActions(this.mainActor, source),
      };
    } catch {
      return {
        actor: { ...this.mainActor },
        role: "MO",
        name: "Main Operator",
        case: null,
        source: null,
        availability: "unavailable",
        unavailableReason:
          "The registered Main's persisted observation is unavailable.",
        supervision: { status: "global-main" },
        evaluatedActions: this.unknownActions(this.mainActor, null),
      };
    }
  }
  /** The BO instance and the team members its observed admission names
   * (none when the BO observation itself is unavailable). */
  private async request(record: OpeningRecord): Promise<{
    instance: SupervisionInstance;
    admittedTeam: readonly string[];
  }> {
    const actor = {
      ...this.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: record.base!.requestOwner.operatorId,
    };
    try {
      const { binding, parentExecutionSpaceId } = await this.options
        .observations.request(record);
      const state = binding.state, model = state.executionModel;
      const root = state.cases?.filter((entry) => entry.id === record.caseId);
      const source = observedSource(state, record.branchId);
      if (
        !model || model.identity.builderId !== actor.operatorId ||
        binding.pin.source.version !== source.sourceVersion ||
        binding.pin.modelDigest !== source.modelDigest ||
        !root || root.length !== 1 || root[0].owner !== actor.operatorId ||
        root[0].number !== record.caseNumber
      ) throw new Error("Unavailable Request");
      const instance: SupervisionInstance = {
        actor,
        role: "BO",
        name: model.operator?.name ?? "Branch Operator",
        case: {
          id: record.caseId,
          number: record.caseNumber,
          title: root[0].objective || null,
        },
        source,
        availability: "available",
        unavailableReason: null,
        supervision: {
          ...unresolved(),
          hostMain: { ...this.mainActor },
          openingProvenance: {
            openingId: record.id,
            admissionId: record.admissionId,
            parentExecutionSpaceId,
            openedBy: root[0].openedBy,
            originConversationId: root[0].openedFrom.conversationId,
          },
        },
        evaluatedActions: this.unknownActions(actor, source),
      };
      return {
        instance,
        admittedTeam: binding.admission.permissions.operatorIds.slice(1),
      };
    } catch {
      return {
        instance: {
          actor,
          role: "BO",
          name: "Branch Operator",
          case: { id: record.caseId, number: record.caseNumber, title: null },
          source: null,
          availability: "unavailable",
          unavailableReason:
            "The exact persisted Request observation is unavailable.",
          supervision: { ...unresolved(), hostMain: { ...this.mainActor } },
          evaluatedActions: this.unknownActions(actor, null),
        },
        admittedTeam: [],
      };
    }
  }
  /** Team instances of one Case, data for the future rights matrix: one
   * per member the BO's observed admission names. A member whose verified
   * state is absent, or a failed team observation, is listed unavailable,
   * never omitted: a silently shorter team would read as a healthy space. */
  private async team(
    record: OpeningRecord,
    admitted: readonly string[],
  ): Promise<SupervisionInstance[]> {
    if (!admitted.length) return [];
    let states: SystemRuntimeState[] = [];
    try {
      states = await this.options.observations.team(record);
    } catch {
      /* Every admitted member is listed unavailable below. */
    }
    const owner = record.base!.requestOwner.operatorId;
    return admitted.map((operatorId) => {
      const actor = {
        ...this.scope,
        executionSpaceId: record.executionSpaceId,
        operatorId,
      };
      const state = states.find((entry) =>
        entry.executionModel?.identity.builderId === operatorId
      );
      const model = state?.executionModel;
      const team = model?.operatorTeam?.requestId === record.caseId &&
          model.operatorTeam.requestOwnerId === owner
        ? model.operatorTeam
        : undefined;
      let source: SupervisionSource | null = null;
      if (state && team) {
        try {
          source = observedSource(state, record.branchId);
        } catch {
          /* Listed as unavailable, never with an invented source. */
        }
      }
      return {
        actor,
        role: "team" as const,
        ...(source && team
          ? {
            parent: {
              ...this.scope,
              executionSpaceId: record.executionSpaceId,
              operatorId: team.parentOperatorId,
            },
          }
          : {}),
        name: (source && model?.operator?.name) || "Team operator",
        case: { id: record.caseId, number: record.caseNumber, title: null },
        source,
        availability: source ? "available" as const : "unavailable" as const,
        unavailableReason: source
          ? null
          : "The exact persisted team observation is unavailable.",
        supervision: { ...unresolved(), hostMain: { ...this.mainActor } },
        evaluatedActions: this.unknownActions(actor, source),
      };
    });
  }
  async read(
    secret: string,
    query: RequestSupervisionQuery = {},
  ): Promise<RequestSupervisionSnapshot> {
    // Authentication precedes validation/discovery and all persisted observations.
    const controller = await this.options.control.authenticateSession(secret);
    const page = supervisionQuery(query);
    const discovered = page.caseId === undefined
      ? await this.options.store.pageForOwner(controller.ownerId, {
        limit: page.limit + 1,
        beforeCaseNumber: page.beforeCaseNumber,
      })
      : [await this.options.store.forCase(page.caseId)];
    for (const record of discovered) this.owned(record, controller);
    const records = discovered.slice(0, page.limit) as OpeningRecord[];
    const observedAt = this.now();
    const main = await this.main();
    const instances: SupervisionInstance[] = [];
    for (const record of records) {
      const observed = await this.request(record);
      let instance = observed.instance;
      // Ownership and controller remain live after a potentially delayed observation.
      const current = await this.options.store.forCase(record.caseId);
      this.owned(current, controller);
      if (
        current.id !== record.id ||
        current.executionSpaceId !== record.executionSpaceId ||
        current.base!.requestOwner.operatorId !==
          record.base!.requestOwner.operatorId
      ) {
        throw new RequestSpaceError(
          "FORBIDDEN",
          "The selected Request changed during observation.",
        );
      }
      let result: SupervisionAction["result"] = "unevaluated";
      let evaluatedAt: string | null = null;
      let reason =
        "The exact execution source is unavailable; conversation admission was not evaluated.";
      if (instance.source) {
        try {
          await this.options.admissions.assertConversation(
            current,
            controller,
            instance.source,
          );
          result = "allowed";
          reason =
            "Current controller conversation admission passed. Execution checks admission again.";
        } catch (error) {
          if (
            error instanceof RequestSpaceError &&
            ["FORBIDDEN", "ADMISSION_REFUSED"].includes(error.code)
          ) {
            result = "refused";
            reason =
              "The current conversation admission refused this controller, target or observed source.";
          } else {
            reason =
              "The current conversation admission could not be evaluated.";
          }
        }
        if (result !== "unevaluated") evaluatedAt = this.now();
      }
      instance = {
        ...instance,
        evaluatedActions: [{
          action: "conversation",
          actor: { kind: "controller", ownerId: controller.ownerId },
          target: instance.actor,
          source: instance.source,
          result,
          evaluatedAt,
          reason,
        }, ...instance.evaluatedActions],
      };
      instances.push(instance);
      instances.push(...await this.team(record, observed.admittedTeam));
    }
    await this.options.control.revalidate(controller);
    const completedAt = this.now();
    const hasMore = discovered.length > records.length;
    const snapshot: RequestSupervisionSnapshot = {
      schema: "assembly-system-supervision/v1",
      scope: this.scope,
      observedAt,
      completedAt,
      main,
      instances,
      coverage: {
        selection: page.caseId === undefined
          ? "owned-host-openings"
          : "selected-case",
        caseId: page.caseId ?? null,
        limit: page.limit,
        returned: instances.length,
        unavailable:
          instances.filter((entry) => entry.availability === "unavailable")
            .length,
        completeness: hasMore ? "has-more" : "complete",
        boundary: "owned-request-openings",
      },
      nextCursor: hasMore ? `case-number:${records.at(-1)!.caseNumber}` : null,
    };
    return structuredClone(snapshot);
  }
}

import type {
  CaseClosureEvidence,
  CasesSnapshot,
  CaseVerdict,
} from "../../../domain/work/entities/cases.ts";
import { type RequestKpis, requestKpis } from "../../telemetry/request-kpis.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type {
  AgentMessageCommand,
  ConversationsSnapshot,
} from "../operators/conversation-types.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  RequestSpaceError,
  requestSpaceIdentity,
  type RequestSpaceScope,
} from "../../../domain/work/request-spaces/scope.ts";
import {
  operatorConversationsSnapshot,
  projectOperatorConversation,
} from "../operators/conversations.ts";
import type { OpeningStorePort, SpaceControlPort } from "./ports.ts";
import type { SpaceAdmissions } from "./control.ts";

/** A human decision selects an exact pending change in one owned Request. */
export interface RequestCaseChangeDecision {
  caseId: string;
  agentId: string;
  changeId: string;
  expectedRevision: number;
  configurationRevision: number;
  verdict: "approve" | "refuse";
}
export interface RequestCaseChangeDecisionPort {
  decide(
    secret: string,
    record: OpeningRecord,
    command: RequestCaseChangeDecision,
  ): Promise<unknown>;
  status?(
    secret: string,
    record: OpeningRecord,
    agentId: string,
    changeId: string,
  ): Promise<unknown>;
  resume?(
    secret: string,
    record: OpeningRecord,
    agentId: string,
    changeId: string,
  ): Promise<unknown>;
}

/** Existing Case/conversation transport contract, selected before Main lookup. */
export interface RequestCaseConversationsPort {
  cases(secret: string, caseId?: string): Promise<CasesSnapshot>;
  closeCase(
    secret: string,
    caseId: string,
    outcome: "done" | "abandoned",
    verdict?: CaseVerdict,
  ): Promise<void>;
  conversations(secret: string, caseId: string): Promise<ConversationsSnapshot>;
  submitHuman(
    secret: string,
    command: AgentMessageCommand,
  ): Promise<string | void>;
  decideChange?(
    secret: string,
    command: RequestCaseChangeDecision,
  ): Promise<unknown>;
  networkDecisionStatus?(
    secret: string,
    caseId: string,
    agentId: string,
    changeId: string,
  ): Promise<unknown>;
  resumeNetworkDecision?(
    secret: string,
    caseId: string,
    agentId: string,
    changeId: string,
  ): Promise<unknown>;
}
/** Minimal actual execution identity from a host-owned durable Case read. */
interface RequestCaseExecutionSnapshot {
  readonly scope: RequestSpaceScope;
  readonly executionSpaceId: string;
  readonly caseId: string;
  readonly operatorId: string;
  readonly runtimeRevision: number;
  readonly modelVersion: {
    readonly digest: string;
    readonly repositoryVersion?: string;
  };
}
export interface RequestCaseExecutionReader {
  requestKpis(secret: string, caseId: string): Promise<RequestKpis>;
  execution(
    secret: string,
    caseId: string,
  ): Promise<RequestCaseExecutionSnapshot>;
}
export class RequestCaseConversations
  implements RequestCaseConversationsPort, RequestCaseExecutionReader {
  constructor(
    private readonly options: {
      scope: RequestSpaceScope;
      control: SpaceControlPort;
      store: Pick<OpeningStorePort, "forCase"> & {
        forOwner(ownerId: string): Promise<OpeningRecord[]>;
      };
      admissions: Pick<SpaceAdmissions, "assertConversation">;
      changeDecision?: RequestCaseChangeDecisionPort;
      runtime: {
        read(record: OpeningRecord): Promise<SystemRuntimeState>;
        /** Available team states verified against this Case's opening admission and exact current pins. */
        readTeam?(record: OpeningRecord): Promise<SystemRuntimeState[]>;
        closeCase(
          record: OpeningRecord,
          outcome: "done" | "abandoned",
          evidence: CaseClosureEvidence,
        ): Promise<void>;
        initialExecutionOutcome?(
          record: OpeningRecord,
          state: SystemRuntimeState,
        ): Promise<"refused" | undefined>;
        submitHuman(
          record: OpeningRecord,
          command: AgentMessageCommand,
        ): Promise<string | void>;
      };
    },
  ) {}
  private assertOwned(
    record: OpeningRecord | null,
    ownerId: string,
  ): asserts record is OpeningRecord {
    if (
      !record?.base || record.ownerId !== ownerId ||
      record.scope.projectId !== this.options.scope.projectId ||
      record.scope.systemId !== this.options.scope.systemId ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The selected Request is unavailable",
      );
    }
  }
  private async record(
    caseId: string,
    ownerId: string,
  ): Promise<OpeningRecord> {
    if (!requestSpaceIdentity(caseId)) {
      throw new RequestSpaceError(
        "INVALID_COMMAND",
        "An exact Request identity is required",
      );
    }
    const record = await this.options.store.forCase(caseId);
    this.assertOwned(record, ownerId);
    if (record.caseId !== caseId) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The selected Request is unavailable",
      );
    }
    return record;
  }
  /** One bounded reread after native observation prevents a delayed initial
   * refusal from being attached to a later input or runtime revision. */
  private async readProjection(record: OpeningRecord): Promise<{
    state: SystemRuntimeState;
    initialExecutionOutcome: "refused" | undefined;
  }> {
    const state = await this.options.runtime.read(record);
    const outcome = await this.options.runtime.initialExecutionOutcome?.(
      record,
      state,
    );
    if (outcome === undefined) {
      return { state, initialExecutionOutcome: undefined };
    }
    const current = await this.options.runtime.read(record);
    const unchanged = current.revision === state.revision &&
      current.activeInputMessageId === state.activeInputMessageId &&
      current.busy === state.busy;
    return {
      state: current,
      initialExecutionOutcome: unchanged ? outcome : undefined,
    };
  }
  async cases(secret: string, caseId?: string): Promise<CasesSnapshot> {
    const controller = await this.options.control.authenticateSession(secret);
    const records = caseId === undefined
      ? await this.options.store.forOwner(controller.ownerId)
      : [await this.record(caseId, controller.ownerId)];
    const cases: CasesSnapshot["cases"] = [];
    for (const record of records) {
      this.assertOwned(record, controller.ownerId);
      const { state, initialExecutionOutcome } = await this.readProjection(
        record,
      );
      const owned = state.cases?.filter((entry) => entry.id === record.caseId);
      if (owned?.length !== 1) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The durable Request state is unavailable",
        );
      }
      cases.push({
        ...structuredClone(owned[0]),
        ...(initialExecutionOutcome ? { initialExecutionOutcome } : {}),
      });
    }
    await this.options.control.revalidate(controller);
    return { systemId: this.options.scope.systemId, cases };
  }
  async execution(
    secret: string,
    caseId: string,
  ): Promise<RequestCaseExecutionSnapshot> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    const state = await this.options.runtime.read(record);
    const model = state.executionModel;
    if (
      !model ||
      model.identity.builderId !== record.base!.requestOwner.operatorId
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request owner model is unavailable",
      );
    }
    const result = Object.freeze({
      scope: Object.freeze({
        projectId: record.scope.projectId,
        systemId: record.scope.systemId,
      }),
      executionSpaceId: record.executionSpaceId,
      caseId: record.caseId,
      operatorId: model.identity.builderId,
      runtimeRevision: state.revision,
      modelVersion: Object.freeze({
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
      }),
    });
    await this.options.control.revalidate(controller);
    return result;
  }
  async requestKpis(secret: string, caseId: string): Promise<RequestKpis> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    const state = await this.options.runtime.read(record);
    const owned = state.cases?.find((entry) => entry.id === caseId);
    if (!owned) {
      throw new RequestSpaceError("UNAVAILABLE", "The Request is unavailable");
    }
    const team = await this.options.runtime.readTeam?.(record) ?? [];
    const result = requestKpis(owned, [state, ...team]);
    await this.options.control.revalidate(controller);
    return result;
  }
  async closeCase(
    secret: string,
    caseId: string,
    outcome: "done" | "abandoned",
    verdict?: CaseVerdict,
  ): Promise<void> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    await this.options.admissions.assertConversation(record, controller);
    await this.options.control.revalidate(controller);
    await this.options.runtime.closeCase(record, outcome, {
      closedBy: controller.ownerId,
      ...(verdict === undefined ? {} : { verdict }),
    });
  }
  async conversations(
    secret: string,
    caseId: string,
  ): Promise<ConversationsSnapshot> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    const { state, initialExecutionOutcome } = await this.readProjection(
      record,
    );
    const model = state.executionModel;
    if (
      !model ||
      model.identity.builderId !== record.base!.requestOwner.operatorId
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request owner model is unavailable",
      );
    }
    // A Request owner locator grants no modeled primary role or human-input entry.
    // Undefined disables the legacy Main fallback while retaining explicit metadata.
    const conversation = projectOperatorConversation(
      state,
      model.identity.systemQualifiedName ?? model.identity.builderId,
      undefined,
      model.operatorTeam,
    );
    // This exact owner is a Case-scoped instance; the inherited generic name
    // describes its source, not the global Main actor. Keep custom names.
    if (conversation.name === "Main Operator") {
      conversation.name = "Branch Operator";
    }
    // Only committed updates explicitly scoped to this Request can appear in
    // its conversation. The projection preserves their journal order and IDs.
    conversation.effectiveModelUpdates = conversation.effectiveModelUpdates
      ?.filter(
        (update) => update.caseId === record.caseId,
      );
    if (initialExecutionOutcome === "refused") {
      conversation.initialExecutionOutcome = initialExecutionOutcome;
      conversation.phase = "Initial execution refused";
    }
    const verifiedMembers = await this.options.runtime.readTeam?.(record) ?? [];
    // readTeam has already verified membership against this Case and pin.
    const team = verifiedMembers.flatMap((memberState) => {
      const memberModel = memberState.executionModel;
      if (
        !memberModel?.operatorTeam ||
        memberModel.identity.builderId ===
          record.base!.requestOwner.operatorId
      ) return [];
      const memberConversation = projectOperatorConversation(
        memberState,
        memberModel.identity.systemQualifiedName ??
          memberModel.identity.builderId,
        undefined,
        { ...memberModel.operatorTeam, requestId: record.caseId },
      );
      memberConversation.effectiveModelUpdates = memberConversation
        .effectiveModelUpdates?.filter(
          (update) => update.caseId === record.caseId,
        );
      return [memberConversation];
    });
    await this.options.control.revalidate(controller);
    const result = operatorConversationsSnapshot(
      state.id,
      [conversation, ...team],
      model.identity.builderId,
    );
    // A native receipt may arrive without another RuntimeState revision.
    if (initialExecutionOutcome) result.version += ":initial-execution-refused";
    return result;
  }
  async networkDecisionStatus(
    secret: string,
    caseId: string,
    agentId: string,
    changeId: string,
  ): Promise<unknown> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    if (
      agentId !== record.base!.requestOwner.operatorId ||
      !this.options.changeDecision?.status
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This Request decision is unavailable",
      );
    }
    const result = await this.options.changeDecision.status(
      secret,
      record,
      agentId,
      changeId,
    );
    await this.options.control.revalidate(controller);
    return result;
  }
  async resumeNetworkDecision(
    secret: string,
    caseId: string,
    agentId: string,
    changeId: string,
  ): Promise<unknown> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(caseId, controller.ownerId);
    if (
      agentId !== record.base!.requestOwner.operatorId ||
      !this.options.changeDecision?.resume
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This Request decision is unavailable",
      );
    }
    await this.options.admissions.assertConversation(record, controller);
    await this.options.control.revalidate(controller);
    return await this.options.changeDecision.resume(
      secret,
      record,
      agentId,
      changeId,
    );
  }
  async decideChange(
    secret: string,
    command: RequestCaseChangeDecision,
  ): Promise<unknown> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(command.caseId, controller.ownerId);
    if (
      command.agentId !== record.base!.requestOwner.operatorId ||
      !this.options.changeDecision
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This Request decision is unavailable",
      );
    }
    await this.options.admissions.assertConversation(record, controller);
    await this.options.control.revalidate(controller);
    return await this.options.changeDecision.decide(
      secret,
      record,
      structuredClone(command),
    );
  }
  async submitHuman(
    secret: string,
    command: AgentMessageCommand,
  ): Promise<string | void> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.record(command.caseId ?? "", controller.ownerId);
    if (
      command.agentId !== record.base!.requestOwner.operatorId ||
      command.newConversation !== undefined
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "Only the explicitly selected Request owner is supported",
      );
    }
    await this.options.admissions.assertConversation(record, controller);
    await this.options.control.revalidate(controller);
    return await this.options.runtime.submitHuman(record, command);
  }
}

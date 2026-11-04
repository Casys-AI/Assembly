import type { QueuedArtifactSourcePublication } from "../../domain/work/artifacts/source-publication.ts";
import { ArtifactSourceError } from "../../domain/work/artifacts/source-reference.ts";
import {
  exactCandidateInspection,
  exactDelegatedCommandDecision,
} from "../governance/operator-command-origin.ts";
import { requestOpeningHost } from "../work/cases/opening.ts";
import {
  type MainOpener,
  type OpeningCommand,
  type OpeningView,
  RequestSpaceError,
} from "../../domain/work/request-spaces.ts";
import {
  caseExecutionContext,
  delegatedCaseContext,
} from "../work/cases/runtime.ts";
import {
  candidateCaseInvocation,
  changeCaseInvocation,
  invocationInput,
  invocationKey,
} from "../work/operators/journal.ts";
import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../work/operators/command-delivery.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import { sameCaseIdentity } from "../../domain/work/execution/case-context.ts";
import { requestOperatorSystemName } from "../governance/operator-authority-values.ts";
import {
  isTeamOperatorSpec,
  MAIN_EXECUTION_SPACE_ID,
  mainExecutionSpace,
  OperatorAuthorityError,
} from "../../domain/governance/operator-authority.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import type { RequestSpaceAuthorityBridge } from "../governance/request-space-authority-bridge.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import {
  deliverRequestAuthorityRoute,
  requestAuthorityRoute,
} from "../governance/request-authority-routing.ts";
import { toolAdmissionDecisionContext } from "../governance/operator-tool-admission-context.ts";
import type {
  ChatContext,
  ChatDecision,
  RequestOpeningOutcome,
  RequestResumeOutcome,
  SystemRuntimeState,
} from "../../domain/work/dialogue.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import type { Case } from "../../domain/work/entities/cases.ts";
import type { ClockPort } from "../work/runtime/ports.ts";
import { SystemRuntime } from "../work/runtime/system.ts";
import {
  OperatorConversationError,
  OperatorConversations,
} from "../work/operators/conversations.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { StorePort } from "../work/runtime/ports.ts";
import type { StateHistoryPort } from "../../domain/work/history.ts";
import { SkillsBehavior } from "../skills/behavior.ts";
import type { WorkspaceRuntime } from "../work/operators/workspace-registry.ts";
import { createWorkspaceBranchReads } from "./request-space-authority-bridge.ts";
/** What a Main Operator does after a refused branch opening. */
const REQUEST_OPENING_RECOVERY: Record<RequestSpaceError["code"], string> = {
  INVALID_COMMAND:
    "Send a non-empty objective and current main or an exact listed Release.",
  OPENING_CONFLICT:
    "Reuse an openingId only for the identical opening; use a new openingId for another Request.",
  FORBIDDEN:
    "Your mandate's open-request act or the person's space control does not admit this opening; tell the person.",
  ADMISSION_REFUSED:
    "The Request's space admission is unavailable; tell the person.",
  UNAVAILABLE: "Retry later with the same openingId.",
  PROVISIONING_UNAVAILABLE: "Retry later with the same openingId.",
};
/** Current authority and exact accepted-command recovery for workspace runtimes. */
export function createWorkspaceOperatorAuthority(options: {
  primary: SystemRuntime;
  primaryModel: ExecutableModel;
  runtimes: ReadonlyMap<
    string,
    Pick<WorkspaceRuntime, "runtime" | "model" | "scope">
  >;
  storage: {
    operator(
      id: string,
    ): Promise<
      {
        state: Pick<StorePort, "load"> & Pick<StateHistoryPort, "loadRevision">;
      }
    >;
  };
  assertCommandOrigin(origin: OperatorCommandOrigin): Promise<void>;
  assertArtifactSourceOrigin(
    publication: QueuedArtifactSourcePublication,
  ): Promise<void>;
  assertSkillAuthority: SkillsBehavior["assertCurrentAuthority"];
  conversations: Pick<
    OperatorConversations,
    "inspectCandidate" | "decideCandidate" | "decideChange"
  >;
  reconcile(options: { onlyNew: boolean }): Promise<void>;
  recoveryError(error: OperatorAuthorityError): void;
  clock: ClockPort;
  branchAuthority?: Pick<
    RequestSpaceAuthorityBridge,
    "mainView" | "decide" | "recipientSpace"
  >;
  /** Host-internal Main Operator openings of branch Requests (4.8d D3). */
  requestOpenings?: {
    openForMain(
      command: Pick<OpeningCommand, "text" | "source">,
      opener: MainOpener,
    ): Promise<OpeningView>;
    /** The exact Releases a Request may start from, newest first. */
    releases(): Promise<NonNullable<ChatContext["requestOpening"]>["releases"]>;
    /** The registered Main writes to an open branch Request's BO (Q3). */
    writeForMain(
      caseId: string,
      written: {
        resumeId: string;
        instruction: string;
        at: string;
        operatorId?: string;
      },
      opener: MainOpener,
    ): Promise<void>;
  };
}) {
  const { runtimes, conversations, clock, primaryModel: primary } = options;
  const { branchDecider, branchView, awaitingPersonContext, emptyBranchView } =
    createWorkspaceBranchReads({
      primary: options.primary,
      runtimes,
      bridge: options.branchAuthority,
      authorityRoute,
    });
  /** Main-space routes read the requester's own policies in its main space. */
  function requesterSpace(state: SystemRuntimeState) {
    return mainExecutionSpace((state.executionModel?.identity ?? state.model)!);
  }

  /** Main's design conversation opens branch Requests under the `open-request`
   * act of its own mandate and resumes the main Requests it opened (4.8d D3). */
  function mainRequestOpening(runtime: SystemRuntime) {
    const main = requestOpeningHost({
      primary: options.primary,
      caller: runtime,
      runtimes: () => [...runtimes.values()].map((entry) => entry.runtime),
    });
    const designer = () => {
      const state = runtime.snapshot;
      return state.caseInvocation?.kind === "designer" &&
          state.caseInvocation.scopeId === state.designer?.scopeId &&
          state.executionModel
        ? state
        : undefined;
    };
    return {
      /** A main Request it opened, or an open branch Request: there the
       * instruction reaches the BO as the Main Operator's input (Q3). */
      async resumeRequest(
        command: Extract<ChatDecision, { kind: "resume_request" }>,
      ): Promise<RequestResumeOutcome> {
        const state = designer();
        const branch = (await branchView(runtime)).openRequests.find((
          entry,
        ) => entry.caseId === command.caseId);
        if (!branch) return await main.resumeRequest(command);
        const decider = branchDecider(runtime);
        if (
          !state || !decider || !options.requestOpenings
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only Main's design conversation can write to this Request",
            { caseId: command.caseId },
          );
        }
        await options.requestOpenings.writeForMain(command.caseId, {
          resumeId: command.resumeId,
          ...(command.operatorId ? { operatorId: command.operatorId } : {}),
          instruction: command.instruction,
          at: clock.now(),
        }, {
          operator: decider,
          origin: {
            conversationId: state.id,
            designerScopeId: state.designer!.scopeId,
            openingId: command.resumeId,
          },
        });
        return {
          caseId: command.caseId,
          operatorId: command.operatorId ?? branch.operatorId,
          status: branch.status,
        };
      },
      /** The Case a delegated policy names, as its execution space (4.8d D4). */
      recipientSpaceFor(
        caseId: string,
        recipients: readonly string[],
      ): Promise<string> {
        const decider = branchDecider(runtime);
        if (!decider) {
          return Promise.reject(
            new OperatorAuthorityError(
              "INVALID_AUTHORITY_POLICY",
              "Request branches are unavailable on this host",
              { recipientCaseId: caseId },
            ),
          );
        }
        return options.branchAuthority!.recipientSpace(
          decider,
          caseId,
          recipients,
        );
      },
      async requestOpeningContext(): Promise<ChatContext["requestOpening"]> {
        const state = designer();
        if (!state) return undefined;
        const mainRequests = main.mainRequests() ?? [];
        // Main Requests stay discoverable on a host without branch openings.
        return {
          canOpen: !!options.requestOpenings &&
            state.executionModel!.mandate.mayOpenRequests === true,
          requests: (await branchView(runtime)).openRequests,
          releases: options.requestOpenings
            ? await options.requestOpenings.releases()
            : [],
          ...(mainRequests.length ? { mainRequests } : {}),
        };
      },
      async openRequest(
        command: Extract<ChatDecision, { kind: "open_request" }>,
      ): Promise<RequestOpeningOutcome> {
        const state = designer();
        const decider = branchDecider(runtime);
        if (!state || !options.requestOpenings || !decider) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only Main's design conversation can open a Request",
          );
        }
        try {
          const view = await options.requestOpenings.openForMain(
            { text: command.objective, source: command.source },
            {
              operator: decider,
              origin: {
                conversationId: state.id,
                designerScopeId: state.designer!.scopeId,
                openingId: command.openingId,
              },
            },
          );
          return {
            status: "opened",
            caseId: view.caseId,
            caseNumber: view.caseNumber,
            executionSpaceId: view.executionSpaceId,
            phase: view.phase,
            ...(view.issues.length ? { issues: view.issues } : {}),
          };
        } catch (error) {
          if (!(error instanceof RequestSpaceError)) throw error;
          return {
            status: "refused",
            code: error.code,
            recovery: error.recovery ?? REQUEST_OPENING_RECOVERY[error.code],
            ...(error.context ? { context: error.context } : {}),
          };
        }
      },
    };
  }

  function authorityRoute(runtime: SystemRuntime, change: PendingChange) {
    return requestAuthorityRoute({
      space: requesterSpace(runtime.snapshot),
      requester: runtime.snapshot,
      change,
      states: [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      root: {
        kind: "main-opener",
        mainOperatorId:
          options.primary.snapshot.executionModel!.identity.builderId,
      },
    });
  }

  async function forwardProposal(
    runtime: SystemRuntime,
    change: PendingChange,
  ) {
    if (
      !change.caseId || !change.requestedBy || change.status !== "pending" ||
      change.publishedCommit
    ) {
      return;
    }
    await deliverRequestAuthorityRoute({
      space: requesterSpace(runtime.snapshot),
      requester: runtime.snapshot,
      change,
      states: [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      mainOperatorId:
        options.primary.snapshot.executionModel!.identity.builderId,
      async receive(operatorId, notice, origin, delivery) {
        await runtimes.get(operatorId)!.runtime.receiveOperatorNotice(
          notice,
          origin,
          delivery,
        );
      },
    });
  }

  async function forwardCompletion(runtime: SystemRuntime, record: Case) {
    if (
      !record.openedFrom.changeId ||
      !["closed-done", "closed-abandoned"].includes(record.status)
    ) return;
    const opener = runtimes.get(record.openedBy)?.runtime;
    if (!opener) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The Request opener is unavailable",
        { caseId: record.id },
      );
    }
    const result =
      runtime.snapshot.messages.filter((message) =>
        message.caseId === record.id && message.role === "assistant"
      ).at(-1)?.text ?? "";
    await opener.receiveOperatorNotice({
      kind: "request-completed",
      caseId: record.id,
      owner: record.owner,
      openedBy: record.openedBy,
      status: record.status as "closed-done" | "closed-abandoned",
      result,
    }, record.openedFrom);
  }

  async function openApprovedOperator(
    runtime: SystemRuntime,
    change: PendingChange,
  ) {
    const completing = change.status === "pending" && !!change.publishedCommit;
    if (
      change.kind !== "operator-creation" ||
      change.status !== "approved" && !completing
    ) {
      return;
    }
    if (
      !change.requestedBy || !change.operator || !change.publishedCommit ||
      change.requestedBy !== runtime.snapshot.executionModel!.identity.builderId
    ) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The approved creation is missing its exact provenance",
        { changeId: change.id },
      );
    }
    await options.reconcile({ onlyNew: true });
    const source = runtimes.get(change.requestedBy);
    if (!source) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The creation author is not registered",
        { changeId: change.id },
      );
    }
    const name = await requestOperatorSystemName(source.scope, change.id);
    const target = [...runtimes.values()].find((entry) => entry.scope === name);
    if (isTeamOperatorSpec(change.operator)) {
      const model = target?.runtime.snapshot.executionModel;
      const team = model?.operatorTeam;
      if (
        !target || !model || !change.teamOrigin ||
        team?.parentOperatorId !== change.requestedBy ||
        team.requestOwnerId !== change.teamOrigin.operatorId ||
        team.requestId !== change.teamOrigin.requestId ||
        !model.operatorEntries?.some((entry) => entry.kind === "inbox")
      ) {
        throw new OperatorAuthorityError(
          "OPERATOR_OPEN_FAILED",
          "The published team operator or its exact Request provenance is unavailable",
          { changeId: change.id },
        );
      }
      // Its admitted inbox receives work with the existing root Request context.
      // Creating a durable team member never opens a second human conversation.
      return;
    }
    const operator = change.operator;
    // A saved Case alone does not prove its first input was durably accepted.
    // The runtime opening method reconciles that gap with the same receipt ID.
    const model = target?.runtime.snapshot.executionModel;
    const type = model?.caseTypes?.find((entry) =>
      entry.type === "request" &&
      entry.name === operator.requestType.name
    );
    if (
      !target || !model || !type || type.ownerId !== model.identity.builderId ||
      type.maxInvocations !== operator.requestType.maxInvocations
    ) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The published operator or Request type is unavailable",
        { changeId: change.id },
      );
    }
    await target.runtime.openOperatorRequest({
      changeId: change.id,
      caseTypeId: type.id,
      objective: operator.firstRequest.objective,
      openedBy: change.requestedBy,
      openedFrom: {
        conversationId: runtime.snapshot.id,
        ...(change.caseId
          ? { caseId: change.caseId }
          : { designerScopeId: change.designerScopeId }),
      },
    });
  }

  async function commandSource(
    origin: OperatorCommandOrigin,
    actorId: string,
    revalidateCurrent = true,
  ) {
    const reference = origin.businessRevision.__assemblyRuntimeRevision;
    const actor = runtimes.get(actorId);
    if (
      !actor || reference.operatorId !== actorId || !reference.invocationKey
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source operator scope is unavailable",
        { actorId },
      );
    }
    await options.assertCommandOrigin(origin);
    const store = (await options.storage.operator(actorId)).state;
    const historical = await store.loadRevision(reference.revision);
    const current = await store.load();
    if (
      !historical || !current || historical.id !== reference.systemId ||
      current.id !== reference.systemId ||
      current.executionModel?.identity.builderId !== actorId ||
      historical.executionModel?.identity.builderId !== actorId ||
      historical.executionModel.version.digest !== reference.modelDigest ||
      !historical.caseInvocation ||
      invocationKey(historical.caseInvocation) !== reference.invocationKey ||
      invocationInput(historical)?.id !== origin.inputMessageId ||
      revalidateCurrent &&
        (canonical(
              invocationInput({
                ...current,
                caseInvocation: historical.caseInvocation,
                activeInputMessageId: origin.inputMessageId,
              }, historical.caseInvocation),
            ) !== canonical(invocationInput(historical)) ||
          canonical(current.executionModel?.version) !==
            canonical(historical.executionModel.version))
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The exact original command input or adopted actor contract changed",
        { actorId },
      );
    }
    const localCaseId = historical.caseInvocation.kind === "local"
      ? historical.caseInvocation.caseId
      : undefined;
    if (
      revalidateCurrent && localCaseId &&
      !current.cases?.some((record) =>
        record.id === localCaseId && isOpenCase(record)
      )
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source Request is no longer open",
        { actorId },
      );
    }
    if (revalidateCurrent) {
      if (!current.model || !current.executionModel) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "The admitted actor model is unavailable",
          { actorId },
        );
      }
      const actual = await actor.model.readExecutableModel(
        current.model,
        current.executionModel.version.repositoryVersion,
      );
      if (
        actual.identity.builderId !== actorId ||
        canonical(actual.version) !== canonical(current.executionModel.version)
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "The current actor grant does not match its immutable admitted source",
          { actorId },
        );
      }
      current.executionModel = actual;
    }
    return { historical, current };
  }

  async function refreshCommandCase(
    target: SystemRuntime,
    candidateId?: string,
    changeId?: string,
  ): Promise<void> {
    const selected = target.snapshot;
    const candidate = selected.candidates.find((value) =>
      value.id === candidateId
    );
    const change = selected.configuration?.changes.find((value) =>
      value.id === changeId
    );
    const invocation = candidate
      ? candidateCaseInvocation(selected, candidate)
      : change
      ? changeCaseInvocation(selected, change)
      : undefined;
    const previous = invocation?.kind === "delegated"
      ? invocation.work.caseContext
      : invocation
      ? undefined
      : delegatedCaseContext(selected);
    if (!previous) return;
    const states = await Promise.all(
      [...runtimes.keys()].map(async (id) =>
        (await options.storage.operator(id)).state.load()
      ),
    );
    const owners = states.filter((state): state is SystemRuntimeState =>
      !!state &&
      !!state.cases?.some((record) =>
        record.id === previous.caseId &&
        record.owner === state.executionModel?.identity.builderId
      )
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    const record = owner?.cases?.find((value) => value.id === previous.caseId);
    const context = owner &&
      caseExecutionContext({
        ...owner,
        caseInvocation: { kind: "local", caseId: previous.caseId },
      });
    if (
      !record || !isOpenCase(record) || !context ||
      !sameCaseIdentity(context, previous)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The authoritative Request is closed or changed",
        { caseId: previous.caseId },
      );
    }
    await target.refreshCaseContext(context, candidateId, changeId);
  }

  async function assertDelegatedCommand(
    target: SystemRuntime,
    command: Extract<
      OperatorControlCommand,
      { kind: "decide-candidate" | "decide-change" }
    >,
    origin: OperatorCommandOrigin,
  ): Promise<void> {
    const delegated = command.delegated;
    if (!delegated) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The delegated actor receipt is absent",
        {},
      );
    }
    const { historical, current } = await commandSource(
      origin,
      delegated.actorId,
    );
    const targetState = target.snapshot;
    const selected = exactDelegatedCommandDecision(
      historical,
      targetState.executionModel!.identity.builderId,
      command,
      origin,
    );
    if (!selected) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source revision does not contain this exact started operator decision",
        { actorId: delegated.actorId },
      );
    }
    if (command.kind === "decide-candidate") {
      const message = historical.messages.find((value) =>
        value.id === origin.inspectionMessageId
      );
      const value = message?.observation?.value as {
        decisionReference?: Record<string, unknown>;
      } | undefined;
      const expected = value?.decisionReference;
      if (
        !message || !expected ||
        exactCandidateInspection(historical, expected)?.id !== message.id ||
        expected.operatorId !==
          targetState.executionModel?.identity.builderId ||
        expected.candidateId !== command.input.candidateId ||
        expected.candidateDigest !== command.input.candidateDigest ||
        expected.caseId !== command.input.caseId ||
        selected.kind !== "decide_operator_candidate" ||
        selected.expectedRevision !== expected.expectedRevision ||
        expected.policyId !== delegated.policyId ||
        expected.policyRevision !== delegated.policyRevision ||
        !toolAdmissionDecisionContext(current.executionModel!, [targetState])
          .candidates.some((candidate) =>
            canonical({
              operatorId: candidate.operatorId,
              candidateId: candidate.candidateId,
              candidateDigest: candidate.candidateDigest,
              expectedRevision: candidate.expectedRevision,
              caseId: candidate.caseId,
              policyId: candidate.policyId,
              policyRevision: candidate.policyRevision,
            }) === canonical(expected)
          )
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The exact current candidate inspection and grant are unavailable",
          { candidateId: command.input.candidateId },
        );
      }
      await refreshCommandCase(target, command.input.candidateId);
    } else {
      const change = targetState.configuration?.changes.find((value) =>
        value.id === command.input.changeId
      );
      const states = await Promise.all(
        [...runtimes.keys()].map(async (id) =>
          (await options.storage.operator(id)).state.load()
        ),
      );
      const decider = change &&
        requestAuthorityRoute({
          space: requesterSpace(targetState),
          requester: targetState,
          change,
          states: states.filter((state): state is SystemRuntimeState => !!state)
            .map((state) =>
              state.executionModel?.identity.builderId === delegated.actorId
                ? current
                : state
            ),
          root: {
            kind: "main-opener",
            mainOperatorId: primary!.identity.builderId,
          },
        }).designatedDecider;
      if (
        !change || !decider || decider.operatorId !== delegated.actorId ||
        decider.policyId !== delegated.policyId ||
        decider.policyRevision !== delegated.policyRevision ||
        change.baseRevision !== command.input.expectedRevision
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Only the current designated actor may decide this exact change",
          { changeId: command.input.changeId },
        );
      }
      await refreshCommandCase(target, undefined, command.input.changeId);
    }
  }

  /** Every admitted holder can exercise only its exact current policy. */
  function delegatedAuthority(runtime: SystemRuntime) {
    const invalidatedInspectionIds = new Set<string>();
    const invalidateInspections = (
      candidate?: { candidateId: string; operatorId: string },
    ) => {
      for (const message of runtime.snapshot.messages) {
        if (message.observation?.kind !== "candidate-inspection") continue;
        const value = message.observation.value as {
          operatorId?: string;
          candidate?: { id?: string };
          context?: { candidateId?: string; operatorId?: string };
          decisionReference?: { candidateId?: string; operatorId?: string };
        } | undefined;
        const id = value?.candidate?.id ??
          value?.decisionReference?.candidateId ?? value?.context?.candidateId;
        const owner = value?.decisionReference?.operatorId ??
          value?.operatorId ?? value?.context?.operatorId;
        if (
          !candidate ||
          id === candidate.candidateId &&
            (!owner || owner === candidate.operatorId)
        ) invalidatedInspectionIds.add(message.id);
      }
    };
    type CandidateCommand = Extract<ChatDecision, {
      kind: "inspect_operator_candidate" | "decide_operator_candidate";
    }>;
    const reference = (
      command: Pick<
        CandidateCommand,
        | "operatorId"
        | "candidateId"
        | "candidateDigest"
        | "expectedRevision"
        | "caseId"
        | "policyId"
        | "policyRevision"
      >,
      revision = command.expectedRevision,
    ) => ({
      operatorId: command.operatorId,
      candidateId: command.candidateId,
      candidateDigest: command.candidateDigest,
      expectedRevision: revision,
      caseId: command.caseId,
      policyId: command.policyId,
      policyRevision: command.policyRevision,
    });
    const candidateContext = () =>
      toolAdmissionDecisionContext(
        runtime.snapshot.executionModel!,
        [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      );
    const candidateActor = (command: CandidateCommand) => ({
      actorId: runtime.snapshot.executionModel!.identity.builderId,
      policyId: command.policyId,
      policyRevision: command.policyRevision,
    });
    const candidateTarget = (command: CandidateCommand) => {
      const target = runtimes.get(command.operatorId)?.runtime;
      if (!target || target === runtime) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The exact recipient operator is unavailable",
          { operatorId: command.operatorId, candidateId: command.candidateId },
        );
      }
      return target;
    };
    const candidateError = (
      error: unknown,
      command: CandidateCommand,
    ): never => {
      if (error instanceof OperatorConversationError) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          error.message,
          {
            operatorId: command.operatorId,
            candidateId: command.candidateId,
            reason: error.code,
          },
        );
      }
      if (error instanceof OperatorAuthorityError) {
        throw new OperatorAuthorityError(error.code, error.message, {
          ...error.context,
          operatorId: command.operatorId,
          candidateId: command.candidateId,
        });
      }
      throw error;
    };
    return {
      ...(runtime === options.primary ? mainRequestOpening(runtime) : {}),
      clearCandidateInspection: () => invalidateInspections(),
      candidateDecisionContext: candidateContext,
      inspectCandidate: async (
        command: Extract<ChatDecision, { kind: "inspect_operator_candidate" }>,
      ) => {
        invalidateInspections(command);
        const target = candidateTarget(command);
        try {
          const inspection = await conversations.inspectCandidate({
            agentId: command.operatorId,
            candidateId: command.candidateId,
            candidateDigest: command.candidateDigest,
            expectedRevision: command.expectedRevision,
            caseId: command.caseId,
          }, candidateActor(command));
          return {
            ...inspection,
            decisionReference: reference(command, target.snapshot.revision),
          };
        } catch (error) {
          return candidateError(error, command);
        }
      },
      decideCandidate: async (
        command: Extract<ChatDecision, { kind: "decide_operator_candidate" }>,
        origin?: OperatorCommandOrigin,
      ) => {
        const target = candidateTarget(command);
        if (!origin) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "A delegated command requires its actual native effect origin",
            { candidateId: command.candidateId },
          );
        }
        const { historical } = await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
          false,
        );
        const inspection = exactCandidateInspection(
          historical,
          reference(command),
        );
        if (!inspection) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Inspect this exact candidate and Request before deciding",
            {
              operatorId: command.operatorId,
              candidateId: command.candidateId,
            },
          );
        }
        const exactOrigin = { ...origin, inspectionMessageId: inspection.id };
        const accepted: Extract<
          OperatorControlCommand,
          { kind: "decide-candidate" }
        > = {
          kind: "decide-candidate",
          input: {
            candidateId: command.candidateId,
            candidateDigest: command.candidateDigest,
            verdict: command.verdict,
            reason: command.reason.trim(),
            caseId: command.caseId,
          },
          delegated: candidateActor(command),
        };
        if (
          !exactDelegatedCommandDecision(
            historical,
            command.operatorId,
            accepted,
            exactOrigin,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The source revision does not contain this exact started candidate decision",
            { candidateId: command.candidateId },
          );
        }
        if (await target.resumeOperatorCommand(accepted, exactOrigin)) return;
        if (invalidatedInspectionIds.has(inspection.id)) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The last inspection was invalidated; inspect the exact candidate again",
            { candidateId: command.candidateId },
          );
        }
        await commandSource(
          exactOrigin,
          runtime.snapshot.executionModel!.identity.builderId,
        );
        if (
          !candidateContext().candidates.some((candidate) =>
            canonical(reference(candidate)) === canonical(reference(command))
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The current delegated candidate grant or revision changed",
            {
              operatorId: command.operatorId,
              candidateId: command.candidateId,
            },
          );
        }
        try {
          await conversations.decideCandidate(
            {
              agentId: command.operatorId,
              candidateId: command.candidateId,
              candidateDigest: command.candidateDigest,
              expectedRevision: command.expectedRevision,
              caseId: command.caseId,
              verdict: command.verdict,
              reason: command.reason,
            },
            candidateActor(command),
            exactOrigin,
          );
        } catch (error) {
          candidateError(error, command);
        }
      },
      decisionContext: async () => ({
        policies: structuredClone(
          (runtime.snapshot.executionModel?.operatorAuthorityPolicies ?? [])
            .filter((policy) =>
              policy.holderNativeId ===
                runtime.snapshot.executionModel?.identity.builderId
            ),
        ),
        requests: [
          ...[...runtimes.values()].flatMap((entry) =>
            (entry.runtime.snapshot.configuration?.changes ?? []).filter(
              (change) =>
                change.status === "pending" &&
                !change.publishedCommit &&
                change.requestedBy !==
                  runtime.snapshot.executionModel?.identity.builderId &&
                authorityRoute(entry.runtime, change).designatedDecider
                    ?.operatorId ===
                  runtime.snapshot.executionModel?.identity.builderId,
            ).map((
              { id, requestedBy, caseId, baseRevision, requestedRights, kind },
            ) => ({
              id,
              requestedBy,
              caseId,
              baseRevision,
              requestedRights: structuredClone(requestedRights),
              executionSpaceId: MAIN_EXECUTION_SPACE_ID,
              requester: scopedOperator(
                requesterSpace(entry.runtime.snapshot),
                requestedBy ?? "",
              ),
              changeKind: kind,
            }))
          ),
          ...(await branchView(runtime)).requests,
        ],
        ...(await awaitingPersonContext(runtime)),
      }),
      decide: async (
        command: Extract<ChatDecision, { kind: "decide_operator_change" }>,
        origin?: OperatorCommandOrigin,
      ) => {
        // A covered Branch Operator request lives in its Case's space: the
        // host derives that space from the Case, never from the command. A
        // change the MO already decided is found by its record, so a replay
        // of the command resumes its publication and adoption (A4).
        const mainDecider = branchDecider(runtime);
        const current = mainDecider
          ? await options.branchAuthority!.mainView(mainDecider)
          : emptyBranchView;
        const branch = [...current.requests, ...current.recorded].find((
          entry,
        ) => entry.id === command.changeId);
        if (branch) {
          if (!origin) {
            throw new OperatorAuthorityError(
              "AUTHORITY_OUT_OF_BOUNDS",
              "A delegated command requires its actual native effect origin",
              { changeId: command.changeId },
            );
          }
          await options.branchAuthority!.decide({
            caseId: branch.caseId!,
            command,
            origin,
          });
          return;
        }
        const target = runtimes.get(command.operatorId)?.runtime;
        if (!target) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The operator is unavailable",
            { changeId: command.changeId },
          );
        }
        if (!origin) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "A delegated command requires its actual native effect origin",
            { changeId: command.changeId },
          );
        }
        const { historical } = await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
          false,
        );
        const accepted: Extract<
          OperatorControlCommand,
          { kind: "decide-change" }
        > = {
          kind: "decide-change",
          input: {
            changeId: command.changeId,
            expectedRevision: command.expectedRevision,
            verdict: command.verdict,
          },
          delegated: {
            actorId: runtime.snapshot.executionModel!.identity.builderId,
            policyId: command.policyId,
            policyRevision: command.policyRevision,
          },
        };
        if (
          !exactDelegatedCommandDecision(
            historical,
            command.operatorId,
            accepted,
            origin,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The source revision does not contain this exact started change decision",
            { changeId: command.changeId },
          );
        }
        if (await target.resumeOperatorCommand(accepted, origin)) return;
        await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
        );
        const change = target.snapshot.configuration?.changes.find((entry) =>
          entry.id === command.changeId
        );
        const decider = change &&
          authorityRoute(target, change).designatedDecider;
        if (
          !decider ||
          decider.operatorId !==
            runtime.snapshot.executionModel!.identity.builderId ||
          decider.policyId !== command.policyId ||
          decider.policyRevision !== command.policyRevision
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only the current designated responsible actor may decide this exact change",
            { changeId: command.changeId },
          );
        }
        // Domain revalidation at effect time remains mandatory, independently of routing.
        await conversations.decideChange({
          agentId: command.operatorId,
          changeId: command.changeId,
          expectedRevision: target.snapshot.revision,
          configurationRevision: command.expectedRevision,
          verdict: command.verdict,
        }, {
          actorId: runtime.snapshot.executionModel!.identity.builderId,
          policyId: command.policyId,
          policyRevision: command.policyRevision,
        }, origin);
      },
    };
  }

  function bindAuthority(runtime: SystemRuntime) {
    runtime.bindOperatorCommandAuthority((command, origin) =>
      assertDelegatedCommand(runtime, command, origin)
    );
    runtime.bindArtifactSourceAuthority(async (publication) => {
      const proof = publication.proof;
      if (proof.kind === "skill-authority") {
        await options.assertSkillAuthority(
          proof.authority,
          "install",
        );
      } else if (
        proof.kind === "native-action" ||
        proof.kind === "admitted-model-seed" &&
          publication.source.kind === "tool-draft"
      ) {
        await options.assertArtifactSourceOrigin(publication);
      } else if (
        proof.kind === "admitted-model-seed" &&
        publication.source.kind === "skill-document"
      ) {
        // Startup skill retention has no graph effect. The runtime has already
        // checked exact historical/current source selection, bytes and policy.
        return;
      } else {
        // Production tool reuse is retained by its real native promotion action.
        // A copied modeled-behavior DTO has no independent effect proof here.
        throw new ArtifactSourceError("scope");
      }
    });
    runtime.bindOperatorAuthorityLifecycle({
      ...delegatedAuthority(runtime),
      proposed: (change) => forwardProposal(runtime, change),
      approved: (change) => openApprovedOperator(runtime, change),
      closed: (record) => forwardCompletion(runtime, record),
    });
  }

  async function recover() {
    // Recover openings and deliveries from durable facts, with idempotent recipient IDs.
    for (const entry of [...runtimes.values()]) {
      for (
        const change of entry.runtime.snapshot.configuration?.changes ?? []
      ) {
        if (
          change.status === "approved" && change.kind === "operator-creation"
        ) {
          try {
            await openApprovedOperator(entry.runtime, change);
          } catch (error) {
            if (
              !(error instanceof OperatorAuthorityError) ||
              error.code !== "OPERATOR_OPEN_FAILED"
            ) throw error;
            options.recoveryError(error);
          }
        }
        if (change.status === "pending") {
          await forwardProposal(entry.runtime, change);
        }
      }
      for (const record of entry.runtime.cases.cases) {
        await forwardCompletion(entry.runtime, record);
      }
    }
  }
  async function verifyArtifactSourcePublication(
    publication: QueuedArtifactSourcePublication,
  ): Promise<void> {
    const target = runtimes.get(publication.target.operatorId)?.runtime;
    if (
      !target || publication.target.ownerId !== publication.target.operatorId
    ) throw new ArtifactSourceError("scope");
    await target.assertArtifactSourcePublication(publication);
  }
  return { bindAuthority, recover, verifyArtifactSourcePublication };
}

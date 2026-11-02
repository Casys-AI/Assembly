import { adoptionRequester } from "../../application/model/evolution/request-adoption-invariants.ts";
import { caseExecutionContext } from "../../application/work/cases/runtime.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import { sameScopedOperator } from "../../domain/governance/operator-authority.ts";
import type { MainOpener } from "../../domain/work/request-spaces.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../../infrastructure/logging.ts";

import type { ScopedOperatorRef } from "../../domain/governance/authority.ts";
import {
  parseRequestCreationGrantAuthority,
  parseRequestDelegatedAuthority,
} from "../../application/model/source-admission/request-delegated-authority.ts";
import type {
  ScopedSoftwareEvolutionBinding,
  ScopedSoftwareRuntimeTarget,
} from "./scoped-software-evolution.ts";
import type { RequestNetworkChangePreparationPort } from "./request-network-change-sources.ts";
import type { RetainedToolsPort } from "../../application/work/tools/active-tools.ts";
import { assertRetainedCatalog } from "../../application/work/tools/retained-catalog.ts";
import {
  retainedToolDescriptors,
  retainedToolResourceId,
} from "../../domain/work/retained-tool-dependencies.ts";
import type {
  RequestExecutionBinding,
  RequestExecutionBindingPort,
  RequestOwnerAdoptionDossier,
} from "../../application/model/evolution/request-adoption-ports.ts";
import type {
  NativeChangeApprovalWait,
  NativeExecutionSnapshot,
  RequestNetworkContinuation,
  RequestNetworkRefusalContinuation,
} from "../../application/work/runtime/execution.ts";
import { OperatorInboxBehavior } from "../../application/work/behaviors/operator-inbox.ts";
import { BehaviorInvocationRegistry } from "../../application/work/behaviors/invocation.ts";
import { exactNativeChangeApprovalWait } from "../../application/work/runtime/evolution.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import {
  decidedByNetworkAuthority,
} from "../../domain/governance/records/request-network-change.ts";
import {
  decidedByTeamAuthority,
  requestChangeEffect,
  requestChangeProposalDigest,
} from "../../domain/governance/records/request-change.ts";
import { canonicalDigest } from "../../domain/primitives/execution-digest.ts";
import { PostgresRequestSourceAdmissionStore } from "../out/postgres/request-source-admission-store.ts";
import { readRequestInitialExecutionOutcome } from "../../application/work/request-spaces/initial-execution-outcome.ts";
import {
  conversationUnit,
  OperatorConversations,
  type OperatorConversationUnit,
} from "../../application/work/operators/conversations.ts";
import type { AgentMessageCommand } from "../../domain/work/records/conversations.ts";
import { SystemRuntime } from "../../application/work/runtime/system.ts";
import {
  assertRequestSpaceBirth,
  type RequestSpaceSeed,
} from "../../application/work/runtime/initialization.ts";
import {
  invocationKey,
  requestChangeInvocation,
} from "../../application/work/operators/journal.ts";
import type { OperatorExecutionDelivery } from "../../application/work/operators/execution.ts";
import type {
  OpeningSourcePort,
  OpeningStorePort,
  RequestBranchPort,
  RequestSpaceRuntimePort,
  SpaceAdmissionPort,
} from "../../application/work/request-spaces/ports.ts";
import {
  assertBaseForChoice,
  branchTeam,
  type BranchTeamMember,
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceExecutionAdmission,
} from "../../domain/work/request-spaces.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import { WorkBudgetService } from "../../application/work/budget/service.ts";
import {
  RequestSpaceModel,
  type RequestTeamCreationModelReader,
  requestTeamCreationReceiptVerifies,
} from "../../application/work/request-spaces/request-space-model.ts";
import type {
  OperatorStorage,
  PostgresHostStorage,
} from "../out/postgres/host-storage.ts";
import type { PostgresAdmittedRequestRuntime } from "./runtime/postgres.ts";
import type { ResolvedOperatorScope } from "./runtime/operator-dispatch.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";

const log = technicalLogger("composition");

/** Host dependencies only. Mutable information services must be built from the
 * supplied scoped stores, never inherited from Main's workspace. */
export type RequestSpaceRuntimeDependencies =
  & Omit<
    ConstructorParameters<typeof SystemRuntime>[0],
    | "caseNumbers"
    | "model"
    | "store"
    | "stateHistory"
    | "execution"
    | "dispatch"
    | "workBudget"
    | "artifactSources"
  >
  & {
    /** Called only by explicit opening preparation after the inert birth CAS. */
    initialSkills?: { initialize(): Promise<void> };
  };
export interface RequestSpaceRuntimeOptions {
  mainSnapshot?(): SystemRuntimeState | undefined;
  /** Immutable software composition for the actual admitted Request instance. */
  softwareEvolutionFactory?(input: {
    actor: ScopedSoftwareRuntimeTarget;
    resolve(
      ref: Readonly<ScopedOperatorRef>,
    ): Promise<ScopedSoftwareRuntimeTarget>;
  }): Promise<ScopedSoftwareEvolutionBinding>;
  networkChanges?: RequestNetworkChangePreparationPort;
  /** Bind scoped informational authority before inert restoration, never a human credential. */
  bindRequestAuthority?(record: OpeningRecord, runtime: SystemRuntime): void;
  recoverRequestAuthority?(
    record: OpeningRecord,
    runtime: SystemRuntime,
  ): Promise<void>;
  storage: PostgresHostStorage;
  native: PostgresAdmittedRequestRuntime;
  openings: OpeningStorePort;
  source: OpeningSourcePort;
  branches: RequestBranchPort;
  admissions: SpaceAdmissionPort;
  executionBindings?: RequestExecutionBindingPort;
  /** Resolve retained exact assets outside SQL and compare against canonical R. */
  resolveExecutionModel?(
    opening: OpeningRecord,
    binding: RequestExecutionBinding,
  ): Promise<ExecutableModel>;
  /** Every executed model at the binding's pin (4.8e E4): the team a space
   * opens with, instead of its birth models. */
  resolveTeamModels?(
    opening: OpeningRecord,
    binding: RequestExecutionBinding,
  ): Promise<readonly ExecutableModel[]>;
  resolveTeamCreationModels?: RequestTeamCreationModelReader;
  dependencies(
    stores: OperatorStorage,
    model: ExecutableModel,
    currentSnapshot: () => SystemRuntimeState | undefined,
  ): RequestSpaceRuntimeDependencies;
  /** Advisory: a committed adoption now runs in this Case (its model moved).
   * Called after restoration; it cannot fail or delay the adoption. */
  onExecutionModelRestored?(opening: OpeningRecord): void;
}
interface RequestHandle {
  runtime: SystemRuntime;
  stores: OperatorStorage;
  model: ExecutableModel;
  birthModel: ExecutableModel;
  signature: string;
  generation: string;
  /** Verified branch team of this handle's pin (spec 4.8e E3). */
  team: BranchTeamMember[];
  teamUnits: OperatorConversationUnit[];
  /** Members that failed to open in this handle, with their refusal code. */
  unavailableMembers: Array<{ operatorId: string; code: string }>;
  initialSkills?: RequestSpaceRuntimeDependencies["initialSkills"];
  conversations?: Promise<OperatorConversations>;
  /** The opened members of the space registry, by native operator ID. */
  members: Map<string, SystemRuntime>;
  softwareEvolution?: ScopedSoftwareEvolutionBinding;
  evolutionRecoveryStarted?: boolean;
}
function conflict(
  message: string,
  details: {
    code?: "OPENING_CONFLICT" | "UNAVAILABLE" | "FORBIDDEN";
    context?: Record<string, unknown>;
  } = {},
): never {
  throw new RequestSpaceError(details.code ?? "OPENING_CONFLICT", message, {
    context: details.context ?? { operation: "request-space", reason: message },
    recovery: "Reload the Request and retry with its current admitted state.",
  });
}
/** The BO's creation changes, from every host-carried configuration that can
 * hold them (bound state, resumed snapshot, pinned model), deduplicated on
 * the change id: the same approved change may reappear with a later
 * `publishedCommit`, and two copies would make its child unverifiable. */
export function ownerChangesOf(
  ...sources: Array<
    | { configuration?: { changes?: readonly PendingChange[] } }
    | ExecutableModel
    | undefined
  >
): PendingChange[] {
  const seen = new Set<string>();
  const changes: PendingChange[] = [];
  for (const source of sources) {
    for (const change of source?.configuration?.changes ?? []) {
      if (seen.has(change.id)) continue;
      seen.add(change.id);
      changes.push(change);
    }
  }
  return changes;
}
export function requestSpaceSeed(record: OpeningRecord): RequestSpaceSeed {
  return {
    runtimeId: `request:${record.executionSpaceId}:${
      record.base!.requestOwner.operatorId
    }`,
    openingId: record.id,
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    caseTypeId: record.base!.requestOwner.caseTypeId,
    initialContributionId: record.initialContributionId,
    createdAt: record.createdAt,
    // A Main Operator opening is opened by it; the space stays the owner's.
    openedBy: record.command.opener?.operator.operatorId ?? record.ownerId,
    text: record.command.text,
  };
}
/** The Request's first input. A Main Operator opening is authored by the
 * Main Operator (4.8d D3): it reaches the BO as an operator's input, so URLs in
 * it are never the person's selection and its hosts follow the network route. */
export function requestSpaceInitialDelivery(
  record: OpeningRecord,
  modelPin: OperatorExecutionDelivery["modelPin"],
): OperatorExecutionDelivery {
  const invocation = { kind: "local" as const, caseId: record.caseId };
  return {
    id: record.initialContributionId,
    kind: "contribution",
    identity: {
      operatorId: record.base!.requestOwner.operatorId,
      invocationKey: invocationKey(invocation),
      scope: {
        kind: "request",
        scopeId: record.caseId,
        rootRequestId: record.caseId,
      },
      purpose: "conversation",
      subjectId: record.initialContributionId,
    },
    modelPin: structuredClone(modelPin),
    payload: {
      text: record.command.text,
      origin: record.command.opener ? "delegation" : "human",
      invocation,
      caseId: record.caseId,
      receivedAt: record.createdAt,
    },
  };
}
function birthSignature(record: OpeningRecord): string {
  return canonical({
    seed: requestSpaceSeed(record),
    scope: record.scope,
    branchId: record.branchId,
    base: record.base,
    baseDigest: record.baseDigest,
    command: record.command,
    commandDigest: record.commandDigest,
  });
}

/** One host factory; scoped handles own no pools, workers or lifecycle. */
export class RequestSpaceRuntime implements RequestSpaceRuntimePort {
  readonly #handles = new Map<string, Promise<RequestHandle>>();
  readonly #handleTurns = new Map<string, Promise<void>>();
  constructor(private readonly options: RequestSpaceRuntimeOptions) {
    const host = options.storage.scope;
    const native = options.native.ledger;
    if (
      native.client !== options.storage.client ||
      native.options.scope.projectId !== host.projectId ||
      native.options.scope.systemId !== host.systemId ||
      native.options.scope.executionSpaceId !== "main"
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The admitted Request runtime belongs to another host",
      );
    }
  }

  async #record(input: OpeningRecord): Promise<OpeningRecord> {
    const record = await this.options.openings.get(input.id);
    const scope = this.options.storage.scope;
    if (
      !record?.base || !record.baseDigest ||
      record.scope.projectId !== scope.projectId ||
      record.scope.systemId !== scope.systemId ||
      !["branch-ready", "runtime-ready", "admitted", "dispatched"].includes(
        record.phase,
      ) ||
      !input.base || birthSignature(input) !== birthSignature(record)
    ) conflict("The recorded Request opening or host scope differs");
    assertBaseForChoice(record.base, record.command.source);
    if (
      await requestSpaceDigest(record.base) !== record.baseDigest ||
      await requestSpaceDigest({
          scope: record.scope,
          ownerId: record.ownerId,
          command: record.command,
        }) !== record.commandDigest
    ) conflict("The recorded Request base or command digest differs");
    // A later publication may precede its SQL source receipt. Execution proves
    // retained B0 independently of strict current-source consultation.
    await this.options.branches.assertRetainedExecutionVersion(
      record,
      record.base.manifest.source!.sourceVersion,
    );
    return record;
  }

  async #binding(
    record: OpeningRecord,
    requester?: ScopedOperatorRef,
  ): Promise<RequestExecutionBinding | undefined> {
    return ["admitted", "dispatched"].includes(record.phase)
      ? await this.options.executionBindings?.read(record, requester)
      : undefined;
  }
  #generation(binding?: RequestExecutionBinding): string {
    return binding
      ? canonical({
        pin: binding.pin,
        admissionRevision: binding.admission.revision,
      })
      : "birth";
  }
  async #handle(record: OpeningRecord): Promise<RequestHandle> {
    const key = canonical([
      record.executionSpaceId,
      record.base!.requestOwner.operatorId,
    ]);
    const work = (this.#handleTurns.get(key) ?? Promise.resolve()).then(() =>
      this.#currentHandle(record)
    );
    const settled = work.then(() => {}, () => {});
    this.#handleTurns.set(key, settled);
    void settled.then(() => {
      if (this.#handleTurns.get(key) === settled) this.#handleTurns.delete(key);
    });
    const handle = await work;
    if (
      ["admitted", "dispatched"].includes(record.phase) &&
      !handle.conversations && handle.team.length
    ) {
      // The handle may have been provisioned before admission; the space
      // registry (BO + verified team) opens on first admitted use. With an
      // empty team no registry is created here at all (pre-team behavior).
      const pending = this.#conversationsFor(record, handle);
      handle.conversations = pending;
      await pending.catch((error) => {
        if (handle.conversations === pending) {
          handle.conversations = undefined;
        }
        throw error;
      });
    }
    if (handle.softwareEvolution && !handle.evolutionRecoveryStarted) {
      handle.evolutionRecoveryStarted = true;
      // Run after handle construction/serialization has completed. Atomic
      // adoption can then restore this same handle without awaiting itself.
      void handle.softwareEvolution.recover().catch(() => {
        handle.evolutionRecoveryStarted = false;
      });
    }
    return handle;
  }
  /** Binding discovery, cache ownership and disposal are serialized per target.
   * A stale R0 observation cannot dispose a newer R1 handle. */
  async #currentHandle(record: OpeningRecord): Promise<RequestHandle> {
    const operatorId = record.base!.requestOwner.operatorId;
    // Revalidate host/native scope even for cached handles and restored stores.
    const space = await this.options.storage.caseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const key = canonical([record.executionSpaceId, operatorId]);
    const binding = await this.#binding(record);
    if (
      binding &&
      binding.pin.source.version !== record.base!.manifest.source!.sourceVersion
    ) {
      // R comes only from the coherent binding, never physical HEAD or ancestry.
      await this.options.branches.assertRetainedExecutionVersion(
        record,
        binding.pin.source.version,
      );
    }
    const generation = this.#generation(binding);
    let pending = this.#handles.get(key);
    if (pending) {
      const previous = await pending;
      if (previous.generation !== generation) {
        // Only this target's registry is disposed; it does not own the stores,
        // primary runtime or shared native worker. Awaited builds retain ownership.
        previous.softwareEvolution?.dispose();
        if (previous.conversations) {
          await (await previous.conversations).dispose();
        }
        if (this.#handles.get(key) === pending) this.#handles.delete(key);
        pending = this.#handles.get(key);
        if (pending && (await pending).generation !== generation) {
          conflict("Request cache generation changed");
        }
      }
    }
    if (!pending) {
      pending = (async () =>
        this.#open(record, await space.operator(operatorId), binding))();
      this.#handles.set(key, pending);
      void pending.catch(() => {
        if (this.#handles.get(key) === pending) {
          this.#handles.delete(key);
        }
      });
    }
    const handle = await pending;
    if (handle.signature !== birthSignature(record)) {
      conflict("The cached Request birth differs");
    }
    const saved = await handle.stores.state.load();
    if (!saved) conflict("The provisioned Request state is unavailable");
    if (this.#generation(await this.#binding(record)) !== handle.generation) {
      if (this.#handles.get(key) === pending) this.#handles.delete(key);
      conflict("Request execution changed while constructing its handle");
    }
    assertRequestSpaceBirth(
      {
        ...saved,
        model: handle.birthModel.identity,
        executionModel: handle.birthModel,
      },
      requestSpaceSeed(record),
      handle.birthModel,
    );
    if (canonical(saved.executionModel) !== canonical(handle.model)) {
      conflict("Request cached execution pin changed");
    }
    return handle;
  }
  /** Every use resolves the recorded target admission afresh. Construction and
   * cold restoration neither execute a tool nor create a Candidate or grant. */
  #retainedTools(opening: OpeningRecord): RetainedToolsPort {
    return {
      list: async (model) => {
        const record = await this.#record(opening);
        const selected = record.base!.manifest.operators.find((entry) =>
          entry.operatorId === record.base!.requestOwner.operatorId
        );
        if (!selected) conflict("The retained tool owner is unavailable");
        await assertRetainedCatalog(model, selected.tools);
        if (!selected.tools.length) return [];
        const readTool = this.options.source.readTool;
        if (
          !record.admissionId || !this.options.executionBindings || !readTool
        ) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "The target retained tool admission is unavailable",
          );
        }
        const binding = await this.options.executionBindings.read(record);
        if (
          binding.admission.id !== record.admissionId ||
          canonical(binding.state.executionModel) !== canonical(model)
        ) conflict("The retained tool execution target changed");
        await this.options.admissions.assertDispatch(record, binding.admission);
        // Legacy empty grants remain empty even when source inspection can now
        // read tools. No recovery path expands the originally accepted scope.
        if (!binding.admission.permissions.resourceIds.length) return [];
        const descriptors = retainedToolDescriptors(record, record.admissionId);
        const resources = await Promise.all(
          descriptors.map(retainedToolResourceId),
        );
        if (
          canonical(resources) !==
            canonical(binding.admission.permissions.resourceIds)
        ) {
          throw new RequestSpaceError(
            "ADMISSION_REFUSED",
            "The target tool resource projection differs",
          );
        }
        return await Promise.all(descriptors.map(async (descriptor, index) => ({
          descriptor,
          resourceId: resources[index],
          draft: await readTool.call(
            this.options.source,
            record.base!,
            descriptor.target.operatorId,
            descriptor.tool.candidateId,
          ),
        })));
      },
    };
  }

  /** Verified branch team from the one producer. Each parent's recorded
   * creations come from its own durable state at this pin. */
  async #team(
    record: OpeningRecord,
    models: readonly ExecutableModel[],
    current: ExecutableModel,
    ownerChanges: readonly PendingChange[],
    admittedMembers: readonly string[] = [],
  ): Promise<{ team: BranchTeamMember[]; units: OperatorConversationUnit[] }> {
    const byOperator = new Map(
      models.map((model) => [model.identity.builderId, model]),
    );
    byOperator.set(current.identity.builderId, current);
    const pinned = [...byOperator.values()];
    const births = await this.options.resolveTeamCreationModels?.(
      record,
      admittedMembers,
    ) ?? new Map<string, ExecutableModel>();
    const owner = record.base!.requestOwner.operatorId;
    const memberChanges = new Map<string, PendingChange[]>();
    await Promise.all(
      pinned.filter((model) => model.operatorTeam?.requestId === record.caseId)
        .map(async (model) => {
          const state = await this.options.storage.readCaseRuntimeState(
            record.executionSpaceId,
            record.caseId,
            model.identity.builderId,
          );
          if (
            state?.executionModel?.version.digest === model.version.digest &&
            state.executionModel.version.repositoryVersion ===
              model.version.repositoryVersion &&
            canonical(state.executionModel.identity) ===
              canonical(model.identity)
          ) {
            memberChanges.set(
              model.identity.builderId,
              ownerChangesOf(state, model),
            );
          }
        }),
    );
    const team = branchTeam(record.base!, pinned, record.caseId, (child) => {
      const model = byOperator.get(child.identity.builderId);
      const parentModel = model?.operatorTeam
        ? byOperator.get(model.operatorTeam.parentOperatorId)
        : undefined;
      return model !== undefined && parentModel !== undefined &&
        requestTeamCreationReceiptVerifies(
          pinned,
          model,
          {
            space: {
              projectId: parentModel.identity.projectId,
              systemId: parentModel.identity.systemId,
              executionSpaceId: record.executionSpaceId,
            },
          },
          (parent) =>
            parent.identity.builderId === owner
              ? ownerChanges
              : memberChanges.get(parent.identity.builderId) ??
                parent.configuration.changes ?? [],
          births,
        );
    }, admittedMembers);
    const units = team.flatMap((member) => {
      const model = byOperator.get(member.operatorId);
      return model?.identity.systemQualifiedName
        ? [conversationUnit(model.identity.systemQualifiedName, model)]
        : [];
    });
    // A member without an executable unit in this pin is not opened here.
    return {
      team: team.filter((member) =>
        units.some((unit) =>
          unit.model.identity.builderId === member.operatorId
        )
      ),
      units,
    };
  }

  /** The same exact proposal preview for every admitted runtime of a Case. */
  #changePreview(
    record: OpeningRecord,
    model: ExecutableModel,
    branchTeamSize: number,
  ): Pick<
    ConstructorParameters<typeof RequestSpaceModel>[0],
    "networkChangePreview"
  > {
    return this.options.networkChanges
      ? {
        networkChangePreview: async (identity, change, expectedDigest) => {
          if (
            canonical(identity) !== canonical(model.identity) ||
            expectedDigest !== model.version.digest
          ) {
            conflict("The Case preview execution target changed", {
              context: {
                caseId: record.caseId,
                changeId: change.id,
                operatorId: model.identity.builderId,
              },
            });
          }
          return (await this.options.networkChanges!.prepare(
            await this.#record(record),
            model,
            change,
            branchTeamSize,
          )).diff;
        },
      }
      : {};
  }

  #inboxBehavior(
    record: OpeningRecord,
    model: ExecutableModel,
    targets: ReadonlyMap<string, string>,
    conversations: () => Promise<OperatorConversations> | undefined,
  ): OperatorInboxBehavior {
    return new OperatorInboxBehavior({
      targets,
      resolveCallerModel: (callerId, version) =>
        Promise.resolve(
          callerId === model.identity.builderId &&
            version.digest === model.version.digest &&
            version.repositoryVersion === model.version.repositoryVersion
            ? structuredClone(model)
            : null,
        ),
      dispatch: async (agentId, text, correlationId, proof) => {
        const registry = conversations();
        if (!registry) {
          conflict("The Request team is unavailable", {
            code: "UNAVAILABLE",
            context: {
              caseId: record.caseId,
              operatorId: model.identity.builderId,
            },
          });
        }
        return await (await registry).submitWork(
          agentId,
          text,
          correlationId,
          proof,
        );
      },
    });
  }

  /** One registry for the space: the BO as primary, its verified team opened
   * through the factory. The person still talks to the BO only. With an
   * empty team this is exactly the pre-team behavior: a primary-only
   * registry, created lazily for human input and never bound to the BO
   * runtime, so delegated publication, Case close and Case resume keep
   * their direct paths. A member that fails to open is excluded and
   * reported unavailable with its code; the BO keeps working. */
  async #conversationsFor(
    record: OpeningRecord,
    handle: Pick<
      RequestHandle,
      | "runtime"
      | "stores"
      | "model"
      | "teamUnits"
      | "team"
      | "unavailableMembers"
      | "members"
    >,
  ): Promise<OperatorConversations> {
    if (!handle.teamUnits.length) {
      const registry = new OperatorConversations({
        primary: handle.runtime,
        onNoticeError: (error) =>
          log.error(error.message, errorLogProperties(error)),
        skillStore: handle.stores.skills,
      });
      await registry.initialize();
      return registry;
    }
    const opened = new Map<string, SystemRuntime>();
    const openMember = (unit: OperatorConversationUnit) =>
      this.#openMember(
        record,
        registry,
        unit,
        handle.team.find((member) =>
          member.operatorId === unit.model.identity.builderId
        )?.modelDigest,
        handle.team.length,
        [
          conversationUnit(
            handle.model.identity.systemQualifiedName ??
              "ASELiveBuilder::liveBuilder",
            handle.model,
          ),
          ...handle.teamUnits,
        ],
      );
    const registry: OperatorConversations = new OperatorConversations({
      primary: handle.runtime,
      onNoticeError: (error) =>
        log.error(error.message, errorLogProperties(error)),
      skillStore: handle.stores.skills,
      factory: {
        open: async (unit) =>
          opened.get(unit.model.identity.builderId) ??
            await openMember(unit),
        close: async (runtime) => {
          await (runtime as SystemRuntime).idle();
        },
      },
    });
    const units: OperatorConversationUnit[] = [
      conversationUnit(
        handle.model.identity.systemQualifiedName ??
          "ASELiveBuilder::liveBuilder",
        handle.model,
      ),
    ];
    handle.unavailableMembers = [];
    for (const unit of handle.teamUnits) {
      const operatorId = unit.model.identity.builderId;
      try {
        const member = await openMember(unit);
        opened.set(operatorId, member);
        handle.members.set(operatorId, member);
        units.push(unit);
      } catch {
        handle.unavailableMembers.push({
          operatorId,
          code: "MEMBER_UNAVAILABLE",
        });
      }
    }
    if (units.length === 1) {
      // Every member failed to open: the BO runs exactly as with no team.
      const primaryOnly = new OperatorConversations({
        primary: handle.runtime,
        onNoticeError: (error) =>
          log.error(error.message, errorLogProperties(error)),
        skillStore: handle.stores.skills,
      });
      await primaryOnly.initialize();
      return primaryOnly;
    }
    handle.runtime.bindOperatorRegistry(registry);
    await registry.initialize({
      repositoryVersion: handle.model.version.repositoryVersion!,
      units,
    });
    return registry;
  }

  /** A team member's isolated runtime in this Case space. Its proposals use
   * the same preview and authority lifecycle as the BO; its source controls
   * inbox contributions and the person still enters through the BO. */
  async #openMember(
    record: OpeningRecord,
    registry: OperatorConversations,
    unit: OperatorConversationUnit,
    admittedDigest: string | undefined,
    branchTeamSize = 0,
    units: readonly OperatorConversationUnit[] = [],
  ): Promise<SystemRuntime> {
    const memberId = unit.model.identity.builderId;
    if (!admittedDigest) {
      conflict("The team member has no admitted model digest in this space", {
        code: "UNAVAILABLE",
        context: { caseId: record.caseId, operatorId: memberId },
      });
    }
    const space = await this.options.storage.caseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const stores = await space.operator(memberId);
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const exact = new RequestSpaceModel({
      base: record.base!,
      model: unit.model,
      caseId: record.caseId,
      executionSpaceId: record.executionSpaceId,
      branchTeamSize,
      ...this.#changePreview(record, unit.model, branchTeamSize),
      teamPin: {
        modelDigest: admittedDigest!,
        repositoryVersion: unit.model.version.repositoryVersion!,
      },
    });
    let runtime: SystemRuntime | undefined = undefined;
    const { initialSkills: _initialSkills, ...dependencies } = this.options
      .dependencies(
        stores,
        structuredClone(unit.model),
        () => runtime?.snapshot,
      );
    runtime = new SystemRuntime({
      ...dependencies,
      behaviors: new BehaviorInvocationRegistry([
        ...(dependencies.behaviors ? [dependencies.behaviors] : []),
        this.#inboxBehavior(
          record,
          unit.model,
          new Map(
            units.flatMap((target) =>
              (target.inboxNativeIds ??
                [target.model.flows.conversation.rootNativeId])
                .map((inboxId) =>
                  [inboxId, target.model.identity.builderId] as const
                )
            ),
          ),
          () => Promise.resolve(registry),
        ),
      ]),
      caseNumbers: this.options.storage.caseNumbers(),
      model: exact,
      store: stores.state,
      stateHistory: stores.state,
      execution: view.execution,
      dispatch: view.dispatch,
      workBudget: new WorkBudgetService(stores.budget),
    });
    runtime.bindOperatorRegistry(registry);
    this.options.bindRequestAuthority?.(structuredClone(record), runtime);
    // Born as a runtime of this space, like its BO: its information scope
    // binds `request:<space>:<operator>`.
    await runtime.initialize(unit.model, {
      resumeCandidateContinuations: false,
      runtimeId: `request:${record.executionSpaceId}:${memberId}`,
    });
    if (["admitted", "dispatched"].includes(record.phase)) {
      await this.options.recoverRequestAuthority?.(record, runtime);
    }
    return runtime;
  }

  async #open(
    record: OpeningRecord,
    stores: OperatorStorage,
    binding?: RequestExecutionBinding,
  ): Promise<RequestHandle> {
    // The BO's birth model is always the opening's; its current model is
    // the verified pin's below.
    const birthModels = await this.options.source.readModels(record.base!);
    const matching = birthModels.filter((model) =>
      model.identity.builderId === record.base!.requestOwner.operatorId
    );
    if (matching.length !== 1) {
      conflict("The recorded Request owner has no unique exact model");
    }
    const birthModel = structuredClone(matching[0]);
    const model = binding?.pin.adoption
      ? await this.options.resolveExecutionModel?.(record, binding)
      : birthModel;
    if (
      !model ||
      binding && canonical(model) !== canonical(binding.state.executionModel)
    ) {
      conflict(
        "The verified current Request model or retained assets are unavailable",
      );
    }
    // Under an adopted pin the team is read in the pin's models (E4): a
    // member created in the branch exists only there.
    const models = binding && this.options.resolveTeamModels
      ? [...await this.options.resolveTeamModels(record, binding)]
      : birthModels;
    // Creation reads in this runtime state their branch scope up front:
    // the verified whole-team size of this pin (empty at birth).
    const openingTeamSize = (await this.#team(
      record,
      models,
      model,
      ownerChangesOf(binding?.state, model),
      binding?.admission.permissions.operatorIds.slice(1),
    )).team.length;
    const exact = new RequestSpaceModel({
      base: record.base!,
      model,
      caseId: record.caseId,
      executionSpaceId: record.executionSpaceId,
      branchTeamSize: openingTeamSize,
      ...this.#changePreview(record, model, openingTeamSize),
      ...(binding ? { executionPin: binding.pin } : {}),
    });
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    let runtime: SystemRuntime | undefined = undefined;
    const { initialSkills, ...dependencies } = this.options.dependencies(
      stores,
      structuredClone(model),
      () => runtime?.snapshot,
    );
    // The BO reaches each verified member through the inbox access its
    // creation published (parent to child, 4.8e E3/E4). Targets and the
    // space registry are known once the team is read below.
    const inboxTargets = new Map<string, string>();
    let teamConversations: () => Promise<OperatorConversations> | undefined =
      () => undefined;
    const inbox = this.#inboxBehavior(
      record,
      model,
      inboxTargets,
      () => teamConversations(),
    );
    runtime = new SystemRuntime({
      ...dependencies,
      behaviors: new BehaviorInvocationRegistry([
        ...(dependencies.behaviors ? [dependencies.behaviors] : []),
        inbox,
      ]),
      retainedTools: this.#retainedTools(record),
      caseNumbers: this.options.storage.caseNumbers(),
      model: exact,
      store: stores.state,
      stateHistory: stores.state,
      execution: view.execution,
      dispatch: view.dispatch,
      workBudget: new WorkBudgetService(stores.budget),
    });
    if (
      binding &&
      this.#generation(await this.#binding(record)) !==
        this.#generation(binding)
    ) {
      conflict("Request execution changed before runtime registration");
    }
    this.options.bindRequestAuthority?.(structuredClone(record), runtime);
    await runtime.initializeRequestSpace(
      requestSpaceSeed(record),
      birthModel,
      binding?.state,
    );
    if (["admitted", "dispatched"].includes(record.phase)) {
      await this.options.recoverRequestAuthority?.(record, runtime);
    }
    let softwareEvolution: ScopedSoftwareEvolutionBinding | undefined;
    if (
      this.options.softwareEvolutionFactory &&
      ["admitted", "dispatched"].includes(record.phase)
    ) {
      const actor = this.#softwareTarget(record, runtime, stores);
      softwareEvolution = await this.options.softwareEvolutionFactory({
        actor,
        resolve: async (ref) =>
          canonical(ref) === canonical(actor.ref)
            ? actor
            : await this.resolveSoftwareEvolutionTarget(ref, record.caseId),
      });
    }
    const { team, units } = await this.#team(
      record,
      models,
      model,
      ownerChangesOf(binding?.state, model, runtime.snapshot),
      binding?.admission.permissions.operatorIds.slice(1),
    );
    for (const unit of units) {
      for (
        const inboxId of unit.inboxNativeIds ??
          [unit.model.flows.conversation.rootNativeId]
      ) inboxTargets.set(inboxId, unit.model.identity.builderId);
    }
    const handle: RequestHandle = {
      softwareEvolution,
      runtime,
      stores,
      model,
      birthModel,
      signature: birthSignature(record),
      generation: this.#generation(binding),
      team,
      teamUnits: units,
      unavailableMembers: [],
      members: new Map(),
      initialSkills,
    };
    teamConversations = () => handle.conversations;
    if (
      ["admitted", "dispatched"].includes(record.phase) && team.length
    ) {
      handle.conversations = Promise.resolve(
        await this.#conversationsFor(record, handle),
      );
    }
    return handle;
  }

  /** Adapter-only reservation over the exact target. The native/SQL boundary
   * proof remains the caller's responsibility inside the short reservation. */
  async withInstructionAdoptionReservation<T>(
    opening: OpeningRecord,
    dossierId: string,
    operation: (
      target: { runtime: SystemRuntime; stores: OperatorStorage },
    ) => Promise<T>,
    requester?: ScopedOperatorRef,
  ): Promise<T> {
    const record = await this.#record(opening);
    if (requester) await this.read(record, requester);
    const handle = await this.#handle(record);
    const runtime =
      requester && requester.operatorId !== record.base!.requestOwner.operatorId
        ? handle.members.get(requester.operatorId)
        : handle.runtime;
    if (!runtime) {
      conflict("The admitted Request target is unavailable", {
        code: "UNAVAILABLE",
        context: {
          caseId: record.caseId,
          operatorId: requester?.operatorId ??
            record.base!.requestOwner.operatorId,
        },
      });
    }
    const stores = runtime === handle.runtime ? handle.stores : await (
      await this.options.storage.caseSpace(
        record.executionSpaceId,
        record.caseId,
      )
    ).operator(requester!.operatorId);
    return await runtime.withEvolutionReservation(
      dossierId,
      () => operation({ runtime, stores }),
    );
  }

  /** Postcommit recovery uses the same verified generation resolver as cold
   * reconstruction. Store identity and the shared worker are retained. */
  async restoreInstructionAdoption(opening: OpeningRecord): Promise<void> {
    await this.#handle(await this.#record(opening));
    this.#restored(opening);
  }
  async restoreSoftwareEvolution(opening: OpeningRecord): Promise<void> {
    await this.#handle(await this.#record(opening));
    this.#restored(opening);
  }
  #restored(opening: OpeningRecord): void {
    try {
      this.options.onExecutionModelRestored?.(opening);
    } catch { /* An advisory observer cannot undo a committed adoption. */ }
  }

  #assertTarget(
    record: OpeningRecord,
    state: SystemRuntimeState,
    requester: ScopedOperatorRef,
  ): void {
    const model = state.executionModel;
    if (
      !model || requester.executionSpaceId !== record.executionSpaceId ||
      requester.projectId !== model.identity.projectId ||
      requester.systemId !== model.identity.systemId ||
      requester.operatorId !== model.identity.builderId
    ) {
      conflict("The admitted Request target differs", {
        code: "FORBIDDEN",
        context: { caseId: record.caseId, operatorId: requester.operatorId },
      });
    }
  }

  /** Shared read-only preparation boundary: source preview and publication
   * use the exact admitted BO or member, never a caller-supplied model. */
  async assertExecuting(
    opening: OpeningRecord,
    model: ExecutableModel,
  ): Promise<void> {
    const state = await this.read(
      opening,
      scopedOperator({
        ...model.identity,
        executionSpaceId: opening.executionSpaceId,
      }, model.identity.builderId),
    );
    if (canonical(state.executionModel) !== canonical(model)) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact Request executing model changed",
        {
          context: {
            caseId: opening.caseId,
            operatorId: model.identity.builderId,
          },
          recovery:
            "Reload this operator's admitted Request model before preparing the proposal.",
        },
      );
    }
  }

  async read(
    input: OpeningRecord,
    requester?: ScopedOperatorRef,
  ): Promise<SystemRuntimeState> {
    const record = await this.#record(input);
    const binding = await this.#binding(record, requester);
    if (binding) {
      if (requester) this.#assertTarget(record, binding.state, requester);
      return structuredClone(binding.state);
    }
    if (
      requester && requester.operatorId !== record.base!.requestOwner.operatorId
    ) {
      const state = (await this.readTeam(record)).find((state) =>
        state.executionModel?.identity.builderId === requester.operatorId
      );
      if (!state) {
        conflict("The admitted Request target is unavailable", {
          code: "UNAVAILABLE",
          context: { caseId: record.caseId, operatorId: requester.operatorId },
        });
      }
      this.#assertTarget(record, state, requester);
      return structuredClone(state);
    }
    const state = await this.options.storage.readCaseRuntimeState(
      record.executionSpaceId,
      record.caseId,
      record.base!.requestOwner.operatorId,
    );
    if (!state) conflict("The durable Request state is unavailable");
    const models = await this.options.source.readModelsForInspection(
      record.base!,
    );
    const matching = models.filter((model) =>
      model.identity.builderId === record.base!.requestOwner.operatorId
    );
    if (matching.length !== 1) {
      conflict("The recorded Request owner has no unique exact model");
    }
    assertRequestSpaceBirth(state, requestSpaceSeed(record), matching[0]);
    if (requester) this.#assertTarget(record, state, requester);
    return structuredClone(state);
  }

  /** Durable states of the verified branch team, for read models only. A
   * member whose state is absent or off its admitted digest is not listed. */
  async readTeam(input: OpeningRecord): Promise<SystemRuntimeState[]> {
    const record = await this.#record(input);
    const binding = await this.#binding(record);
    // Under an adopted pin the team exists only in the pin's models (E4).
    const models = binding && this.options.resolveTeamModels
      ? [...await this.options.resolveTeamModels(record, binding)]
      : await this.options.source.readModelsForInspection(record.base!);
    const current = binding?.state.executionModel ??
      models.find((model) =>
        model.identity.builderId === record.base!.requestOwner.operatorId
      );
    if (!current) return [];
    const { team } = await this.#team(
      record,
      models,
      current,
      ownerChangesOf(binding?.state, current),
      binding?.admission.permissions.operatorIds.slice(1),
    );
    const states: SystemRuntimeState[] = [];
    for (const member of team) {
      const expectedModel = models.find((model) =>
        model.identity.builderId === member.operatorId
      );
      const state = await this.options.storage.readCaseRuntimeState(
        record.executionSpaceId,
        record.caseId,
        member.operatorId,
      );
      if (
        state?.executionModel?.identity.builderId === member.operatorId &&
        state.executionModel.version.digest === member.modelDigest &&
        state.executionModel.version.repositoryVersion ===
          expectedModel?.version.repositoryVersion &&
        canonical(state.executionModel.identity) ===
          canonical(expectedModel?.identity)
      ) {
        states.push(structuredClone(state));
      }
    }
    return states;
  }

  /** Members of this handle's verified team that failed to open, with
   * their refusal code. Reads the cached handle only; never opens one. */
  async unavailableTeamMembers(
    input: OpeningRecord,
  ): Promise<Array<{ operatorId: string; code: string }>> {
    const record = await this.#record(input);
    const pending = this.#handles.get(canonical([
      record.executionSpaceId,
      record.base!.requestOwner.operatorId,
    ]));
    if (!pending) return [];
    const handle = await pending.catch(() => undefined);
    return handle ? structuredClone(handle.unavailableMembers) : [];
  }

  /** Pure native journal read, separate from mutable runtime preparation. */
  async initialExecutionOutcome(
    input: OpeningRecord,
    state: SystemRuntimeState,
  ): Promise<"refused" | undefined> {
    const record = await this.#record(input);
    const lifecycle = async (): Promise<"active" | "closed"> => {
      const space = await this.options.storage.client.executionSpace.findUnique(
        {
          where: {
            projectId_systemId_executionSpaceId: {
              ...record.scope,
              executionSpaceId: record.executionSpaceId,
            },
          },
        },
      );
      if (
        !space || space.caseId !== record.caseId ||
        space.parentExecutionSpaceId !== "main" ||
        !["active", "closed"].includes(space.lifecycle) ||
        (space.lifecycle === "active") !== (space.closedAt === null)
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The Request execution space is unavailable",
        );
      }
      return space.lifecycle as "active" | "closed";
    };
    return await readRequestInitialExecutionOutcome(
      this.options.native,
      record,
      state,
      lifecycle,
    );
  }

  async submitHuman(
    input: OpeningRecord,
    command: AgentMessageCommand,
  ): Promise<string | void> {
    const record = await this.#record(input);
    if (
      command.agentId !== record.base!.requestOwner.operatorId ||
      command.caseId !== record.caseId || command.newConversation !== undefined
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "This Request operator is unavailable",
      );
    }
    if (
      !["admitted", "dispatched"].includes(record.phase) || !record.admissionId
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The Request has no recorded execution admission",
      );
    }
    await this.read(record);
    // A new command retains fresh executable-host qualification even when its
    // runtime handle is cached. Historical GETs use inspection only.
    await this.options.source.readModels(record.base!);
    const handle = await this.#handle(record);
    if (!handle.conversations) {
      const pending = this.#conversationsFor(record, handle);
      handle.conversations = pending;
      void pending.catch(() => {
        if (handle.conversations === pending) handle.conversations = undefined;
      });
    }
    return await (await handle.conversations).submitHuman(command);
  }

  #softwareTarget(
    record: OpeningRecord,
    runtime: SystemRuntime,
    stores: OperatorStorage,
  ): ScopedSoftwareRuntimeTarget {
    const ref = Object.freeze({
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: record.base!.requestOwner.operatorId,
    });
    return Object.freeze({
      ref,
      opening: structuredClone(record),
      runtime,
      stores,
      readBinding: async () => {
        if (!this.options.executionBindings) {
          conflict("Scoped software requires a coherent execution binding");
        }
        const current = await this.#record(record);
        const binding = await this.options.executionBindings.read(current);
        await this.options.admissions.assertDispatch(
          current,
          binding.admission,
        );
        return binding;
      },
      inspectNative: async () => {
        const view = await this.options.native.forCaseSpace(
          record.executionSpaceId,
          record.caseId,
        );
        return await view.execution.inspect(ref.operatorId);
      },
    });
  }

  /** Composite host/space/operator resolution. Unsupported suboperators refuse;
   * an OpeningOwner is never substituted for another requested operator. */
  async resolveSoftwareEvolutionTarget(
    ref: Readonly<ScopedOperatorRef>,
    caseId: string,
  ): Promise<ScopedSoftwareRuntimeTarget> {
    const opening = await this.options.openings.forCase(caseId);
    if (!opening) conflict("The scoped software Request is unavailable");
    const record = await this.#record(opening);
    if (
      ref.projectId !== record.scope.projectId ||
      ref.systemId !== record.scope.systemId ||
      ref.executionSpaceId !== record.executionSpaceId ||
      ref.operatorId !== record.base!.requestOwner.operatorId ||
      !["admitted", "dispatched"].includes(record.phase)
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "No actual admitted runtime exists for this scoped software target",
      );
    }
    const handle = await this.#handle(record);
    return this.#softwareTarget(record, handle.runtime, handle.stores);
  }

  async provision(input: OpeningRecord): Promise<void> {
    await this.#handle(await this.#record(input));
  }

  async #refusalTarget(
    record: OpeningRecord,
    change: PendingChange,
    decision: NonNullable<
      SystemRuntimeState["requestNetworkDecisions"]
    >[string],
    phase: "preparation" | "recorded" = "recorded",
  ) {
    const requester = decision.authority?.kind === "delegated"
      ? parseRequestDelegatedAuthority(decision.authority.envelope).requester
      : decision.authority?.kind === "creation-grant"
      ? parseRequestCreationGrantAuthority(decision.authority.envelope)
        .requester
      : undefined;
    if (
      change.requestedBy !==
        (requester?.operatorId ?? record.base!.requestOwner.operatorId)
    ) {
      conflict("The recorded Request refusal target differs", {
        context: {
          caseId: record.caseId,
          changeId: change.id,
          operatorId: change.requestedBy,
        },
      });
    }
    const state = await this.read(record, requester);
    const current = state.configuration?.changes.find((entry) =>
      entry.id === change.id
    );
    const recorded = state.requestNetworkDecisions?.[change.id];
    // The decision adapter prepares the wake inside its save callback, before
    // the refused state commits. Its original pending proposal is still the
    // exact native wait target; recorded status reads require the full receipt.
    const preparing = phase === "preparation" &&
      current?.status === "pending" &&
      !recorded && await requestChangeProposalDigest(current) ===
        decision.proposalIntentDigest;
    if (
      !preparing && (canonical(current) !== canonical(change) ||
        canonical(recorded) !== canonical(decision))
    ) {
      conflict("The recorded Request refusal target changed", {
        context: { caseId: record.caseId, changeId: change.id, phase },
      });
    }
    return { requester, state, operatorId: change.requestedBy };
  }

  #continuationInvocation(
    record: OpeningRecord,
    state: SystemRuntimeState,
    changeId: string,
    inputMessageId: string,
    identity: NativeExecutionSnapshot["identity"],
  ) {
    const invocation = requestChangeInvocation(
      state,
      changeId,
      record.caseId,
      inputMessageId,
    );
    if (invocationKey(invocation) !== identity.invocationKey) {
      conflict("The recorded Request refusal invocation differs", {
        context: { caseId: record.caseId, changeId, inputMessageId },
      });
    }
    return invocation;
  }

  /** Recover the one receipt-bound wake after adoption, including lost ACK. */
  async prepareNetworkRefusal(
    input: OpeningRecord,
    change: PendingChange,
    decision: NonNullable<
      SystemRuntimeState["requestNetworkDecisions"]
    >[string],
  ): Promise<
    { delivery: OperatorExecutionDelivery; enqueue(): Promise<void> }
  > {
    const record = await this.#record(input);
    if (
      !record.base || decision.verdict !== "refuse" ||
      change.status !== "refused" ||
      !(requestChangeEffect(change) === "team-member"
        ? decidedByTeamAuthority(change)
        : decidedByNetworkAuthority(change)) ||
      decision.commandId !== change.id || decision.caseId !== record.caseId ||
      decision.openingId !== record.id ||
      decision.executionSpaceId !== record.executionSpaceId ||
      change.caseId !== record.caseId ||
      await requestChangeProposalDigest(change) !==
        decision.proposalIntentDigest
    ) {
      conflict("The recorded Request refusal differs");
    }
    const { state, operatorId } = await this.#refusalTarget(
      record,
      change,
      decision,
      "preparation",
    );
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const scope = {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId,
    };
    const runs = await this.options.storage.client.executionRun.findMany({
      where: { ...scope, status: "waiting" },
    });
    const matches = runs.flatMap((run) => {
      if (!run.snapshotJson || !state.executionModel) return [];
      const snapshot = JSON.parse(run.snapshotJson) as NativeExecutionSnapshot;
      const wait = exactNativeChangeApprovalWait(
        state,
        snapshot,
        state.executionModel,
        {
          changeId: change.id,
          proposalIntentDigest: decision.proposalIntentDigest,
          caseId: record.caseId,
        },
      );
      return wait && snapshot.checkpointId ? [{ snapshot, wait }] : [];
    });
    if (matches.length !== 1) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact Request refusal wait is not yet available.",
      );
    }
    const { snapshot, wait } = matches[0];
    const decisionDigest = await canonicalDigest({ change, decision });
    const proof: RequestNetworkRefusalContinuation = {
      changeId: change.id,
      proposalIntentDigest: decision.proposalIntentDigest,
      decisionDigest,
      threadId: snapshot.threadId,
      checkpointId: snapshot.checkpointId!,
      originalInputMessageId: wait.inputMessageId,
    };
    const team = requestChangeEffect(change) === "team-member";
    const delivery: OperatorExecutionDelivery = {
      id: `${team ? "team" : "network"}-refusal:${decisionDigest}`,
      kind: "continuation",
      identity: structuredClone(wait.identity),
      modelPin: {
        modelDigest: wait.modelDigest,
        repositoryVersion: wait.repositoryVersion,
      },
      payload: {
        inputMessageId: wait.inputMessageId,
        invocation: this.#continuationInvocation(
          record,
          state,
          change.id,
          wait.inputMessageId,
          wait.identity,
        ),
        ...(team ? { teamRefusal: proof } : { networkRefusal: proof }),
      },
    };
    return {
      delivery,
      enqueue: async () => {
        const receipt = await view.dispatch.enqueue(delivery);
        if (
          !["queued", "running", "waiting", "completed"].includes(
            receipt.status,
          )
        ) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The refusal continuation requires receipt inspection.",
          );
        }
      },
    };
  }

  async networkRefusalStatus(
    input: OpeningRecord,
    change: PendingChange,
    decision: NonNullable<
      SystemRuntimeState["requestNetworkDecisions"]
    >[string],
  ): Promise<"accepted" | "pending"> {
    const record = await this.#record(input);
    if (
      !record.base || decision.verdict !== "refuse" ||
      change.status !== "refused" ||
      !(requestChangeEffect(change) === "team-member"
        ? decidedByTeamAuthority(change)
        : decidedByNetworkAuthority(change)) ||
      decision.commandId !== change.id ||
      decision.openingId !== record.id || decision.caseId !== record.caseId ||
      decision.executionSpaceId !== record.executionSpaceId ||
      change.caseId !== record.caseId ||
      await requestChangeProposalDigest(change) !==
        decision.proposalIntentDigest
    ) conflict("The recorded Request refusal differs");
    const { state, operatorId } = await this.#refusalTarget(
      record,
      change,
      decision,
    );
    const view = await this.options.native.forCaseSpace(
      input.executionSpaceId,
      input.caseId,
    );
    if (!view.dispatch.inspectAccepted) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The refusal receipt reader is unavailable.",
      );
    }
    const digest = await canonicalDigest({ change, decision });
    const team = requestChangeEffect(change) === "team-member";
    const accepted = await view.dispatch.inspectAccepted(
      operatorId,
      `${team ? "team" : "network"}-refusal:${digest}`,
    );
    if (!accepted) return "pending";
    const proof =
      (team
        ? accepted.delivery.payload?.teamRefusal
        : accepted.delivery.payload?.networkRefusal) as
          | RequestNetworkRefusalContinuation
          | undefined;
    if (
      !proof || proof.decisionDigest !== digest ||
      proof.changeId !== change.id ||
      proof.proposalIntentDigest !== decision.proposalIntentDigest ||
      accepted.receipt.threadId !== proof.threadId
    ) conflict("The accepted refusal continuation differs");
    const runs = await this.options.storage.client.executionRun.findMany({
      where: {
        ...record.scope,
        executionSpaceId: record.executionSpaceId,
        operatorId,
        threadId: proof.threadId,
        checkpointId: proof.checkpointId,
        status: "waiting",
      },
    });
    if (runs.length !== 1 || !runs[0].snapshotJson) {
      conflict("The recorded refusal wait is unavailable");
    }
    const snapshot = JSON.parse(
      runs[0].snapshotJson,
    ) as NativeExecutionSnapshot;
    const wait = snapshot.localState?.changeApprovalWait as
      | NativeChangeApprovalWait
      | undefined;
    const expected: OperatorExecutionDelivery = {
      id: `${team ? "team" : "network"}-refusal:${digest}`,
      kind: "continuation",
      identity: structuredClone(snapshot.identity),
      modelPin: {
        modelDigest: snapshot.modelDigest,
        repositoryVersion: snapshot.repositoryVersion,
      },
      payload: {
        inputMessageId: proof.originalInputMessageId,
        invocation: this.#continuationInvocation(
          record,
          state,
          change.id,
          proof.originalInputMessageId,
          snapshot.identity,
        ),
        ...(team ? { teamRefusal: proof } : { networkRefusal: proof }),
      },
    };
    if (
      !wait || wait.changeId !== change.id ||
      wait.proposalIntentDigest !== decision.proposalIntentDigest ||
      wait.inputMessageId !== proof.originalInputMessageId ||
      canonical(wait.identity) !== canonical(snapshot.identity) ||
      canonical(accepted.delivery) !== canonical(expected)
    ) conflict("The accepted refusal wait differs");
    return ["queued", "running", "waiting", "completed"].includes(
        accepted.receipt.status,
      )
      ? "accepted"
      : "pending";
  }

  async ensureNetworkRefusal(
    input: OpeningRecord,
    change: PendingChange,
    decision: NonNullable<
      SystemRuntimeState["requestNetworkDecisions"]
    >[string],
  ): Promise<void> {
    if (
      await this.networkRefusalStatus(input, change, decision) === "accepted"
    ) return;
    const prepared = await this.prepareNetworkRefusal(input, change, decision);
    if (!this.options.executionBindings) {
      conflict("The Request admission binding is unavailable");
    }
    const record = await this.#record(input);
    const { requester } = await this.#refusalTarget(record, change, decision);
    const binding = await this.options.executionBindings.read(
      record,
      requester,
    );
    if (
      binding.pin.modelDigest !== prepared.delivery.modelPin.modelDigest ||
      binding.pin.source.version !==
        prepared.delivery.modelPin.repositoryVersion
    ) conflict("The refusal execution pin changed");
    await this.options.admissions.assertDispatch(record, binding.admission);
    await prepared.enqueue();
  }

  async ensureNetworkContinuation(
    input: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<void> {
    return await this.#ensureChangeContinuation(input, dossier, "network");
  }

  async ensureTeamContinuation(
    input: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<void> {
    return await this.#ensureChangeContinuation(input, dossier, "team");
  }

  async #ensureChangeContinuation(
    input: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
    kind: "network" | "team",
  ): Promise<void> {
    const proof = kind === "team"
      ? dossier.intent.team
      : dossier.intent.network;
    const record = await this.#record(input);
    if (
      !proof || !dossier.receipt ||
      dossier.status !== "adopted" ||
      dossier.intent.target.openingId !== record.id ||
      dossier.intent.target.caseId !== record.caseId ||
      !this.options.executionBindings
    ) conflict("The network adoption receipt is unavailable");
    const journal = new PostgresRequestSourceAdmissionStore(
      this.options.storage.client,
    );
    const chain = await this.options.storage.client.$transaction(
      (tx) => journal.readAdmittedSource(tx, record),
      { isolationLevel: "RepeatableRead" },
    );
    const found = chain.execution.adoptions.find((item) =>
      item.manifest.commandId === dossier.id
    );
    if (
      !found || canonical(found.receipt) !== canonical(dossier.receipt) ||
      canonical(found.manifest.intent) !== canonical(dossier.intent)
    ) conflict("The network adoption journal differs");
    const scope = {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId: dossier.intent.target.operatorId,
    };
    const pairs = found.manifest.nativeRetirement.predecessorThreadIds.map((
      predecessorThreadId,
      index,
    ) => ({
      predecessorThreadId,
      successorThreadId:
        found.manifest.nativeRetirement.successorThreadIds[index],
    }));
    const matches: Array<
      {
        snapshot: NativeExecutionSnapshot;
        wait: NativeChangeApprovalWait;
        successorThreadId: string;
      }
    > = [];
    for (const pair of pairs) {
      const runs = await this.options.storage.client.executionRun.findMany({
        where: {
          ...scope,
          threadId: pair.predecessorThreadId,
          status: "waiting",
        },
      });
      for (const run of runs) {
        if (!run.snapshotJson || !pair.successorThreadId) continue;
        const snapshot = JSON.parse(
          run.snapshotJson,
        ) as NativeExecutionSnapshot;
        const wait = snapshot.localState?.changeApprovalWait as
          | NativeChangeApprovalWait
          | undefined;
        if (
          wait?.changeId === proof.changeId &&
          wait.proposalIntentDigest ===
            proof.proposalIntentDigest &&
          snapshot.threadId === pair.predecessorThreadId &&
          snapshot.checkpointId && wait.identity.scope.kind === "request" &&
          wait.identity.scope.scopeId === record.caseId &&
          wait.identity.operatorId === scope.operatorId &&
          wait.modelDigest === dossier.intent.previous.pin.modelDigest &&
          wait.repositoryVersion === dossier.intent.previous.pin.source.version
        ) {
          matches.push({
            snapshot,
            wait,
            successorThreadId: pair.successorThreadId,
          });
        }
      }
    }
    if (matches.length !== 1) {
      conflict("The exact retired network wait is unavailable");
    }
    const { snapshot, wait, successorThreadId } = matches[0];
    const requester = adoptionRequester(dossier.intent);
    const binding = await this.options.executionBindings.read(
      record,
      requester,
    );
    const continuation: RequestNetworkContinuation = {
      commandId: dossier.id,
      receiptDigest: dossier.receipt.receiptDigest,
      changeId: wait.changeId,
      proposalIntentDigest: wait.proposalIntentDigest,
      predecessorThreadId: snapshot.threadId,
      checkpointId: snapshot.checkpointId!,
      successorThreadId,
      originalInputMessageId: wait.inputMessageId,
    };
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const delivery: OperatorExecutionDelivery = {
      id: `${kind}-adoption:${dossier.receipt.receiptDigest}`,
      kind: "continuation",
      identity: structuredClone(wait.identity),
      modelPin: {
        modelDigest: dossier.intent.candidate.model.version.digest,
        repositoryVersion: dossier.intent.candidate.source.version,
      },
      payload: {
        inputMessageId: wait.inputMessageId,
        invocation: this.#continuationInvocation(
          record,
          binding.state,
          proof.changeId,
          wait.inputMessageId,
          wait.identity,
        ),
        ...(kind === "team"
          ? { teamAdoption: continuation }
          : { networkAdoption: continuation }),
      },
    };
    if (!view.dispatch.inspectAccepted) {
      conflict("The network continuation receipt reader is unavailable");
    }
    const accepted = await view.dispatch.inspectAccepted(
      scope.operatorId,
      delivery.id,
    );
    if (accepted) {
      if (
        canonical(accepted.delivery) !== canonical(delivery) ||
        accepted.receipt.threadId !== successorThreadId
      ) conflict("The accepted network continuation differs");
      if (
        !["queued", "running", "waiting", "completed"].includes(
          accepted.receipt.status,
        )
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The network continuation outcome requires receipt inspection.",
        );
      }
      return;
    }
    if (
      binding.pin.adoption?.commandId !== dossier.id ||
      binding.pin.adoption.receiptDigest !== dossier.receipt.receiptDigest ||
      binding.pin.modelDigest !==
        dossier.intent.candidate.model.version.digest ||
      binding.pin.source.version !== dossier.intent.candidate.source.version
    ) conflict("The network adoption pin changed");
    await this.options.admissions.assertDispatch(record, binding.admission);
    const receipt = await view.dispatch.enqueue(delivery);
    if (
      !["queued", "running", "waiting", "completed"].includes(receipt.status)
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The network continuation outcome requires receipt inspection.",
      );
    }
  }

  async prepareInitialSkills(input: OpeningRecord): Promise<void> {
    const record = await this.#record(input);
    if (
      !["branch-ready", "runtime-ready", "admitted", "dispatched"].includes(
        record.phase,
      )
    ) {
      conflict(
        "The Request birth is unavailable for initial skill preparation",
      );
    }
    if ((await this.#binding(record))?.pin.adoption) {
      conflict(
        "Initial skill installation cannot be replayed under an adopted execution pin",
      );
    }
    const handle = await this.#handle(record);
    if (!(handle.model.initialSkills?.length)) return;
    if (!handle.initialSkills) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The scoped initial skill initializer is unavailable",
      );
    }
    await handle.initialSkills.initialize();
  }

  async #submitMainMemberOrder(
    record: OpeningRecord,
    written: { resumeId: string; instruction: string; operatorId?: string },
    opener: MainOpener | undefined,
    state: SystemRuntimeState,
    handle: RequestHandle,
  ): Promise<void> {
    const main = this.options.mainSnapshot?.();
    const identity = main?.executionModel?.identity;
    const member = handle.teamUnits.find((unit) =>
      unit.model.identity.builderId === written.operatorId
    );
    if (
      !opener || !main || !identity || !member ||
      !sameScopedOperator(
        opener.operator,
        scopedOperator({
          ...identity,
          executionSpaceId: "main",
        }, identity.builderId),
      ) || opener.origin.conversationId !== main.id
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Main order has no verified member target",
        {
          context: { caseId: record.caseId, operatorId: written.operatorId },
          recovery: "Select an admitted team member of this open Request.",
        },
      );
    }
    const conversations = await handle.conversations;
    if (!conversations) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request team is unavailable",
        {
          context: { caseId: record.caseId },
          recovery: "Retry when the admitted member runtime is available.",
        },
      );
    }
    const caseContext = caseExecutionContext({
      ...state,
      caseInvocation: { kind: "local", caseId: record.caseId },
    });
    if (!caseContext) {
      conflict("The Main order has no Request execution context", {
        code: "UNAVAILABLE",
        context: { caseId: record.caseId, operatorId: written.operatorId },
      });
    }
    const targetNativeId = (member.inboxNativeIds ??
      [member.model.flows.conversation.rootNativeId])[0];
    const invocationId = `main-member-input:${await canonicalDigest({
      openingId: record.id,
      operatorId: written.operatorId,
      resumeId: written.resumeId,
    })}`;
    await conversations.submitMainWork(
      member.model.identity.builderId,
      written.instruction,
      invocationId,
      {
        callerId: identity.builderId,
        invocationId,
        modelVersion: {
          digest: main.executionModel!.version.digest,
          repositoryVersion: main.executionModel!.version.repositoryVersion!,
        },
        mainOrder: { openingId: record.id, caller: opener.operator },
        caseId: record.caseId,
        caseContext,
        kind: "mainOrder",
        targetNativeId,
      },
    );
  }

  /** The Main Operator writes to the BO of an open Request (settled Q3): its
   * own input, never the person's, keyed by its resume identity. */
  async submitFromMain(
    input: OpeningRecord,
    written: {
      resumeId: string;
      instruction: string;
      at: string;
      operatorId?: string;
    },
    admission: SpaceExecutionAdmission,
    opener?: MainOpener,
  ): Promise<void> {
    const record = await this.#record(input);
    if (
      !["admitted", "dispatched"].includes(record.phase) ||
      record.admissionId !== admission.id ||
      admission.openingId !== record.id
    ) conflict("The admission does not belong to this recorded Request");
    await this.options.admissions.assertDispatch(record, admission);
    const handle = await this.#handle(record);
    const state = await handle.stores.state.load();
    const request = state?.cases?.find((entry) => entry.id === record.caseId);
    if (!request || !isOpenCase(request)) {
      throw new RequestSpaceError("FORBIDDEN", "The Request Case is closed", {
        context: { caseId: record.caseId },
        recovery: "Open a new Request instead.",
      });
    }
    if (
      written.operatorId &&
      written.operatorId !== record.base!.requestOwner.operatorId
    ) {
      await this.#submitMainMemberOrder(
        record,
        written,
        opener,
        state!,
        handle,
      );
      return;
    }
    const invocation = { kind: "local" as const, caseId: record.caseId };
    const id = `main-input:${await canonicalDigest({
      caseId: record.caseId,
      resumeId: written.resumeId,
    })}`;
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    await view.dispatch.enqueue({
      id,
      kind: "contribution",
      identity: {
        operatorId: record.base!.requestOwner.operatorId,
        invocationKey: invocationKey(invocation),
        scope: {
          kind: "request",
          scopeId: record.caseId,
          rootRequestId: record.caseId,
        },
        purpose: "conversation",
        subjectId: id,
      },
      modelPin: {
        modelDigest: handle.model.version.digest,
        repositoryVersion: handle.model.version.repositoryVersion,
      },
      payload: {
        text: written.instruction,
        origin: "delegation",
        invocation,
        caseId: record.caseId,
        receivedAt: written.at,
      },
    });
  }

  async enqueue(
    input: OpeningRecord,
    admission: SpaceExecutionAdmission,
  ): Promise<void> {
    const record = await this.#record(input);
    if (
      !["admitted", "dispatched"].includes(record.phase) ||
      record.admissionId !== admission.id ||
      admission.openingId !== record.id ||
      admission.executionSpaceId !== record.executionSpaceId ||
      admission.ownerId !== record.ownerId ||
      admission.baseDigest !== record.baseDigest ||
      canonical(admission.scope) !== canonical(record.scope)
    ) conflict("The admission does not belong to this recorded Request");
    await this.options.admissions.assertDispatch(record, admission);
    const handle = await this.#handle(record);
    const state = await handle.stores.state.load();
    const request = state!.cases!.find((entry) => entry.id === record.caseId)!;
    const view = await this.options.native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    const delivery = requestSpaceInitialDelivery(record, {
      modelDigest: handle.model.version.digest,
      repositoryVersion: handle.model.version.repositoryVersion,
    });
    if (!isOpenCase(request)) {
      const accepted = await view.dispatch.inspectAccepted(
        delivery.identity.operatorId,
        delivery.id,
      );
      if (!accepted || canonical(accepted.delivery) !== canonical(delivery)) {
        throw new RequestSpaceError("FORBIDDEN", "The Request Case is closed");
      }
    }
    // Native receipt comparison remains authoritative, including closed replay.
    await view.dispatch.enqueue(delivery);
  }

  /** Bounded future shared-worker routing: only the recorded Request owner.
   * Other operators require a connected scoped workspace and explicitly refuse.
   */
  async processAcceptedContribution(
    delivery: OperatorExecutionDelivery,
    scope: ResolvedOperatorScope,
  ): Promise<void> {
    const input = scope.caseId
      ? await this.options.openings.forCase(scope.caseId)
      : null;
    if (!input) conflict("The worker Request opening is unavailable");
    const record = await this.#record(input);
    if (
      !["admitted", "dispatched"].includes(record.phase) ||
      !record.admissionId?.trim()
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The worker Request has no recorded execution admission",
      );
    }
    if (
      scope.projectId !== record.scope.projectId ||
      scope.systemId !== record.scope.systemId ||
      scope.executionSpaceId !== record.executionSpaceId ||
      scope.caseId !== record.caseId ||
      delivery.identity.scope.kind !== "request" ||
      delivery.identity.scope.scopeId !== record.caseId ||
      delivery.identity.scope.rootRequestId !== record.caseId
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "Scoped Request operator routing is unavailable",
      );
    }
    const handle = await this.#handle(record);
    const operatorId = delivery.identity.operatorId;
    if (operatorId !== record.base!.requestOwner.operatorId) {
      // A verified member of the handle's team (4.8e E3), opened by the
      // space registry, at its admitted digest on the pin's source.
      const member = handle.team.find((entry) =>
        entry.operatorId === operatorId
      );
      if (!member) {
        throw new RequestSpaceError(
          "FORBIDDEN",
          "Scoped Request operator routing is unavailable",
        );
      }
      await handle.conversations;
      const runtime = handle.members.get(operatorId);
      if (!runtime) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The Request team member is unavailable",
          {
            context: { caseId: record.caseId, operatorId },
            recovery: "The delivery stays queued until the member opens.",
          },
        );
      }
      if (
        delivery.modelPin.modelDigest !== member.modelDigest ||
        delivery.modelPin.repositoryVersion !==
          runtime.snapshot.executionModel?.version.repositoryVersion
      ) conflict("The worker model pin differs");
      await runtime.processAcceptedContribution(delivery);
      return;
    }
    if (
      delivery.modelPin.modelDigest !== handle.model.version.digest ||
      delivery.modelPin.repositoryVersion !==
        handle.model.version.repositoryVersion
    ) {
      conflict("The worker model pin differs");
    }
    await handle.runtime.processAcceptedContribution(delivery);
  }
}

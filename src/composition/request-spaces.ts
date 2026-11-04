import {
  errorLogProperties,
  technicalLogger,
} from "../infrastructure/logging.ts";
import { createRequestRuntimeReaders } from "../adapters/out/postgres/request-runtime-readers.ts";
import type { ClockPort } from "../application/work/runtime/ports.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import type { ScopedOperatorRef } from "../domain/governance/authority.ts";
import type { RequestChangeDecision } from "../application/work/request-spaces/request-change-decision.ts";
import type { RequestSourceOwnerContext } from "../application/model/source-admission/request-source-owner.ts";
import type { OperatorExecutionDelivery } from "../application/work/operators/execution.ts";
import type { ResolvedOperatorScope } from "../application/work/native-execution/contract.ts";
import { createScopedSoftwareEvolutionComposition } from "./scoped-software-evolution.ts";
import {
  bindMainAuthorityReplay,
  createRequestSpaceAuthorityBridge,
  requestAuthorityLifecycleBindings,
  requestTeamSettlement,
} from "./request-space-authority-bridge.ts";
import type { RequestNetworkChangePreparationPort } from "../application/work/request-spaces/request-network-change-sources.ts";
import type { SystemRuntime } from "../application/work/runtime/system.ts";
import { RequestSupervision } from "../application/work/request-spaces/supervision.ts";
import { PostgresRequestSupervisionObservations } from "../adapters/out/postgres/request-supervision.ts";
import { RequestOperatorDetails } from "../application/work/request-spaces/operator-details.ts";
import { PostgresRequestOperatorDetailsObservations } from "../adapters/out/postgres/request-operator-details.ts";
import { PostgresRequestSourceAdmissionStore } from "../adapters/out/postgres/request-source-admission-store.ts";
import { PostgresRequestExecutionBindingReader } from "../adapters/out/postgres/request-execution-binding.ts";
import { PostgresEvolutionStore } from "../adapters/out/postgres/evolution-store.ts";
import { PostgresRequestAdoptionTransition } from "../adapters/out/postgres/request-adoption-transition.ts";
import { createRequestInputAdmissionGuard } from "../adapters/out/postgres/request-input-admission.ts";
import { RequestAdoptionContexts } from "../adapters/out/postgres/request-adoption-context.ts";
import { RequestExecutedModels } from "../adapters/out/postgres/request-executed-models.ts";
import { RequestRuntimeAdoptionService } from "../application/model/evolution/request-adoption-service.ts";
import type { GitModelRepositoryReader } from "../adapters/out/git/repository.ts";
import { createCaseBranchReader } from "../application/model/case-branch-reader.ts";
import { RequestCaseConversations } from "../application/work/request-spaces/conversations.ts";
import { createRequestConversationOwnerReader } from "../application/work/request-spaces/conversation-notifications.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";
import { createRequestSpaceControls } from "./space-controls.ts";
export { createRequestSpaceControls } from "./space-controls.ts";
import {
  mainOpenerAuthority,
  RequestSpaceOpenings,
} from "../application/work/request-spaces/opening.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import {
  createRequestSpaceEffectStartGuard,
  createRequestSpaceResolver,
} from "../adapters/out/postgres/request-space-execution.ts";
import { createRequestSpaceDispatcher } from "../application/work/request-spaces/dispatch.ts";
import { RequestInitialSkillAuthority } from "../application/work/request-spaces/request-initial-skill-authority.ts";
import { createRequestInitialSkillRuntimeReader } from "../adapters/out/postgres/request-initial-skill-runtime-reader.ts";
import { RequestSpaceRuntime } from "../application/work/request-spaces/runtime.ts";
import type { createRequestOpeningSourcesComposition } from "./request-opening-sources.ts";
import {
  createPostgresAdmittedRequestRuntime,
  type PostgresAdmittedRequestRuntimeOptions,
} from "../adapters/out/native-execution/postgres.ts";

export interface RequestSpacesCompositionOptions {
  clock?: ClockPort;
  storage: PostgresHostStorage;
  softwareEvolution?:
    & Pick<
      Parameters<typeof createScopedSoftwareEvolutionComposition>[0],
      | "repository"
      | "compiler"
      | "tooling"
      | "writer"
      | "queue"
      | "leaseMs"
      | "failed"
      | "store"
    >
    & {
      bindPublication(
        binding: Pick<
          ReturnType<typeof createScopedSoftwareEvolutionComposition>,
          "participant" | "resolver"
        >,
      ): void;
    };
  networkChanges?: RequestNetworkChangePreparationPort;
  mainAuthorityRuntime?: () => SystemRuntime | undefined;
  /** Host-internal source context of a delegated MO decision (4.8c). */
  hostSourceContext?: (
    caseId: string,
    requester?: ScopedOperatorRef,
  ) => Promise<RequestSourceOwnerContext>;
  /** Exact-scope immutable artifact readers; never a runtime factory or Main fallback. */
  artifactSourcesForScope?: ConstructorParameters<
    typeof RequestOperatorDetails
  >[0]["artifactSourcesForScope"];
  compareOperatorSources?: ConstructorParameters<
    typeof RequestOperatorDetails
  >[0]["compare"];
  nativeOptions: Omit<
    PostgresAdmittedRequestRuntimeOptions,
    | "client"
    | "scope"
    | "resolveCaseSpace"
    | "spaceEffectStart"
    | "acceptDeliveryInTransaction"
  >;
  /** Trusted host wiring keeps source readiness and its concrete Case factory
   * together. This bundle conveys neither execution admission nor qualification. */
  sources: ReturnType<typeof createRequestOpeningSourcesComposition>;
  controlComposition?: ReturnType<typeof createRequestSpaceControls>;
  /** Advisory: something committed may have moved this Case's model. */
  onCaseModelChanged?(caseId: string): void;
  /** Advisory: a BO or member conversation changed after persistence. */
  onConversationStateChanged?(caseId: string): void;
  /** Explicit production composition; legacy inert fixtures need no adoption facade. */
  adoption?: {
    repositoryId: string;
    store: PostgresEvolutionStore;
    fault?: ConstructorParameters<
      typeof PostgresRequestAdoptionTransition
    >[0]["fault"];
    reader(): Promise<
      Pick<
        GitModelRepositoryReader,
        "repositoryId" | "projectId" | "at" | "descriptorAt"
      >
    >;
  };
}

/** One admitted native facility, one canonical control source and inert Request
 * factory. Worker startup remains the host's responsibility after Main is ready. */
export async function createRequestSpacesComposition(
  options: RequestSpacesCompositionOptions,
) {
  const clock = options.clock ?? new SystemClock();
  const now = () => clock.now();
  const { storage } = options;
  const { source, branches, dependencies } = options.sources;
  const { controls, admissions, sqlAdmissions } = options.controlComposition ??
    createRequestSpaceControls(storage);
  const store = new PostgresRequestSpaceStore(storage.client, storage.scope);
  const journal = new PostgresRequestSourceAdmissionStore(storage.client);
  const executionBindings = new PostgresRequestExecutionBindingReader(
    storage.client,
    storage.scope,
    journal,
  );
  const supervision = new RequestSupervision({
    now,
    scope: storage.scope,
    control: controls,
    store,
    admissions,
    observations: new PostgresRequestSupervisionObservations(
      storage.client,
      storage.primarySpaceControl.runtimeScope,
      executionBindings,
    ),
  });
  const operatorDetails = new RequestOperatorDetails({
    scope: storage.scope,
    control: controls,
    store,
    observations: new PostgresRequestOperatorDetailsObservations(
      storage.client,
      executionBindings,
    ),
    source,
    artifactSourcesForScope: options.artifactSourcesForScope ?? (() => {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact Request artifact source reader is unavailable.",
      );
    }),
    compare: options.compareOperatorSources,
  });
  const executedModels = options.adoption
    ? new RequestExecutedModels({
      storage,
      openings: store,
      source,
      binding: executionBindings,
      journal,
      reader: options.adoption.reader,
    })
    : undefined;
  // Pinned space models for branch-team admission (E3/E4): the birth read
  // before the first binding, then the executed pin of the caller's binding
  // (an adopted creation exists only there).
  admissions.bindTeamModels(async (record, binding) =>
    !record.base
      ? []
      : binding && executedModels
      ? await executedModels.currentModels(record, binding)
      : await source.readModelsForInspection(record.base)
  );
  if (executedModels) {
    admissions.bindTeamCreationModels(executedModels.creationModels);
  }
  admissions.bindTeamStates(async (record, operatorIds) =>
    new Map(
      (await Promise.all(operatorIds.map(async (operatorId) => {
        const selected = await storage.client.$transaction((tx) =>
          executionBindings.readInitializedOperatorInTransaction(
            tx,
            record,
            operatorId,
          ), {
          isolationLevel: "RepeatableRead",
        });
        return selected ? [[operatorId, selected.state] as const] : [];
      }))).flat(),
    )
  );
  // A creator's settled turn may leave an autonomous creation to decide
  // (4.8e E4); the bridge is constructed below.
  const late: {
    bridge?: ReturnType<typeof createRequestSpaceAuthorityBridge>;
  } = {};
  const settleTeam = requestTeamSettlement(() => late.bridge);
  // The host observes settled contributions when it composes software
  // evolution or its own observer (root.ts does); a creator's settled turn may
  // then leave an autonomous creation to decide (4.8e E4). Without either,
  // the native dispatcher keeps its plain completion.
  const observesSettlement = !!options.softwareEvolution ||
    !!options.nativeOptions?.onRequestContributionSettled;
  const nativeRuntime = await createPostgresAdmittedRequestRuntime({
    ...options.nativeOptions,
    ...(observesSettlement
      ? {
        onRequestContributionSettled: (
          delivery: OperatorExecutionDelivery,
          scope: ResolvedOperatorScope,
        ) => {
          software?.contributionSettled(delivery, scope);
          if (
            late.bridge && scope.caseId && scope.executionSpaceId !== "main"
          ) {
            void settleTeam(scope.caseId);
          }
          options.nativeOptions?.onRequestContributionSettled?.(
            delivery,
            scope,
          );
        },
      }
      : {}),
    client: storage.client,
    scope: { ...storage.scope, executionSpaceId: "main" },
    resolveCaseSpace: createRequestSpaceResolver(storage),
    acceptDeliveryInTransaction: createRequestInputAdmissionGuard(
      storage.scope,
      executionBindings,
      sqlAdmissions,
    ),
    spaceEffectStart: createRequestSpaceEffectStartGuard(
      storage.scope,
      sqlAdmissions,
      executionBindings,
      journal,
    ),
  });
  const branchRuntimes = new Map<string, SystemRuntime>();
  const bridge = options.mainAuthorityRuntime
    ? createRequestSpaceAuthorityBridge({
      storage,
      openings: store,
      bindings: executionBindings,
      main: options.mainAuthorityRuntime,
      branchRuntime: (caseId) => branchRuntimes.get(caseId),
      delegated: () =>
        networkDecision && options.hostSourceContext
          ? {
            decision: networkDecision,
            sourceContext: options.hostSourceContext,
            now,
          }
          : undefined,
    })
    : undefined;
  late.bridge = bridge;
  const software = options.softwareEvolution
    ? createScopedSoftwareEvolutionComposition({
      ...options.softwareEvolution,
      clock,
      storage,
      openings: store,
      journal,
      bindings: executionBindings,
      sqlAdmissions,
      native: nativeRuntime,
      dependencies,
      restore: async (opening) => {
        await runtime.restoreSoftwareEvolution(opening);
      },
    })
    : undefined;
  if (software) options.softwareEvolution!.bindPublication(software);
  if (nativeRuntime.ledger.client !== storage.client) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "The admitted Request runtime belongs to another host",
    );
  }
  const log = technicalLogger("composition");
  const runtime = new RequestSpaceRuntime({
    ...createRequestRuntimeReaders(storage.client),
    onNoticeError: (error) =>
      log.error(error.message, errorLogProperties(error)),
    mainSnapshot: () => options.mainAuthorityRuntime?.()?.snapshot,
    ...(software ? { softwareEvolutionFactory: software.factory } : {}),
    storage,
    networkChanges: options.networkChanges,
    ...(bridge
      ? requestAuthorityLifecycleBindings(bridge, (caseId) => {
        void settleTeam(caseId);
      }, (record, target) => {
        branchRuntimes.set(record.caseId, target);
      }, async (record) =>
        (await executionBindings.read(record)).admission.permissions
          .operatorIds)
      : {}),
    native: {
      scope: nativeRuntime.ledger.options.scope,
      forCaseSpace: nativeRuntime.forCaseSpace,
    },
    openings: store,
    source,
    branches,
    admissions,
    dependencies,
    executionBindings,
    ...(options.onConversationStateChanged
      ? {
        onConversationStateChanged: (opening: { caseId: string }) =>
          options.onConversationStateChanged!(opening.caseId),
      }
      : {}),
    ...(executedModels
      ? {
        resolveExecutionModel: executedModels.current,
        resolveTeamModels: executedModels.currentModels,
        resolveTeamCreationModels: executedModels.creationModels,
      }
      : {}),
    ...(options.onCaseModelChanged
      ? {
        onExecutionModelRestored: (opening: { caseId: string }) =>
          options.onCaseModelChanged!(opening.caseId),
      }
      : {}),
  });
  const adoption = options.adoption
    ? new RequestRuntimeAdoptionService({
      context: new RequestAdoptionContexts({
        storage,
        controls,
        openings: store,
        binding: executionBindings,
        journal,
        repositoryId: options.adoption.repositoryId,
        reader: options.adoption.reader,
        creationModels: executedModels!.creationModels,
      }),
      store: options.adoption.store.requestAdoptions,
      networkContinuation: {
        ensure: (opening, dossier) =>
          runtime.ensureNetworkContinuation(opening, dossier),
      },
      teamContinuation: {
        ensure: (opening, dossier) =>
          runtime.ensureTeamContinuation(opening, dossier),
      },
      transition: new PostgresRequestAdoptionTransition({
        client: storage.client,
        primary: storage.primarySpaceControl,
        runtime,
        native: nativeRuntime,
        store: options.adoption.store,
        binding: executionBindings,
        journal,
        async opening(caseId) {
          const opening = await store.forCase(caseId);
          if (!opening) {
            throw new Error("The exact Request opening is unavailable");
          }
          return opening;
        },
        dependencies,
        fault: options.adoption.fault,
        now,
      }),
      now,
    })
    : undefined;
  const initialSkillAuthority = new RequestInitialSkillAuthority({
    runtime: createRequestInitialSkillRuntimeReader(storage),
    openings: store,
    source,
    branches,
    readBundledSkill: options.sources.readBundledSkill,
    sourceProvenance: options.sources.sourceProvenance,
  });
  const openings = new RequestSpaceOpenings({
    scope: storage.scope,
    control: controls,
    store,
    source,
    branches,
    runtime,
    admissions,
    ...(options.mainAuthorityRuntime
      ? { mainOpener: mainOpenerAuthority(options.mainAuthorityRuntime) }
      : {}),
  });
  let networkDecision: RequestChangeDecision | undefined;
  let authorityReplay: Promise<void> | undefined;
  return {
    /** Trusted host activation only, deliberately unused until qualification. */
    bindNetworkDecision(decision: RequestChangeDecision) {
      if (networkDecision) {
        throw new Error("Request network decision is already bound");
      }
      networkDecision = decision;
    },
    /** Main's read and decision surface over covered Branch Operator requests. */
    branchAuthority: bridge,
    /** Once Main registers: route what waited for it, then follow its policies. */
    replayAuthority() {
      const main = options.mainAuthorityRuntime?.();
      if (!bridge || !main) return Promise.resolve();
      return authorityReplay ??= bindMainAuthorityReplay(bridge, main);
    },
    nativeRuntime,
    supervision,
    operatorDetails,
    adoption,
    executedModels,
    executionBindings,
    async recoverSoftwareEvolution() {
      if (!software) return;
      const pending = await storage.client.evolutionDossier.findMany({
        where: {
          ...storage.scope,
          kind: "software-evolution-scoped-v2",
          status: {
            in: ["armed", "publishing", "published-awaiting-adoption"],
          },
        },
        orderBy: { id: "asc" },
        take: 257,
      });
      if (pending.length > 256) {
        throw new Error(
          "Scoped software recovery exceeds the shared dossier bound",
        );
      }
      for (const row of pending) {
        const { parseScopedSoftwareDossier } = await import(
          "../application/model/evolution/scoped-software-dossier.ts"
        );
        const d = await parseScopedSoftwareDossier(JSON.parse(row.payload));
        const opening = await store.get(d.scope.destination.openingId);
        if (!opening) {
          throw new Error("Scoped software recovery opening is unavailable");
        }
        await runtime.provision(opening);
      }
    },
    caseBranchReader: createCaseBranchReader({
      scope: storage.scope,
      store,
      source,
      branches,
      executionBindings,
      admittedInspection: options.sources.admittedInspection,
    }),
    controls,
    openings,
    runtime,
    conversationOwner: createRequestConversationOwnerReader({
      scope: storage.scope,
      store,
    }),
    conversations: new RequestCaseConversations({
      scope: storage.scope,
      control: controls,
      store,
      admissions,
      runtime,
      changeDecision: {
        status(secret, record, agentId, changeId) {
          if (!networkDecision?.status) {
            throw new RequestSpaceError(
              "FORBIDDEN",
              "This Request decision is unavailable",
            );
          }
          return networkDecision.status(
            { kind: "human", secret },
            record,
            agentId,
            changeId,
          );
        },
        resume(secret, record, agentId, changeId) {
          if (!networkDecision?.resume) {
            throw new RequestSpaceError(
              "FORBIDDEN",
              "This Request decision is unavailable",
            );
          }
          return networkDecision.resume(
            { kind: "human", secret },
            record,
            agentId,
            changeId,
          );
        },
        decide(secret, record, command) {
          if (!networkDecision) {
            throw new RequestSpaceError(
              "FORBIDDEN",
              "This Request decision is unavailable",
            );
          }
          return networkDecision.decide(
            { kind: "human", secret },
            record,
            command,
          );
        },
      },
    }),
    assertArtifactSourcePublication:
      initialSkillAuthority.assertArtifactSourcePublication,
    dispatchAccepted: createRequestSpaceDispatcher(storage.scope, runtime),
  };
}

import { PostgresScopedSoftwareAdmissionReader } from "../adapters/out/postgres/scoped-software-admission-reader.ts";
import type { ClockPort } from "../application/work/runtime/ports.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import { repositoryWriterLock } from "../adapters/out/git/writer-lock.ts";
import { bindHostBackgroundTask } from "../infrastructure/host-background-task.ts";
import type { OperatorExecutionDelivery } from "../application/work/operators/execution.ts";
import type { ResolvedOperatorScope } from "../application/work/native-execution/contract.ts";
import { isDeepStrictEqual } from "node:util";
import type { ModelToolingPort } from "../application/model/tooling.ts";
import type { ModelCompiler } from "../application/model/builds/ports/out/model-compiler.port.ts";
import type { QueuedModelWriter } from "../application/model/publication/queued-writer.ts";
import type { ScopedSoftwareSourcePublicationProtocol } from "../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import { assertScopedSoftwareWriteMatchesEvolution } from "../application/model/publication/scoped-software-write.ts";
import { parseScopedSoftwareDossier } from "../application/model/evolution/scoped-software-dossier.ts";
import { parseScopedSoftwareContext } from "../application/model/evolution/scoped-software-context.ts";
import { validateBehaviorSettingsChange } from "../application/work/runtime/behavior-settings-validation.ts";
import type { EvolutionSettingsAssessment } from "../application/model/evolution/assessment.ts";
import { NativeEvolutionSourceAssessment } from "../application/model/evolution/assessment.ts";
import { ScopedNativeEvolutionAuthority } from "../application/model/evolution/scoped-native-evolution-authority.ts";
import { ScopedSoftwareCurrentAuthority } from "../adapters/out/postgres/scoped-software-current-authority.ts";
import { NativeEvolutionRepository } from "../application/model/evolution/repository.ts";
import {
  ScopedEvolutionPreparation,
  ScopedEvolutionRepository,
  scopedEvolutionSourceOperations,
} from "../application/model/evolution/scoped-repository.ts";
import { createScopedSoftwareSourceWriteResolver } from "../application/model/publication/scoped-software-source-write-resolver.ts";
import { classifyEvolutionEffects } from "../domain/model/evolution/semantic-effects.ts";
import {
  sourceEvolutionCompilation,
  validateSourceEvolutionExecutables,
  validateSourceExecutables,
} from "../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import type { GitModelRepository } from "../adapters/out/git/repository.ts";
import {
  currentPostgresExecutionTransaction,
  postgresExecutionTransaction,
} from "../adapters/out/postgres/execution-transaction.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../adapters/out/postgres/client.ts";
import { decodePostgresOpening } from "../adapters/out/postgres/request-space-store.ts";
import type { PostgresSpaceAdmissions } from "../adapters/out/postgres/request-space-control-store.ts";
import { requireEvolutionEffectBounds } from "../domain/model/evolution/authorization.ts";
import type {
  OperatorStorage,
  PostgresHostStorage,
} from "../adapters/out/postgres/host-storage.ts";
import type { PostgresEvolutionStore } from "../adapters/out/postgres/evolution-store.ts";
import type { PostgresRequestExecutionBindingReader } from "../adapters/out/postgres/request-execution-binding.ts";
import type {
  AdmittedSourceChain,
  PostgresRequestSourceAdmissionStore,
} from "../adapters/out/postgres/request-source-admission-store.ts";
import type { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import { PostgresScopedSoftwareSourcePublicationParticipant } from "../adapters/out/postgres/scoped-software-source-publication-participant.ts";
import { PostgresScopedSoftwareAdoptionTransition } from "../adapters/out/postgres/scoped-software-adoption-transition.ts";
import type { PostgresModelWriteQueue } from "../adapters/out/postgres/model-write-queue.ts";
import type { PostgresAdmittedRequestRuntime } from "../adapters/out/native-execution/postgres.ts";
import type { RequestSpaceRuntimeOptions } from "../application/work/request-spaces/runtime.ts";
import { createScopedSoftwareEvolution } from "../application/model/evolution/scoped-software-evolution.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import { parseModelRevisionRef } from "../domain/model/value-objects/element-ref.ts";
import { EvolutionError } from "../application/model/evolution/ports.ts";

/** Fresh source S and independent execution R are captured for EACH proposal.
 * No mutable current-scope slot or source-driven runtime replacement is needed. */
export async function captureScopedSoftwarePreparationScope(input: {
  actor:
    import("../application/model/evolution/ports.ts").ScopedSoftwareRuntimeTarget<
      OperatorStorage
    >;
  readAdmittedSource(
    opening: import("../domain/work/request-spaces.ts").OpeningRecord,
  ): Promise<Pick<AdmittedSourceChain, "head">>;
}) {
  const opening = structuredClone(input.actor.opening),
    actor = structuredClone(input.actor.ref);
  const binding = await input.actor.readBinding(),
    chain = await input.readAdmittedSource(opening);
  const repositoryId = opening.base!.manifest.source!.repositoryId;
  return parseScopedSoftwareContext({
    format: "software-evolution-scope/v2",
    destination: {
      v: 1,
      kind: "request",
      repositoryId,
      host: opening.scope,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      caseId: opening.caseId,
      branchId: opening.branchId,
      ref: `refs/heads/requests/${opening.branchId}`,
      expectedAdmittedSource: {
        revision: chain.head.revision,
        source: parseModelRevisionRef(chain.head.source),
        sourceDigest: chain.head.sourceDigest,
      },
    },
    openingBaseDigest: opening.baseDigest,
    predecessorManifestDigest: chain.head.manifestDigest,
    actor,
    targets: [{ target: actor, previousPin: binding.pin }],
  });
}

/** Uses the host's one Git writer, queue and native facility. Construction is
 * inert; an operator factory is invoked only for an actual admitted Request. */
export function createScopedSoftwareEvolutionComposition(options: {
  clock?: ClockPort;
  storage: PostgresHostStorage;
  store: PostgresEvolutionStore;
  journal: PostgresRequestSourceAdmissionStore;
  bindings: PostgresRequestExecutionBindingReader;
  openings: PostgresRequestSpaceStore;
  sqlAdmissions: Pick<PostgresSpaceAdmissions, "assertEffectStart">;
  native: PostgresAdmittedRequestRuntime;
  dependencies: RequestSpaceRuntimeOptions<OperatorStorage>["dependencies"];
  repository: GitModelRepository;
  compiler: ModelCompiler;
  tooling: ModelToolingPort;
  writer: QueuedModelWriter;
  queue: PostgresModelWriteQueue;
  leaseMs: number;
  restore(
    opening: import("../domain/work/request-spaces.ts").OpeningRecord,
  ): Promise<void>;
  failed(error: unknown): void;
}) {
  // This composition is created at host bootstrap, before native deliveries.
  // Capturing inside the Request factory would preserve the delivery's claim,
  // SQL fence and abort signal even after its canonical/public settlement.
  const runInHostContext = bindHostBackgroundTask(
    (operation: () => void | Promise<void>) => operation(),
  );
  const withRepositoryLock = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const lock = await repositoryWriterLock(options.repository.stateDir);
    return await lock.runExclusive(operation);
  };
  const clock = options.clock ?? new SystemClock();
  const now = () => clock.now();
  const active = new Map<
    string,
    {
      binding:
        import("../application/model/evolution/ports.ts").ScopedSoftwareEvolutionBinding;
      operatorId: string;
      caseId: string;
    }
  >();
  const wake = (space: string) =>
    active.get(space)?.binding.requestFinalization();
  const refuse = (detail: string): never => {
    throw new EvolutionError("EVOLUTION_SOURCE_CHANGED", detail);
  };
  type Scope =
    import("../application/model/evolution/scoped-software-context.ts").ScopedSoftwareContextV2;
  const admittedInTransaction = async (
    tx: Prisma.TransactionClient,
    scope: Scope,
    lock: boolean,
  ) => {
    if (
      canonical(scope.destination.host) !== canonical(options.storage.scope)
    ) return refuse("The staging host differs");
    const key = {
      ...scope.destination.host,
      executionSpaceId: scope.destination.executionSpaceId,
    };
    const row = await tx.spaceOpening.findUnique({
      where: { projectId_systemId_executionSpaceId: key },
    });
    if (
      !row || row.id !== scope.destination.openingId ||
      row.projectId !== key.projectId || row.systemId !== key.systemId ||
      row.caseId !== scope.destination.caseId ||
      row.branchId !== scope.destination.branchId ||
      row.baseDigest !== scope.openingBaseDigest ||
      !["admitted", "dispatched"].includes(row.phase)
    ) return refuse("The exact software Request opening changed");
    const opening = decodePostgresOpening(row),
      binding = await options.bindings.readInTransaction(tx, opening);
    const actual = binding.state.executionModel;
    if (
      scope.actor.executionSpaceId !== opening.executionSpaceId ||
      scope.actor.operatorId !== opening.base?.requestOwner.operatorId ||
      !actual || actual.identity.builderId !== scope.actor.operatorId ||
      actual.version.digest !== binding.pin.modelDigest ||
      actual.version.repositoryVersion !== binding.pin.source.version ||
      scope.targets.some((entry) =>
        entry.target.operatorId !== actual.identity.builderId ||
        canonical(entry.previousPin) !== canonical(binding.pin)
      )
    ) {
      return refuse(
        "The exact admitted staging actor or execution pin changed",
      );
    }
    // Reuse the actual admission/PRIMARY policy check. Capability expiry only
    // prevents new control work; explicit revocation and admission expiry stop
    // this already-admitted native contribution.
    await options.sqlAdmissions.assertEffectStart(tx, {
      admissionId: binding.admission.id,
      expectedRevision: binding.admission.revision,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      operatorId: scope.actor.operatorId,
      modelDigest: binding.pin.modelDigest,
      sourceVersion: binding.pin.source.version,
      baseDigest: scope.openingBaseDigest,
      act: "conversation",
      expectedResourceIds: binding.admission.permissions.resourceIds,
    });
    if (lock) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "executionSpaceId" FROM ${
          postgresQualifiedTable(options.storage.client, "ExecutionSpace")
        } WHERE "projectId"=${key.projectId} AND "systemId"=${key.systemId} AND "executionSpaceId"=${key.executionSpaceId} FOR SHARE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(options.storage.client, "SpaceOpening")
        } WHERE "projectId"=${key.projectId} AND "systemId"=${key.systemId} AND "id"=${opening.id} FOR SHARE NOWAIT`,
      );
      const current = await tx.spaceOpening.findUnique({
        where: { projectId_systemId_executionSpaceId: key },
      });
      // Prisma rows retain native bigint Case numbers and Date timestamps.
      // Compare the complete rows without sending them through the JSON codec.
      if (!isDeepStrictEqual(current, row)) {
        return refuse("The staging opening changed before its lock");
      }
    }
    const space = await tx.executionSpace.findUnique({
      where: { projectId_systemId_executionSpaceId: key },
    });
    if (
      !space || space.projectId !== key.projectId ||
      space.systemId !== key.systemId ||
      space.parentExecutionSpaceId !== "main" ||
      space.caseId !== opening.caseId || space.lifecycle !== "active" ||
      space.closedAt !== null
    ) return refuse("The exact staging execution space is unavailable");
    const chain = await options.journal.readAdmittedSource(tx, opening);
    if (
      canonical({
          revision: chain.head.revision,
          source: chain.head.source,
          sourceDigest: chain.head.sourceDigest,
        }) !== canonical(scope.destination.expectedAdmittedSource) ||
      chain.head.manifestDigest !== scope.predecessorManifestDigest
    ) return refuse("The scoped admitted source changed");
    return { opening, binding, chain };
  };
  const staging = (scope: Scope, callerCommandId?: string) => {
    let lockedCurrent: (() => Promise<void>) | undefined;
    return options.repository.scopedSoftwarePreparationRepository({
      scope,
      assertCurrent: async () => {
        if (lockedCurrent) await lockedCurrent();
        else {await options.storage.client.$transaction(
            (tx) => admittedInTransaction(tx, scope, false),
            { isolationLevel: "ReadCommitted" },
          );}
      },
      ...(callerCommandId
        ? {
          guardNewEffect: async <T>(effect: () => Promise<T>): Promise<T> => {
            const execution = currentPostgresExecutionTransaction();
            if (
              !execution || execution.client !== options.storage.client ||
              !execution.session || !execution.fence || execution.transaction
            ) {
              return refuse(
                "Software staging requires its actual running native effect",
              );
            }
            const session = { ...execution.session };
            let accepting = true;
            let completion: Promise<T> | undefined;
            try {
              return await postgresExecutionTransaction(
                options.storage.client,
                async (tx) => {
                  lockedCurrent = async () => {
                    if (!accepting) {
                      return refuse("The staging authority transaction ended");
                    }
                    const effects = await tx.$queryRaw<
                      Array<{ effectKey: string }>
                    >(Prisma.sql`SELECT "effectKey" FROM ${
                      postgresQualifiedTable(
                        options.storage.client,
                        "ExecutionEffect",
                      )
                    } WHERE "projectId"=${scope.destination.host.projectId} AND "systemId"=${scope.destination.host.systemId} AND "executionSpaceId"=${scope.destination.executionSpaceId} AND "operatorId"=${scope.actor.operatorId} AND "threadId"=${session.threadId} AND "runId"=${session.runId} AND "effectKey"=${callerCommandId} AND "status"='started' FOR SHARE NOWAIT`);
                    if (effects.length !== 1) {
                      return refuse(
                        "The staging command is not the actual started native effect",
                      );
                    }
                    await admittedInTransaction(tx, scope, true);
                  };
                  await lockedCurrent();
                  completion = effect();
                  const result = await completion;
                  await lockedCurrent();
                  return result;
                },
                {
                  isolationLevel: "ReadCommitted",
                  maxWait: 1_000,
                  timeout: 120_000,
                },
              );
            } finally {
              accepting = false;
              // A timed-out SQL transaction must not release the enclosing Git lock
              // while an external snapshot callback is still unwinding.
              await completion?.then(() => undefined, () => undefined);
            }
          },
        }
        : {}),
    });
  };
  const currentAuthority = new ScopedSoftwareCurrentAuthority({
    compilation: sourceEvolutionCompilation,
    client: options.storage.client,
    primaryControl: options.storage.primarySpaceControl,
    sqlAdmissions: options.sqlAdmissions,
    native: options.native,
    journal: options.journal,
    bindings: options.bindings,
    verifyGit: (admission) =>
      options.repository.verifyScopedSoftwareSourceAdmission(admission),
    repository: options.repository,
    sourceOperations: (d) =>
      scopedEvolutionSourceOperations(staging(d.scope), d),
  });
  const participant = new PostgresScopedSoftwareSourcePublicationParticipant(
    options.storage.client,
    currentAuthority,
  );
  const protocol: ScopedSoftwareSourcePublicationProtocol = {
    async assertNewEffect(evolution, write, before, after) {
      await assertScopedSoftwareWriteMatchesEvolution(write, evolution);
      if (
        before.version !== evolution.proposal.baseVersion ||
        after.sourceDigest !== evolution.proposal.sourceDigest
      ) refuse("The scoped publication sources changed");
      await withRepositoryLock(async () => {
        const prepared = await currentAuthority.prepareCurrent(evolution);
        await options.storage.client.$transaction(
          (tx) =>
            currentAuthority.assertCurrentPreparedLocked(
              tx,
              evolution,
              prepared,
            ),
          { isolationLevel: "ReadCommitted" },
        );
      });
    },
    async guardNewPublication(lease, context, effect) {
      const result = await options.queue.guardScopedSoftwarePublication(
        lease,
        options.leaseMs,
        context,
        effect,
      );
      wake(context.admission.destination.executionSpaceId);
      return result;
    },
    async settleHistorical(context, lease) {
      if (lease) {
        await options.queue.transition(lease, "publishing");
        await options.queue.reconcileScopedSoftwarePublication(
          lease,
          options.leaseMs,
          context,
        );
      } else {await options.storage.client.$transaction((tx) =>
          participant.verifyHistoricalLocked(tx, context), {
          isolationLevel: "RepeatableRead",
        });}
      if (lease) wake(context.admission.destination.executionSpaceId);
    },
  };
  const resolver = createScopedSoftwareSourceWriteResolver({
    repository: options.repository,
    protocol,
    store: {
      async get(id) {
        const row = await options.storage.client.evolutionDossier.findUnique({
          where: { projectId_systemId_id: { ...options.storage.scope, id } },
        });
        if (!row || row.kind !== "software-evolution-scoped-v2") return null;
        const d = await parseScopedSoftwareDossier(JSON.parse(row.payload));
        return await options.store.scopedSoftware(d.scope).get(id);
      },
    },
  });
  const adoption = new PostgresScopedSoftwareAdoptionTransition({
    client: options.storage.client,
    store: options.store,
    journal: options.journal,
    binding: options.bindings,
    native: options.native,
    dependencies: options.dependencies,
    verifyGit: (admission) =>
      options.repository.verifyScopedSoftwareSourceAdmission(admission),
    lockPrimary: (tx) => currentAuthority.lockPrimary(tx),
    assertAdmissionLocked: (tx, d) =>
      currentAuthority.assertAdmissionLocked(tx, d),
    withRepositoryLock,
    prepareCurrent: (d) => currentAuthority.prepareCurrent(d),
    assertCurrentPreparedLocked: (tx, d, token) =>
      currentAuthority.assertCurrentPreparedLocked(tx, d, token),
    restore: options.restore,
    failed: options.failed,
    now,
  });
  const factory: NonNullable<
    RequestSpaceRuntimeOptions<OperatorStorage>["softwareEvolutionFactory"]
  > = async ({ actor, resolve }) => {
    const opening = actor.opening;
    const repositoryId = opening.base!.manifest.source!.repositoryId;
    const captureScope = () =>
      captureScopedSoftwarePreparationScope({
        actor,
        readAdmittedSource: (selected) =>
          options.storage.client.$transaction(
            (tx) => options.journal.readAdmittedSource(tx, selected),
            { isolationLevel: "RepeatableRead" },
          ),
      });
    const scope = await captureScope();
    const readTarget = async (operatorId: string) => {
      const target = await resolve({ ...actor.ref, operatorId });
      const binding = await target.readBinding();
      return { model: binding.state.executionModel!, pin: binding.pin };
    };
    const validateSettings = async (input: EvolutionSettingsAssessment) => {
      const ids = [
        ...new Set(input.effects.map((effect) => effect.targetNativeId)),
      ];
      const before = [...input.before];
      const targets = await Promise.all(ids.map(async (id) => {
        const actual = await resolve({ ...actor.ref, operatorId: id });
        const actualBinding = await actual.readBinding();
        const retained = await validateSourceEvolutionExecutables(
          await options.repository.at(actualBinding.pin.source.version),
          `git:${repositoryId}`,
        );
        const exact = retained.find((entry) =>
          entry.model.identity.builderId === id &&
          entry.model.version.digest === actualBinding.pin.modelDigest
        );
        const index = before.findIndex((entry) =>
          entry.model.identity.builderId === id
        );
        if (!exact || index < 0) {
          return refuse("The exact executed settings model is unavailable");
        }
        before[index] = exact;
        const candidate = input.after.find((entry) =>
          entry.model.identity.builderId === id
        )?.model;
        if (!candidate) return refuse("The settings target is absent");
        const target = await actual.runtime.evolutionValidationTarget(
          candidate,
        );
        target.memoryRecords = await actual.stores.memory.list(id);
        target.memoryAuditAt = now();
        return target;
      }));
      const runtimeEffects = classifyEvolutionEffects(before, input.after);
      requireEvolutionEffectBounds(
        (await readTarget(actor.ref.operatorId)).model,
        "prepare",
        runtimeEffects,
        before,
        input.after,
      );
      const effects = [
        ...new Map(
          [...input.effects, ...runtimeEffects].map((
            effect,
          ) => [canonical([effect.targetNativeId, effect.category]), effect]),
        ).values(),
      ];
      await validateBehaviorSettingsChange({
        before,
        after: input.after,
        effects,
        affectedOperatorIds: ids,
        targets,
      });
    };
    const sourceAt = (
      captured:
        import("../application/model/evolution/scoped-software-context.ts").ScopedSoftwareContextV2,
      callerCommandId?: string,
    ) =>
      new NativeEvolutionRepository({
        repositoryId,
        repository: staging(captured, callerCommandId),
        compiler: options.compiler,
        tooling: options.tooling,
        assess: new NativeEvolutionSourceAssessment({
          compilation: sourceEvolutionCompilation,
          projectId: `git:${repositoryId}`,
          admittedActor: async (id) => (await readTarget(id)).model,
          validateSettings,
        }),
      });
    const sourceRepository = staging(scope), source = sourceAt(scope);
    // Current source may advance without an execution-pin change. Capture a
    // NEW immutable proposal context; retain this actual engaged runtime.
    const preparation: Pick<ScopedEvolutionPreparation, "prepare"> = {
      async prepare(input) {
        const captured = await captureScope();
        return await new ScopedEvolutionPreparation({
          compilation: sourceEvolutionCompilation,
          scope: captured,
          source: sourceAt(captured, input.callerCommandId),
          readTarget,
        }).prepare(input);
      },
    };
    const repository = new ScopedEvolutionRepository({
      preparation,
      source,
      sourceRepository,
      repository: options.repository,
      writer: options.writer,
      admissions: new PostgresScopedSoftwareAdmissionReader(
        options.storage.client,
        options.journal,
      ),
      opening,
    });
    const authority = new ScopedNativeEvolutionAuthority({
      compilation: sourceEvolutionCompilation,
      scope,
      repository: options.repository,
      readActor: async () => (await actor.readBinding()).state.executionModel!,
      readTarget,
      validateSettings,
    });
    const stableStore = options.store.scopedSoftware(scope);
    const softwareStore = {
      ...stableStore,
      create: (
        d: import("../application/model/evolution/scoped-software-dossier.ts").ScopedSoftwareEvolutionDossierV2,
      ) => options.store.scopedSoftware(d.scope).create(d),
    };
    const bindingController = createScopedSoftwareEvolution<OperatorStorage>({
      runInHostContext,
      scope,
      actor,
      store: softwareStore,
      authority,
      repository,
      resolve,
      adoption,
      now,
      failed: options.failed,
      candidate: async (d, target) => {
        const models = await validateSourceExecutables(
          await options.repository.at(d.publication!.version),
          `git:${repositoryId}`,
        );
        const found = models.map((entry) => entry.model).filter((model) =>
          model.identity.builderId === target.operatorId &&
          model.version.digest === target.candidateDigest
        );
        if (found.length !== 1) {
          return refuse(
            "The exact published scoped target model is unavailable",
          );
        }
        return found[0];
      },
    });
    active.set(opening.executionSpaceId, {
      binding: bindingController,
      operatorId: actor.ref.operatorId,
      caseId: opening.caseId,
    });
    return {
      ...bindingController,
      dispose() {
        if (
          active.get(opening.executionSpaceId)?.binding === bindingController
        ) {
          active.delete(opening.executionSpaceId);
        }
        bindingController.dispose();
      },
    };
  };
  return {
    factory,
    participant,
    resolver,
    contributionSettled(
      delivery: OperatorExecutionDelivery,
      scope: ResolvedOperatorScope,
    ): void {
      if (
        scope.projectId !== options.storage.scope.projectId ||
        scope.systemId !== options.storage.scope.systemId ||
        scope.executionSpaceId === "main" ||
        delivery.identity.scope.kind !== "request" ||
        !scope.caseId || delivery.identity.scope.scopeId !== scope.caseId ||
        delivery.identity.scope.rootRequestId !== scope.caseId
      ) return;
      // The worker's actual composite scope owns this wake. Scheduling preserves
      // all subsequent native membership/queue/checkpoint guards and reservations.
      const actual = active.get(scope.executionSpaceId);
      if (
        !actual || actual.operatorId !== delivery.identity.operatorId ||
        actual.caseId !== scope.caseId
      ) return;
      actual.binding.requestFinalization();
    },
  };
}

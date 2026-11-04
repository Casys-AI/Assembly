import type { SourceEvolutionCompilationPort } from "../../../application/model/source-compilation.ts";
import type { Prisma } from "./client.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../../application/model/evolution/scoped-software-dossier.ts";
import type { NativeExecutionSnapshot } from "../../../application/work/native-execution/contract.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { requireEvolution } from "../../../domain/model/evolution/policy.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import { classifyEvolutionEffects } from "../../../domain/model/evolution/semantic-effects.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ModelRepositoryPort } from "../../../application/model/repository.ts";
import {
  createEvolutionAuthorityExercise,
  requireEvolutionEffectBounds,
} from "../../../domain/model/evolution/authorization.ts";
import { compileEvolutionAssessment } from "../../../application/model/evolution/assessment.ts";

export interface PreparedScopedSourceEvidence {
  before: ModelRevision;
  after: ModelRevision;
  assessment: Awaited<ReturnType<typeof compileEvolutionAssessment>>;
  sources: Map<string, ScopedExecutableModel[]>;
  operations:
    readonly import("../../../domain/governance/policies/model-edit-policy.ts").ModelEditOperation[];
  facilities: Map<
    string,
    Awaited<
      ReturnType<
        import("../native-execution/postgres.ts").PostgresAdmittedRequestRuntime[
          "forCaseSpace"
        ]
      >
    >
  >;
  verifiedPriorSources: Set<string>;
}
interface CurrentSourceDiscovery {
  observed: Map<string, ExecutableModel>;
  snapshots: NativeExecutionSnapshot[];
  chain: import("./request-source-admission-store.ts").AdmittedSourceChain;
}
interface PreparedScopedCurrentEvidence extends PreparedScopedSourceEvidence {
  dossier: string;
  transaction?: Prisma.TransactionClient;
  membership: string;
  observed: Map<string, ExecutableModel>;
}

/** Immutable source preparation is separate from the caller-owned SQL guard.
 * Tokens are private, exact-dossier and usable by one transaction only. */
export class ScopedSoftwareCurrentAuthority {
  readonly #prepared = new WeakMap<object, PreparedScopedCurrentEvidence>();
  private actorIds(d: ScopedSoftwareEvolutionDossierV2): string[] {
    return [
      ...new Set([
        ...d.scope.targets.map((t) => t.target.operatorId),
        d.preparation.operatorNativeId,
        d.acceptance?.operatorNativeId,
        d.adoptionAuthorization?.operatorNativeId,
      ].filter((id): id is string => !!id)),
    ].sort();
  }
  private async membership(
    tx: Prisma.TransactionClient,
    d: ScopedSoftwareEvolutionDossierV2,
    lock: boolean,
  ): Promise<string> {
    const { Prisma, postgresQualifiedTable } = await import(
      "./client.ts"
    );
    const rows: unknown[] = [];
    for (const operatorId of this.actorIds(d)) {
      for (
        const table of [
          "ExecutionThreadBinding",
          "OperatorExecution",
          "ExecutionRun",
          "ExecutionContribution",
          "ExecutionEffect",
          "ImmutableConsultationGroup",
        ] as const
      ) {
        const found = await tx.$queryRaw<Array<{ payload: string }>>(
          Prisma.sql`SELECT row_to_json(t)::text AS payload FROM ${
            postgresQualifiedTable(this.options.client, table)
          } t WHERE "projectId"=${d.scope.destination.host.projectId} AND "systemId"=${d.scope.destination.host.systemId} AND "executionSpaceId"=${d.scope.destination.executionSpaceId} AND "operatorId"=${operatorId} ORDER BY row_to_json(t)::text LIMIT 257 ${
            lock ? Prisma.sql`FOR SHARE NOWAIT` : Prisma.empty
          }`,
        );
        requireEvolution(
          found.length <= 256,
          "Native software publication membership exceeds its bound",
        );
        rows.push([operatorId, table, found.map((row) => row.payload)]);
      }
    }
    return canonical(rows);
  }
  /** Caller holds the canonical repository writer lock from Git/ref proof
   * preparation through the guarded commit. No mutation/#exclusive may run in
   * this interval; current permission is established only by the locked check. */
  async prepareCurrent(
    dossier: ScopedSoftwareEvolutionDossierV2,
  ): Promise<object> {
    const { parseScopedSoftwareDossier } = await import(
      "../../../application/model/evolution/scoped-software-dossier.ts"
    );
    const { decodePostgresRuntimeState } = await import(
      "./runtime-state-snapshot.ts"
    );
    const { decodePostgresOpening } = await import(
      "./request-space-store.ts"
    );
    const d = await parseScopedSoftwareDossier(dossier), scope = d.scope;
    // Discovery owns no authority. Close this bounded read snapshot before any
    // Git I/O or native source compilation; all observations are checked again.
    const discovery = await this.options.client.$transaction(async (tx) => {
      const observed = new Map<string, ExecutableModel>();
      const snapshots: NativeExecutionSnapshot[] = [];
      for (const operatorId of this.actorIds(d)) {
        const key = {
          ...scope.destination.host,
          executionSpaceId: scope.destination.executionSpaceId,
          operatorId,
        };
        const row = await tx.runtimeState.findFirst({ where: key });
        requireEvolution(
          row,
          "Software evidence discovery runtime is unavailable",
        );
        const state = decodePostgresRuntimeState(row);
        requireEvolution(
          state.executionModel,
          "Software evidence discovery has no executed model",
        );
        requireEvolution(
          state.executionModel.version.repositoryVersion,
          "Software evidence discovery has no exact source version",
        );
        observed.set(operatorId, state.executionModel);
        const runs = await tx.executionRun.findMany({ where: key, take: 257 });
        requireEvolution(
          runs.length <= 256,
          "Native source discovery exceeds its bound",
        );
        for (const run of runs) {
          if (run.snapshotJson) snapshots.push(JSON.parse(run.snapshotJson));
        }
      }
      const row = await tx.spaceOpening.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope.destination.host,
            executionSpaceId: scope.destination.executionSpaceId,
          },
        },
      });
      requireEvolution(
        row && row.id === scope.destination.openingId &&
          row.baseDigest === scope.openingBaseDigest,
        "Software evidence discovery opening differs",
      );
      const opening = decodePostgresOpening(row);
      const chain = await this.options.journal.readAdmittedSource(tx, opening);
      return {
        observed,
        snapshots,
        membership: await this.membership(tx, d, false),
        chain,
      };
    }, { isolationLevel: "RepeatableRead" });
    const source = await this.prepareSourceEvidence(d, discovery);
    requireEvolution(
      source.assessment.digest === d.scopedProposal.sourceAssessmentDigest,
      "Prepared source assessment changed",
    );
    const token = Object.freeze({});
    this.#prepared.set(token, {
      ...source,
      dossier: canonical(d),
      membership: discovery.membership,
      observed: discovery.observed,
    });
    return token;
  }

  /** Immutable source compiler boundary. It is never entered by a locked check.
   * The protected boundary permits deterministic compiler-port qualification. */
  protected async prepareSourceEvidence(
    d: ScopedSoftwareEvolutionDossierV2,
    discovery: CurrentSourceDiscovery,
  ): Promise<PreparedScopedSourceEvidence> {
    const revisions = new Map<string, Promise<ModelRevision>>();
    const revision = (version: string) => {
      let value = revisions.get(version);
      if (!value) {
        value = this.options.repository.at(version).then((loaded) => {
          requireEvolution(
            loaded.version === version,
            "Prepared Git commit differs",
          );
          return loaded;
        });
        revisions.set(version, value);
      }
      return value;
    };
    const before = await revision(d.proposal.baseVersion),
      after = await revision(d.proposal.version);
    const assessment = await compileEvolutionAssessment({
      before,
      after,
      projectId: `git:${d.scope.destination.repositoryId}`,
      recipeDigest: d.proposal.recipeDigest,
    }, this.options.compilation);
    requireEvolution(
      assessment.digest === d.scopedProposal.sourceAssessmentDigest,
      "Prepared source assessment changed",
    );
    const sources = new Map<string, ScopedExecutableModel[]>([[
      before.version,
      assessment.before,
    ]]);
    const versions = new Set(
      [
        ...d.scope.targets.map((entry) => entry.previousPin.source.version),
        ...discovery.observed.values(),
      ].map((value) =>
        typeof value === "string" ? value : value.version.repositoryVersion!
      ),
    );
    for (const snapshot of discovery.snapshots) {
      if (snapshot.repositoryVersion) {
        versions.add(snapshot.repositoryVersion);
      }
    }
    for (const version of versions) {
      if (!sources.has(version)) {
        sources.set(
          version,
          await this.options.compilation.compile(
            await revision(version),
            `git:${d.scope.destination.repositoryId}`,
          ),
        );
      }
    }
    requireEvolution(
      this.options.sourceOperations,
      "Software source recipe evidence is unavailable",
    );
    const operations = await this.options.sourceOperations(d);
    const facilities = new Map<
      string,
      Awaited<ReturnType<typeof this.options.native.forCaseSpace>>
    >();
    for (const target of d.scope.targets) {
      facilities.set(
        target.target.operatorId,
        await this.options.native.forCaseSpace(
          d.scope.destination.executionSpaceId,
          d.scope.destination.caseId,
        ),
      );
    }
    const verifiedPriorSources = new Set<string>();
    // Only immutable Git/native evidence is prepared. Current grants and SQL
    // lineage remain the responsibility of the actual guarded transaction.
    for (const source of discovery.chain.softwareReceipts) {
      if (
        discovery.chain.execution.softwareAdoptions.some((entry) =>
          entry.manifest.sourceAdmission.revision === source.revision &&
          entry.manifest.sourceAdmission.manifestDigest ===
            source.manifestDigest
        )
      ) {
        await this.options.verifyGit(source.payload);
        verifiedPriorSources.add(canonical(source.payload));
      }
    }
    return {
      before,
      after,
      assessment,
      sources,
      operations,
      facilities,
      verifiedPriorSources,
    };
  }

  constructor(
    readonly options: {
      compilation: SourceEvolutionCompilationPort;
      client: import("./client.ts").PrismaClient;
      primaryControl: Pick<
        import("./primary-space-control-source.ts").PostgresPrimarySpaceControlSource,
        "readLocked"
      >;
      sqlAdmissions: Pick<
        import("./request-space-control-store.ts").PostgresSpaceAdmissions,
        "assertEffectStart"
      >;
      native:
        import("../native-execution/postgres.ts").PostgresAdmittedRequestRuntime;
      journal:
        import("./request-source-admission-store.ts").PostgresRequestSourceAdmissionStore;
      bindings:
        import("./request-execution-binding.ts").PostgresRequestExecutionBindingReader;
      verifyGit(
        admission:
          import("../../../application/model/source-admission/scoped-software-source-admission.ts").ScopedSoftwareSourceAdmissionV2,
      ): Promise<void>;
      repository: Pick<ModelRepositoryPort, "at">;
      /** Derive the exact targeted operations from the retained, recipe-bound
       * staged proposal. A whole-files payload is not evidence of replace-source. */
      sourceOperations?(
        dossier:
          import("../../../application/model/evolution/scoped-software-dossier.ts").ScopedSoftwareEvolutionDossierV2,
      ): Promise<
        readonly import("../../../domain/governance/policies/model-edit-policy.ts").ModelEditOperation[]
      >;
    },
  ) {}
  /** Caller chooses this existing PRIMARY lock's place in the native lock
   * order. No credential/admission/native lock is acquired by this method. */
  async lockPrimary(
    tx: import("./client.ts").Prisma.TransactionClient,
  ): Promise<void> {
    await this.options.primaryControl.readLocked(tx);
  }
  /** New effects only: revalidate the actual saved old-R execution admission.
   * Historical D2/receipt verification never invokes this current-policy guard. */
  async assertAdmissionLocked(
    tx: import("./client.ts").Prisma.TransactionClient,
    dossier:
      import("../../../application/model/evolution/scoped-software-dossier.ts").ScopedSoftwareEvolutionDossierV2,
  ): Promise<void> {
    const { parseScopedSoftwareDossier } = await import(
      "../../../application/model/evolution/scoped-software-dossier.ts"
    );
    const { decodePostgresOpening } = await import(
      "./request-space-store.ts"
    );
    const d = await parseScopedSoftwareDossier(dossier), scope = d.scope;
    const key = {
      ...scope.destination.host,
      executionSpaceId: scope.destination.executionSpaceId,
    };
    const row = await tx.spaceOpening.findUnique({
      where: { projectId_systemId_executionSpaceId: key },
    });
    requireEvolution(
      row && row.id === scope.destination.openingId &&
        row.projectId === key.projectId && row.systemId === key.systemId &&
        row.caseId === scope.destination.caseId &&
        row.branchId === scope.destination.branchId &&
        row.baseDigest === scope.openingBaseDigest &&
        ["admitted", "dispatched"].includes(row.phase),
      "Current software admission opening differs",
    );
    const opening = decodePostgresOpening(row),
      binding = await this.options.bindings.readInTransaction(tx, opening);
    const actual = binding.state.executionModel;
    requireEvolution(
      actual &&
        scope.actor.operatorId === opening.base?.requestOwner.operatorId &&
        scope.actor.executionSpaceId === opening.executionSpaceId &&
        actual.identity.builderId === scope.actor.operatorId &&
        actual.version.digest === binding.pin.modelDigest &&
        actual.version.repositoryVersion === binding.pin.source.version &&
        scope.targets.every((entry) =>
          entry.target.operatorId === actual.identity.builderId &&
          canonical(entry.previousPin) === canonical(binding.pin)
        ),
      "Current software admission no longer executes the exact signed old-R pin",
    );
    const space = await tx.executionSpace.findUnique({
      where: { projectId_systemId_executionSpaceId: key },
    });
    requireEvolution(
      space && space.projectId === key.projectId &&
        space.systemId === key.systemId && space.caseId === opening.caseId &&
        space.parentExecutionSpaceId === "main" &&
        space.lifecycle === "active" && space.closedAt === null,
      "Current software admission space is closed",
    );
    await this.options.sqlAdmissions.assertEffectStart(tx, {
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
  }
  async assertCurrentPreparedLocked(
    tx: import("./client.ts").Prisma.TransactionClient,
    dossier:
      import("../../../application/model/evolution/scoped-software-dossier.ts").ScopedSoftwareEvolutionDossierV2,
    token: object,
  ): Promise<void> {
    const { parseScopedSoftwareDossier } = await import(
      "../../../application/model/evolution/scoped-software-dossier.ts"
    );
    const { decodePostgresRuntimeState } = await import(
      "./runtime-state-snapshot.ts"
    );
    const { decodeHistorical } = await import(
      "./system-state-store.ts"
    );
    const { createOperatorEditAuthorization } = await import(
      "../../../application/governance/model-access/operator-edit-authorization.ts"
    );
    const { assertModelEditScope } = await import(
      "../../../domain/model/editing/scope.ts"
    );
    const { MODEL_DELEGATIONS_FILE } = await import(
      "../../../domain/governance/policies/model-delegation-ledger.ts"
    );
    const d = await parseScopedSoftwareDossier(dossier);
    const scope = d.scope;
    const prepared = this.#prepared.get(token);
    requireEvolution(
      prepared && prepared.dossier === canonical(d),
      "Foreign or changed prepared software authority dossier",
    );
    requireEvolution(
      !prepared.transaction || prepared.transaction === tx,
      "Prepared software authority belongs to another transaction",
    );
    prepared.transaction = tx;
    await this.lockPrimary(tx);
    requireEvolution(
      await this.membership(tx, d, true) === prepared.membership,
      "Prepared native software membership changed; reprepare",
    );
    const { Prisma, postgresQualifiedTable } = await import(
      "./client.ts"
    );
    const { evolutionCheckpoint } = await import(
      "../../../application/work/runtime/evolution.ts"
    );
    const ids = [
      ...new Set([
        ...scope.targets.map((t) => t.target.operatorId),
        d.preparation.operatorNativeId,
        d.acceptance?.operatorNativeId,
        d.adoptionAuthorization?.operatorNativeId,
      ].filter((id): id is string => !!id)),
    ].sort();
    // NOWAIT preserves the established ordering: a concurrent native/control
    // owner causes a retry, never waiting for work completion under Git locks.
    for (const operatorId of ids) {
      const owner = await tx.$queryRaw<Array<{ operatorId: string }>>(
        Prisma.sql`SELECT "operatorId" FROM ${
          postgresQualifiedTable(this.options.client, "OperatorRuntime")
        } WHERE "projectId"=${scope.destination.host.projectId} AND "systemId"=${scope.destination.host.systemId} AND "executionSpaceId"=${scope.destination.executionSpaceId} AND "operatorId"=${operatorId} FOR SHARE NOWAIT`,
      );
      requireEvolution(
        owner.length === 1,
        "Locked actual software authority runtime is unavailable",
      );
    }
    const { decodePostgresOpening } = await import(
      "./request-space-store.ts"
    );
    const openingRow = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...scope.destination.host,
          executionSpaceId: scope.destination.executionSpaceId,
        },
      },
    });
    requireEvolution(
      openingRow && openingRow.id === scope.destination.openingId &&
        openingRow.projectId === scope.destination.host.projectId &&
        openingRow.systemId === scope.destination.host.systemId &&
        openingRow.caseId === scope.destination.caseId &&
        openingRow.branchId === scope.destination.branchId &&
        openingRow.baseDigest === scope.openingBaseDigest,
      "Current software execution opening is unavailable",
    );
    const opening = decodePostgresOpening(openingRow);
    const binding = await this.options.bindings.readInTransaction(tx, opening);
    requireEvolution(
      ids.every((id) => binding.admission.permissions.operatorIds.includes(id)),
      "Software actor/target lacks actual scoped execution admission",
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.options.client, "SpaceControlCredential")
      } WHERE "projectId"=${scope.destination.host.projectId} AND "systemId"=${scope.destination.host.systemId} AND "id"=${binding.admission.capabilityId} FOR SHARE NOWAIT`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
      } WHERE "projectId"=${scope.destination.host.projectId} AND "systemId"=${scope.destination.host.systemId} AND "id"=${binding.admission.id} FOR SHARE NOWAIT`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "executionSpaceId" FROM ${
        postgresQualifiedTable(this.options.client, "ExecutionSpace")
      } WHERE "projectId"=${scope.destination.host.projectId} AND "systemId"=${scope.destination.host.systemId} AND "executionSpaceId"=${scope.destination.executionSpaceId} FOR SHARE NOWAIT`,
    );
    const live = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma
        .sql`WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT a."id" FROM cutoff, ${
        postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
      } a, ${
        postgresQualifiedTable(this.options.client, "SpaceControlCredential")
      } c, ${
        postgresQualifiedTable(this.options.client, "ExecutionSpace")
      } s WHERE a."projectId"=${scope.destination.host.projectId} AND a."systemId"=${scope.destination.host.systemId} AND a."id"=${binding.admission.id} AND a."revision"=${binding.admission.revision} AND a."status"='active' AND a."expiresAt">cutoff.at AND c."projectId"=a."projectId" AND c."systemId"=a."systemId" AND c."id"=a."capabilityId" AND c."revision"=a."capabilityRevision" AND c."kind"='capability' AND c."status"='active' AND s."projectId"=a."projectId" AND s."systemId"=a."systemId" AND s."executionSpaceId"=a."executionSpaceId" AND s."caseId"=${scope.destination.caseId} AND s."parentExecutionSpaceId"='main' AND s."lifecycle"='active' AND s."closedAt" IS NULL`,
    );
    requireEvolution(
      live.length === 1 && ["admitted", "dispatched"].includes(opening.phase),
      "Current scoped software admission is revoked, expired or closed",
    );
    const state = async (operatorId: string) => {
      const key = {
        ...scope.destination.host,
        executionSpaceId: scope.destination.executionSpaceId,
        operatorId,
      };
      const row = await tx.runtimeState.findFirst({ where: key });
      const latest = await tx.runtimeRevision.findFirst({
        where: key,
        orderBy: { revision: "desc" },
      });
      requireEvolution(
        row && latest,
        "Current scoped authority has no canonical runtime history",
      );
      const current = decodePostgresRuntimeState(row);
      requireEvolution(
        canonical(current) === canonical(decodeHistorical(latest)) &&
          current.executionModel?.identity.builderId === operatorId,
        "Scoped current authority and history disagree",
      );
      requireEvolution(
        canonical(current.executionModel) ===
          canonical(prepared.observed.get(operatorId)),
        "Prepared actual software executable changed; reprepare",
      );
      return current;
    };
    const actors = new Map<string, ExecutableModel>();
    for (
      const receipt of [d.preparation, d.acceptance, d.adoptionAuthorization]
    ) {
      requireEvolution(
        receipt,
        "Publication/adoption requires all three native acts",
      );
      const current = await state(receipt.operatorNativeId);
      actors.set(receipt.operatorNativeId, current.executionModel!);
    }
    const assessment = prepared.assessment;
    const source = (version: string) => {
      const value = prepared.sources.get(version);
      requireEvolution(value, "Unprepared native source tuple; reprepare");
      return value;
    };
    const previous = [...assessment.before];
    for (const entry of scope.targets) {
      const current = await state(entry.target.operatorId);
      requireEvolution(
        current.executionModel?.version.digest ===
            entry.previousPin.modelDigest &&
          current.executionModel.version.repositoryVersion ===
            entry.previousPin.source.version,
        "Locked scoped target no longer executes the signed previous pin",
      );
      const retained = source(entry.previousPin.source.version);
      const exact = retained.find((item) =>
        item.model.identity.builderId === entry.target.operatorId &&
        item.model.version.digest === entry.previousPin.modelDigest
      );
      const index = previous.findIndex((item) =>
        item.model.identity.builderId === entry.target.operatorId
      );
      requireEvolution(
        exact && index >= 0,
        "Locked old executable evidence is unavailable",
      );
      previous[index] = exact;
      if (d.status === "publishing") {
        const key = {
          ...scope.destination.host,
          executionSpaceId: scope.destination.executionSpaceId,
          operatorId: entry.target.operatorId,
        };
        requireEvolution(
          await tx.executionContribution.count({
                where: { ...key, status: { in: ["queued", "running"] } },
              }) === 0 &&
            await tx.executionEffect.count({
                where: { ...key, status: { not: "completed" } },
              }) === 0 &&
            await tx.immutableConsultationGroup.count({
                where: { ...key, publicationJson: null },
              }) === 0,
          "Unsettled native work blocks source publication",
        );
        const threads = await tx.operatorExecution.findMany({
          where: { ...key, retiredAt: null, status: { not: "completed" } },
        });
        const snapshots:
          import("../../../application/work/native-execution/contract.ts").NativeExecutionSnapshot[] =
            [];
        let inert = new Set<string>();
        if (threads.some((thread) => thread.status === "queued")) {
          const { decodePostgresOpening } = await import(
            "./request-space-store.ts"
          );
          const { parseScopedSoftwareNeverStartedSuccessorContext } =
            await import(
              "../../../application/work/evolution/scoped-software-adoption-successor.ts"
            );
          const openingRow = await tx.spaceOpening.findUnique({
            where: {
              projectId_systemId_executionSpaceId: {
                ...scope.destination.host,
                executionSpaceId: scope.destination.executionSpaceId,
              },
            },
          });
          requireEvolution(
            openingRow && openingRow.id === scope.destination.openingId &&
              openingRow.projectId === scope.destination.host.projectId &&
              openingRow.systemId === scope.destination.host.systemId &&
              openingRow.caseId === scope.destination.caseId &&
              openingRow.branchId === scope.destination.branchId &&
              openingRow.baseDigest === scope.openingBaseDigest,
            "Inert successor Request opening missing",
          );
          const opening = decodePostgresOpening(openingRow);
          const binding = await this.options.bindings.readInTransaction(
              tx,
              opening,
            ),
            chain = await this.options.journal.readAdmittedSource(tx, opening);
          requireEvolution(
            canonical(binding.pin) === canonical(entry.previousPin) &&
              binding.pin.adoption,
            "Inert successor has no exact current adoption pin",
          );
          const pin = binding.pin, adoption = pin.adoption!;
          const software = chain.execution.softwareAdoptions.find((item) =>
            item.manifest.dossierId === adoption.commandId &&
            item.manifest.committedRuntimeRevision ===
              adoption.committedRuntimeRevision
          );
          const human = chain.execution.adoptions.find((item) =>
            item.receipt.commandId === adoption.commandId &&
            item.receipt.receiptDigest === adoption.receiptDigest
          );
          requireEvolution(
            Boolean(software) !== Boolean(human),
            "Inert successor prior adoption is ambiguous",
          );
          let context:
            import("../../../application/work/evolution/scoped-software-adoption-successor.ts").ScopedSoftwareNeverStartedSuccessorContext;
          if (software) {
            const source = chain.softwareReceipts.find((item) =>
              item.revision === software.manifest.sourceAdmission.revision &&
              item.manifestDigest ===
                software.manifest.sourceAdmission.manifestDigest
            );
            requireEvolution(
              source,
              "Prior inert software source admission is unavailable",
            );
            const { readScopedSoftwareSourceAdmissionProof } = await import(
              "./scoped-software-source-publication-participant.ts"
            );
            await readScopedSoftwareSourceAdmissionProof(
              tx,
              this.options.client,
              source,
            );
            requireEvolution(
              prepared.verifiedPriorSources.has(canonical(source.payload)),
              "Prepared prior software Git proof differs; reprepare",
            );
            context = await parseScopedSoftwareNeverStartedSuccessorContext({
              currentPin: pin,
              previous: {
                kind: "software",
                ...software,
                source: source.payload,
              },
            });
          } else {context =
              await parseScopedSoftwareNeverStartedSuccessorContext({
                currentPin: pin,
                previous: {
                  kind: "human",
                  manifest: human!.manifest,
                  receipt: human!.receipt,
                },
              });}
          const facility = prepared.facilities.get(entry.target.operatorId);
          requireEvolution(
            facility,
            "Prepared native software facility is unavailable",
          );
          inert = new Set(
            await facility.ledger
              .assertScopedSoftwareInertSuccessorsInTransaction(
                tx,
                entry.target.operatorId,
                context,
              ),
          );
        }
        for (const thread of threads) {
          if (inert.has(thread.threadId)) continue;
          const run = await tx.executionRun.findFirst({
            where: {
              ...key,
              threadId: thread.threadId,
              runId: thread.currentRunId ?? "",
            },
          });
          requireEvolution(
            run?.snapshotJson,
            "Active native thread has no completed checkpoint evidence",
          );
          snapshots.push(JSON.parse(run.snapshotJson));
        }
        const models: ExecutableModel[] = [];
        for (const snapshot of snapshots) {
          const retained = source(snapshot.repositoryVersion!);
          const model = retained.find((s) =>
            s.model.identity.builderId === entry.target.operatorId &&
            s.model.version.digest === snapshot.modelDigest
          );
          requireEvolution(
            model,
            "Native publication checkpoint has no retained exact model",
          );
          models.push(model.model);
        }
        const { PostgresWorkBudgetStore } = await import(
          "./budget-store.ts"
        );
        const candidate = assessment.after.find((item) =>
          item.model.identity.builderId === entry.target.operatorId
        )?.model;
        requireEvolution(
          candidate,
          "The current budget candidate is unavailable",
        );
        const projected = await new PostgresWorkBudgetStore(
          this.options.client,
          key,
        ).projectEvolutionBudgetsInTransaction(
          tx,
          current,
          undefined,
          candidate,
        );
        requireEvolution(
          projected.reserved.length === 0,
          "A current durable budget reservation blocks source publication",
        );
        const checkpoint = evolutionCheckpoint(
          projected.state,
          snapshots,
          models,
        );
        requireEvolution(
          checkpoint.safe,
          "Current native/business receipts no longer prove safe publication",
        );
      }
    }
    const runtimeEffects = classifyEvolutionEffects(previous, assessment.after);
    const effects = [
      ...new Map(
        [...assessment.effects, ...runtimeEffects].map((
          effect,
        ) => [canonical([effect.targetNativeId, effect.category]), effect]),
      ).values(),
    ];
    requireEvolution(
      canonical([...new Set(effects.map((e) => e.targetNativeId))].sort()) ===
          canonical(d.proposal.targets.map((t) => t.operatorId).sort()) &&
        canonical([...new Set(effects.map((e) => e.category))].sort()) ===
          canonical([...d.proposal.categories].sort()),
      "Locked runtime delta exceeds the signed target/category set",
    );
    // The immutable context binds the preparer. Separate accept/adopt actors
    // remain explicitly receipt-bound actual runtimes in this same Request.
    for (
      const receipt of [d.preparation, d.acceptance!, d.adoptionAuthorization!]
    ) {
      const actor = actors.get(receipt.operatorNativeId)!;
      // Native receipt signature is over the ORIGINAL scoped proposal, including
      // preparer identity; accepting does not rewrite that proposal context.
      const actorSource = source(actor.version.repositoryVersion!);
      const exact = actorSource.find((s) =>
        s.model.identity.builderId === actor.identity.builderId &&
        s.model.version.digest === actor.version.digest
      );
      requireEvolution(exact, "Locked actor prior executable source changed");
      requireEvolutionEffectBounds(
        actor,
        receipt.act,
        assessment.effects,
        assessment.before,
        assessment.after,
      );
      requireEvolutionEffectBounds(
        actor,
        receipt.act,
        runtimeEffects,
        previous,
        assessment.after,
      );
      const expected = await createEvolutionAuthorityExercise(actor, {
        act: receipt.act,
        systemQualifiedName: exact.systemQualifiedName,
        targets: d.proposal.targets.map((t) => t.operatorId),
        categories: d.proposal.categories,
        proposalDigest: d.proposal.digest,
        effects,
      });
      requireEvolution(
        canonical(expected) === canonical(receipt),
        "Locked native software authority was revoked or changed",
      );
    }
    const operations = prepared.operations;
    const actor = actors.get(d.preparation.operatorNativeId)!;
    const before = prepared.before, after = prepared.after;
    await createOperatorEditAuthorization(actor, before, operations);
    requireEvolution(
      before.sources[MODEL_DELEGATIONS_FILE] ===
        after.sources[MODEL_DELEGATIONS_FILE],
      "Software evolution cannot change delegation authority",
    );
    assertModelEditScope(before, after, actor.modelEditPolicy!.grants);
  }
}

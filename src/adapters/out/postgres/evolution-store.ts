import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import {
  assertScopedSoftwareTransition,
  parseScopedSoftwareDossier,
  type ScopedSoftwareEvolutionDossierV2,
} from "../../../application/model/evolution/scoped-software-dossier.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "../../../application/model/evolution/scoped-software-context.ts";
import {
  assertScopedSoftwareAdoptionRevisionSequence,
  type ScopedSoftwareAdoptionManifestV2,
  type ScopedSoftwareAdoptionReceiptV2,
} from "../../../application/model/evolution/scoped-software-adoption.ts";
import {
  isSha256Hex,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import { readScopedSoftwareSourceAdmissionProof } from "./scoped-software-source-publication-participant.ts";
import { decodeHistorical } from "./system-state-store.ts";
import { decodeRequestSpaceOpening } from "./request-space-store.ts";
import { decodeSpaceExecutionAdmission } from "./request-space-control-store.ts";
import { MAX_BRANCH_TEAM } from "../../../domain/work/records/conversations.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import {
  assertOpeningBase,
  type OpeningRecord,
} from "../../../domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../../domain/work/request-spaces/scope.ts";
import {
  assertRequestOwnerAdoptionTransition,
  parseRequestAdoptionTarget,
  parseRequestOwnerAdoptionDossier,
  requestAdoptionOwnerId,
  requestAdoptionScopeKey,
} from "../../../application/model/evolution/request-adoption-invariants.ts";
import type {
  RequestAdoptionTarget,
  RequestOwnerAdoptionDossier,
  RequestOwnerAdoptionStorePort,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import { postgresExecutionTransaction } from "./execution-transaction.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  assertEvolutionDossier,
  assertEvolutionTransition,
} from "../../../application/model/evolution/invariants.ts";
import {
  type EvolutionDossier,
  EvolutionError,
  type EvolutionStorePort,
  hasEvolutionBarrier,
} from "../../../application/model/evolution/ports.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { postgresBigInt, postgresSafeInteger } from "./numbers.ts";
import {
  assertPostgresSystemScope,
  type PostgresSystemScope,
} from "./scope.ts";

const MAX_DOSSIER_BYTES = 4 * 1_048_576;
const MAX_PENDING = 256;
const pending = [
  "prepared",
  "accepted",
  "armed",
  "publishing",
  "published-awaiting-adoption",
];

interface Row {
  payload: string;
  revision: bigint;
  status: string;
  repositoryId: string;
  updatedAt: string;
  kind: string;
  targetScopeKey: string;
  executionSpaceId: string | null;
}

function corrupt(): never {
  throw new EvolutionError(
    "EVOLUTION_STORE_CORRUPT",
    "Stored dossier identity or canonical payload differs",
  );
}

/** Dossiers outlive Cases and runtime stores. A repository row is the write
 * exclusion for its pending bound and complete multi-target barrier ownership. */
export class PostgresEvolutionStore implements EvolutionStorePort {
  readonly #scope: PostgresSystemScope;
  readonly #listeners = new Set<() => void>();
  readonly #requestListeners = new Map<string, Set<() => void>>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly client: PrismaClient,
    scope: PostgresSystemScope,
  ) {
    assertPostgresSystemScope(scope);
    this.#scope = Object.freeze({
      projectId: scope.projectId,
      systemId: scope.systemId,
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #committed(dossier: EvolutionDossier): EvolutionDossier {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch { /* An observer cannot undo a committed dossier. */ }
    }
    return dossier;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(async () => {
      if (this.#closed) {
        throw new EvolutionError(
          "EVOLUTION_INVALID",
          "Evolution store is closed",
        );
      }
      return await operation();
    });
    this.#tail = work.then(() => {}, () => {});
    return work;
  }

  #row(database: PrismaClient | Prisma.TransactionClient, id: string) {
    return database.evolutionDossier.findUnique({
      where: { projectId_systemId_id: { ...this.#scope, id } },
    });
  }

  #parse(id: string, row: Row): EvolutionDossier {
    try {
      if (
        row.kind !== "software-evolution-v1" || row.targetScopeKey !== "main" ||
        row.executionSpaceId !== null
      ) corrupt();
      if (new TextEncoder().encode(row.payload).length > MAX_DOSSIER_BYTES) {
        corrupt();
      }
      const dossier = JSON.parse(row.payload) as EvolutionDossier;
      assertEvolutionDossier(dossier);
      if (
        dossier.id !== id ||
        dossier.revision !== postgresSafeInteger(row.revision) ||
        dossier.status !== row.status ||
        dossier.repositoryId !== row.repositoryId ||
        dossier.updatedAt !== row.updatedAt ||
        canonical(dossier) !== row.payload
      ) corrupt();
      return dossier;
    } catch {
      corrupt();
    }
  }

  #payload(dossier: EvolutionDossier): string {
    assertEvolutionDossier(dossier);
    const payload = canonical(dossier);
    if (new TextEncoder().encode(payload).length > MAX_DOSSIER_BYTES) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Evolution dossier exceeds its size bound",
      );
    }
    return payload;
  }

  async #lockRepository(
    transaction: Prisma.TransactionClient,
    repositoryId: string,
  ): Promise<void> {
    const table = postgresQualifiedTable(this.client, "SourceRepository");
    const rows = await transaction.$queryRaw<Array<{ repositoryId: string }>>(
      Prisma.sql`
        SELECT "repositoryId" FROM ${table}
        WHERE "projectId" = ${this.#scope.projectId}
          AND "systemId" = ${this.#scope.systemId}
          AND "repositoryId" = ${repositoryId}
        FOR UPDATE
      `,
    );
    if (!rows.length) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Evolution repository is not registered in this system",
      );
    }
  }

  async create(dossier: EvolutionDossier): Promise<EvolutionDossier> {
    const next = structuredClone(dossier);
    const payload = this.#payload(next);
    if (next.status !== "prepared" || next.revision !== 0) {
      return Promise.reject(
        new EvolutionError(
          "EVOLUTION_INVALID",
          "New dossier must be prepared at revision zero",
        ),
      );
    }
    return await this.#exclusive(async () => {
      try {
        const result = await postgresExecutionTransaction(
          this.client,
          async (transaction) => {
            await this.#lockRepository(transaction, next.repositoryId);
            if (await this.#row(transaction, next.id)) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier already exists",
              );
            }
            await this.#assertRepositoryCapacity(
              transaction,
              next.repositoryId,
            );
            await transaction.evolutionDossier.create({
              data: {
                ...this.#scope,
                id: next.id,
                kind: "software-evolution-v1",
                targetScopeKey: "main",
                executionSpaceId: null,
                repositoryId: next.repositoryId,
                revision: postgresBigInt(next.revision),
                status: next.status,
                updatedAt: next.updatedAt,
                payload,
              },
            });
            return next;
          },
          { isolationLevel: "ReadCommitted" },
        );
        return this.#committed(result);
      } catch (error) {
        if (
          error && typeof error === "object" && "code" in error &&
          ["P2002", "P2034"].includes(String(error.code))
        ) {
          throw new EvolutionError(
            "EVOLUTION_CONFLICT",
            "Dossier already exists or changed",
          );
        }
        throw error;
      }
    });
  }

  get(id: string): Promise<EvolutionDossier | null> {
    return this.#exclusive(async () => {
      const row = await this.#row(this.client, id);
      if (!row) return null;
      if (row.kind === "request-owner-adoption-v2") {
        await this.#parseRequest(id, row);
        return null;
      }
      if (row.kind === "software-evolution-scoped-v2") {
        await this.#parseScoped(id, row);
        return null;
      }
      return this.#parse(id, row);
    });
  }

  listPending(repositoryId: string): Promise<EvolutionDossier[]> {
    return this.#exclusive(async () => {
      const rows = await this.client.evolutionDossier.findMany({
        where: {
          ...this.#scope,
          repositoryId,
          kind: "software-evolution-v1",
          targetScopeKey: "main",
          executionSpaceId: null,
          status: { in: pending },
        },
        orderBy: { id: "asc" },
      });
      return rows.map((row) => this.#parse(row.id, row));
    });
  }

  listRecent(repositoryId: string, limit: number): Promise<EvolutionDossier[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) {
      return Promise.reject(
        new EvolutionError(
          "EVOLUTION_INVALID",
          "Invalid dossier history bound",
        ),
      );
    }
    return this.#exclusive(async () => {
      const rows = await this.client.evolutionDossier.findMany({
        where: {
          ...this.#scope,
          repositoryId,
          kind: "software-evolution-v1",
          targetScopeKey: "main",
          executionSpaceId: null,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: limit,
      });
      return rows.map((row) => this.#parse(row.id, row));
    });
  }

  async compareAndSwap(
    id: string,
    expectedRevision: number,
    next: EvolutionDossier,
  ): Promise<EvolutionDossier> {
    const dossier = structuredClone(next);
    const payload = this.#payload(dossier);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return Promise.reject(
        new EvolutionError(
          "EVOLUTION_INVALID",
          "Invalid dossier expected revision",
        ),
      );
    }
    return await this.#exclusive(async () => {
      let claimingTargets = false;
      try {
        const result = await postgresExecutionTransaction(
          this.client,
          async (transaction) => {
            const observed = await this.#row(transaction, id);
            if (!observed) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier revision changed",
              );
            }
            await this.#lockRepository(transaction, observed.repositoryId);
            // Re-read after acquiring the repository lock: another writer may
            // have committed while this transaction was waiting for exclusion.
            const row = await this.#row(transaction, id);
            if (!row || row.revision !== postgresBigInt(expectedRevision)) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier revision changed",
              );
            }
            const previous = this.#parse(id, row);
            assertEvolutionTransition(previous, dossier);
            if (hasEvolutionBarrier(dossier.status)) {
              const missing: string[] = [];
              for (const target of dossier.proposal.targets) {
                const owner = await transaction.evolutionTargetBarrier
                  .findUnique(
                    {
                      where: {
                        projectId_systemId_repositoryId_targetScopeKey_operatorId:
                          {
                            ...this.#scope,
                            repositoryId: dossier.repositoryId,
                            targetScopeKey: "main",
                            operatorId: target.operatorId,
                          },
                      },
                    },
                  );
                if (owner && owner.dossierId !== id) {
                  throw new EvolutionError(
                    "EVOLUTION_TARGET_RESERVED",
                    `Operator ${target.operatorId} already has a pending revision`,
                  );
                }
                if (!owner) missing.push(target.operatorId);
              }
              claimingTargets = true;
              for (const operatorId of missing.sort()) {
                await transaction.evolutionTargetBarrier.create({
                  data: {
                    ...this.#scope,
                    repositoryId: dossier.repositoryId,
                    targetScopeKey: "main",
                    executionSpaceId: null,
                    operatorId,
                    dossierId: id,
                  },
                });
              }
              claimingTargets = false;
            } else {
              await transaction.evolutionTargetBarrier.deleteMany({
                where: {
                  ...this.#scope,
                  repositoryId: dossier.repositoryId,
                  targetScopeKey: "main",
                  executionSpaceId: null,
                  dossierId: id,
                },
              });
            }
            const update = await transaction.evolutionDossier.updateMany({
              where: {
                ...this.#scope,
                id,
                revision: postgresBigInt(expectedRevision),
              },
              data: {
                revision: postgresBigInt(dossier.revision),
                status: dossier.status,
                updatedAt: dossier.updatedAt,
                payload,
              },
            });
            if (update.count !== 1) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier revision changed during update",
              );
            }
            return dossier;
          },
          { isolationLevel: "ReadCommitted" },
        );
        return this.#committed(result);
      } catch (error) {
        if (
          error && typeof error === "object" && "code" in error &&
          String(error.code) === "P2002" && claimingTargets
        ) {
          throw new EvolutionError(
            "EVOLUTION_TARGET_RESERVED",
            "An evolution target already has a pending revision",
          );
        }
        if (
          error && typeof error === "object" && "code" in error &&
          ["P2002", "P2034"].includes(String(error.code))
        ) {
          throw new EvolutionError(
            "EVOLUTION_CONFLICT",
            "Dossier revision changed",
          );
        }
        throw error;
      }
    });
  }

  targetOwner(
    repositoryId: string,
    operatorId: string,
  ): Promise<string | null> {
    return this.#exclusive(() =>
      this.client.$transaction(async (transaction) => {
        const owner = await transaction.evolutionTargetBarrier.findUnique({
          where: {
            projectId_systemId_repositoryId_targetScopeKey_operatorId: {
              ...this.#scope,
              repositoryId,
              targetScopeKey: "main",
              operatorId,
            },
          },
        });
        if (!owner) return null;
        if (
          owner.targetScopeKey !== "main" || owner.executionSpaceId !== null
        ) corrupt();
        const row = await this.#row(transaction, owner.dossierId);
        if (!row) corrupt();
        const dossier = this.#parse(owner.dossierId, row);
        if (
          !hasEvolutionBarrier(dossier.status) ||
          dossier.repositoryId !== repositoryId ||
          !dossier.proposal.targets.some((target) =>
            target.operatorId === operatorId
          )
        ) corrupt();
        return owner.dossierId;
      }, { isolationLevel: "RepeatableRead" })
    );
  }

  /** One exclusion and one pending budget shared by both closed families. Never
   * add kind, targetScopeKey or executionSpaceId to this capacity predicate. */
  async #assertRepositoryCapacity(
    tx: Prisma.TransactionClient,
    repositoryId: string,
  ): Promise<void> {
    const count = await tx.evolutionDossier.count({
      where: { ...this.#scope, repositoryId, status: { in: pending } },
    });
    if (count >= MAX_PENDING) {
      throw new EvolutionError(
        "EVOLUTION_STORE_FULL",
        "Repository pending dossier bound reached",
      );
    }
  }

  async #parseRequest(
    id: string,
    row: Row,
  ): Promise<RequestOwnerAdoptionDossier> {
    try {
      if (new TextEncoder().encode(row.payload).length > MAX_DOSSIER_BYTES) {
        corrupt();
      }
      const dossier = await parseRequestOwnerAdoptionDossier(
        JSON.parse(row.payload),
      );
      const target = dossier.intent.target;
      if (
        dossier.id !== id ||
        dossier.revision !== postgresSafeInteger(row.revision) ||
        dossier.repositoryId !== row.repositoryId ||
        dossier.status !== row.status || dossier.updatedAt !== row.updatedAt ||
        row.kind !== "request-owner-adoption-v2" ||
        row.targetScopeKey !== requestAdoptionScopeKey(target) ||
        row.executionSpaceId !== target.executionSpaceId ||
        canonical(target.host) !== canonical(this.#scope) ||
        canonical(dossier) !== row.payload
      ) corrupt();
      return dossier;
    } catch {
      corrupt();
    }
  }

  async #parseScoped(
    id: string,
    row: Row,
  ): Promise<ScopedSoftwareEvolutionDossierV2> {
    try {
      if (new TextEncoder().encode(row.payload).length > MAX_DOSSIER_BYTES) {
        corrupt();
      }
      const d = await parseScopedSoftwareDossier(JSON.parse(row.payload));
      const destination = d.scope.destination;
      if (
        row.kind !== "software-evolution-scoped-v2" || d.id !== id ||
        d.repositoryId !== row.repositoryId || d.status !== row.status ||
        d.updatedAt !== row.updatedAt ||
        d.revision !== postgresSafeInteger(row.revision) ||
        row.executionSpaceId !== destination.executionSpaceId ||
        row.targetScopeKey !== `request:${destination.executionSpaceId}` ||
        canonical(destination.host) !== canonical(this.#scope) ||
        canonical(d) !== row.payload
      ) corrupt();
      return d;
    } catch {
      corrupt();
    }
  }

  async #assertScopedHistory(
    tx: Prisma.TransactionClient,
    d: ScopedSoftwareEvolutionDossierV2,
  ): Promise<void> {
    if (!d.adoptions.length) return;
    const destination = d.scope.destination;
    const row = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.#scope,
          executionSpaceId: destination.executionSpaceId,
        },
      },
    });
    if (!row || row.id !== destination.openingId) corrupt();
    const opening = decodeRequestSpaceOpening(row);
    const chain = await new PostgresRequestSourceAdmissionStore(this.client)
      .readAdmittedSource(tx, opening);
    for (const receipt of d.adoptions) {
      const entry = chain.execution.softwareAdoptions.find((item) =>
        item.manifest.dossierId === d.id &&
        item.manifest.target.operatorId === receipt.operatorId
      );
      const extended = receipt as Partial<ScopedSoftwareAdoptionReceiptV2>;
      if (
        !entry || extended.manifestDigest !== entry.manifestDigest ||
        extended.journalRevision !== entry.journalRevision ||
        extended.committedRuntimeRevision !==
          entry.manifest.committedRuntimeRevision ||
        extended.authorizationRuntimeRevision !==
          entry.manifest.authorizationRuntimeRevision ||
        entry.manifest.intentDigest !== d.intentDigest ||
        entry.manifest.proposalDigest !== d.proposal.digest
      ) corrupt();
      const source = chain.softwareReceipts.find((item) =>
        item.revision === entry.manifest.sourceAdmission.revision &&
        item.manifestDigest === entry.manifest.sourceAdmission.manifestDigest
      );
      if (!source) corrupt();
      await readScopedSoftwareSourceAdmissionProof(tx, this.client, source);
      const history = await tx.runtimeRevision.findFirst({
        where: {
          ...this.#scope,
          executionSpaceId: destination.executionSpaceId,
          operatorId: receipt.operatorId,
          revision: BigInt(entry.manifest.committedRuntimeRevision),
        },
      });
      const authorization = await tx.runtimeRevision.findFirst({
        where: {
          ...this.#scope,
          executionSpaceId: destination.executionSpaceId,
          operatorId: receipt.operatorId,
          revision: BigInt(entry.manifest.authorizationRuntimeRevision),
        },
      });
      if (!history || !authorization) corrupt();
      const state = decodeHistorical(history);
      const authorized = decodeHistorical(authorization);
      if (
        state.executionModel?.version.digest !== receipt.candidateDigest ||
        state.executionModel.version.repositoryVersion !== receipt.version ||
        authorized.executionModel?.version.digest !== receipt.previousDigest ||
        authorized.executionModel.version.repositoryVersion !==
          entry.manifest.boundary.previousPin.source.version ||
        authorized.events.filter((event) =>
            event.kind === "model-version-admission-authorized" &&
            event.modelAdoptionAuthorization?.softwareEvolution?.dossierId ===
              d.id &&
            canonical(
                event.modelAdoptionAuthorization.softwareEvolution.exercise,
              ) === canonical(d.adoptionAuthorization)
          ).length !== 1 ||
        state.events.filter((event) =>
            event.effectiveModelUpdate?.dossierId === d.id &&
            event.effectiveModelUpdate.caseId === destination.caseId &&
            event.effectiveModelUpdate.to.digest === receipt.candidateDigest &&
            event.effectiveModelUpdate.activatedAt === receipt.effectiveAt
          ).length !== 1
      ) corrupt();
    }
  }

  /** A factory-bound Request facade. All three families share the same
   * repository capacity and physical barrier key. */
  scopedSoftware(input: ScopedSoftwareContextV2) {
    const scope = parseScopedSoftwareContext(input);
    const destination = scope.destination;
    if (canonical(destination.host) !== canonical(this.#scope)) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign software evolution scope",
      );
    }
    const where = {
      ...this.#scope,
      repositoryId: destination.repositoryId,
      kind: "software-evolution-scoped-v2",
      executionSpaceId: destination.executionSpaceId,
      targetScopeKey: `request:${destination.executionSpaceId}`,
    };
    const locator = (s: ScopedSoftwareContextV2) => {
      const { expectedAdmittedSource: _source, ...identity } = s.destination;
      return identity;
    };
    const owned = (d: ScopedSoftwareEvolutionDossierV2) => {
      if (
        canonical(locator(d.scope)) !== canonical(locator(scope)) ||
        d.scope.openingBaseDigest !== scope.openingBaseDigest
      ) {
        throw new EvolutionError(
          "EVOLUTION_INVALID",
          "Foreign software intent scope",
        );
      }
    };
    const opening = async (tx: PrismaClient | Prisma.TransactionClient) => {
      const row = await tx.spaceOpening.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...this.#scope,
            executionSpaceId: destination.executionSpaceId,
          },
        },
      });
      if (
        !row || row.id !== destination.openingId ||
        row.caseId !== destination.caseId ||
        row.branchId !== destination.branchId ||
        row.baseDigest !== scope.openingBaseDigest || !row.baseJson
      ) corrupt();
      const base = JSON.parse(row.baseJson);
      assertOpeningBase(base);
      if (
        await requestSpaceDigest(base) !== row.baseDigest ||
        base.manifest.source.repositoryId !== destination.repositoryId
      ) corrupt();
    };
    const decode = async (id: string, row: Row) => {
      const d = await this.#parseScoped(id, row);
      owned(d);
      return d;
    };
    const payloadOf = async (value: ScopedSoftwareEvolutionDossierV2) => {
      const d = await parseScopedSoftwareDossier(value);
      owned(d);
      const payload = canonical(d);
      if (new TextEncoder().encode(payload).length > MAX_DOSSIER_BYTES) {
        throw new EvolutionError(
          "EVOLUTION_INVALID",
          "Evolution dossier exceeds its size bound",
        );
      }
      return { d, payload };
    };
    return {
      create: async (value: ScopedSoftwareEvolutionDossierV2) => {
        const { d, payload } = await payloadOf(value);
        if (canonical(d.scope) !== canonical(scope)) {
          throw new EvolutionError(
            "EVOLUTION_INVALID",
            "New dossier differs from resolved scope",
          );
        }
        if (d.status !== "prepared" || d.revision !== 0) {
          throw new EvolutionError(
            "EVOLUTION_INVALID",
            "New dossier must be prepared at revision zero",
          );
        }
        return await this.#exclusive(() =>
          postgresExecutionTransaction(this.client, async (tx) => {
            await this.#lockRepository(tx, d.repositoryId);
            if (await this.#row(tx, d.id)) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier already exists",
              );
            }
            await this.#assertRepositoryCapacity(tx, d.repositoryId);
            await opening(tx);
            await tx.evolutionDossier.create({
              data: {
                ...where,
                id: d.id,
                revision: postgresBigInt(d.revision),
                status: d.status,
                updatedAt: d.updatedAt,
                payload,
              },
            });
            return structuredClone(d);
          }, { isolationLevel: "ReadCommitted" })
        );
      },
      get: (id: string) =>
        this.#exclusive(() =>
          this.client.$transaction(async (tx) => {
            const row = await this.#row(tx, id);
            if (!row) return null;
            if (row.kind === "software-evolution-v1") {
              this.#parse(id, row);
              return null;
            }
            if (row.kind === "request-owner-adoption-v2") {
              await this.#parseRequest(id, row);
              return null;
            }
            const d = await this.#parseScoped(id, row);
            if (
              canonical(locator(d.scope)) !== canonical(locator(scope)) ||
              d.scope.openingBaseDigest !== scope.openingBaseDigest
            ) return null;
            await opening(tx);
            await this.#assertScopedHistory(tx, d);
            return d;
          }, { isolationLevel: "RepeatableRead" })
        ),
      listPending: (_repositoryId: string) =>
        this.#exclusive(() =>
          this.client.$transaction(async (tx) => {
            if (
              _repositoryId !== destination.repositoryId
            ) {
              throw new EvolutionError(
                "EVOLUTION_INVALID",
                "Foreign repository",
              );
            }
            const rows = await tx.evolutionDossier.findMany({
              where: { ...where, status: { in: pending } },
              orderBy: { id: "asc" },
            });
            const decoded = await Promise.all(
              rows.map((r) => this.#parseScoped(r.id, r)),
            );
            await opening(tx);
            const owned = decoded.filter((d) =>
              canonical(locator(d.scope)) === canonical(locator(scope)) &&
              d.scope.openingBaseDigest === scope.openingBaseDigest
            );
            for (const d of owned) await this.#assertScopedHistory(tx, d);
            return owned;
          }, { isolationLevel: "RepeatableRead" })
        ),
      compareAndSwap: async (
        id: string,
        expectedRevision: number,
        value: ScopedSoftwareEvolutionDossierV2,
      ) => {
        const { d, payload } = await payloadOf(value);
        if (
          d.id !== id || !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 0 || d.revision !== expectedRevision + 1
        ) {
          throw new EvolutionError(
            "EVOLUTION_INVALID",
            "Invalid software dossier CAS",
          );
        }
        return await this.#exclusive(() =>
          postgresExecutionTransaction(this.client, async (tx) => {
            await this.#lockRepository(tx, d.repositoryId);
            const row = await this.#row(tx, id);
            if (!row || row.revision !== postgresBigInt(expectedRevision)) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier revision changed",
              );
            }
            const previous = await decode(id, row);
            await assertScopedSoftwareTransition(previous, d);
            // A software receipt must be joined to its actual same-transaction
            // runtime history and source journal before any barrier is released.
            // Until that transaction bridge exists, fail closed here.
            if (
              d.status === "adopted" ||
              d.adoptions.length !== previous.adoptions.length
            ) {
              throw new EvolutionError(
                "EVOLUTION_INVALID",
                "Scoped runtime adoption transaction is unavailable",
              );
            }
            await opening(tx);
            const targets = [...d.scope.targets].sort((a, b) =>
              a.target.operatorId < b.target.operatorId
                ? -1
                : a.target.operatorId > b.target.operatorId
                ? 1
                : 0
            );
            for (const t of targets) {
              if (
                previous.adoptions.some((receipt) =>
                  receipt.operatorId === t.target.operatorId
                )
              ) continue;
              const selector = {
                ...this.#scope,
                repositoryId: d.repositoryId,
                targetScopeKey: where.targetScopeKey,
                operatorId: t.target.operatorId,
              };
              const owner = await tx.evolutionTargetBarrier.findUnique({
                where: {
                  projectId_systemId_repositoryId_targetScopeKey_operatorId:
                    selector,
                },
              });
              if (
                (hasEvolutionBarrier(previous.status) ||
                  hasEvolutionBarrier(d.status)) &&
                owner &&
                (owner.dossierId !== id ||
                  owner.executionSpaceId !== where.executionSpaceId)
              ) {
                throw new EvolutionError(
                  "EVOLUTION_TARGET_RESERVED",
                  "Request target already reserved",
                );
              }
              if (
                hasEvolutionBarrier(d.status) &&
                !d.adoptions.some((receipt) =>
                  receipt.operatorId === t.target.operatorId
                )
              ) {
                if (!owner) {
                  await tx.evolutionTargetBarrier.create({
                    data: {
                      ...selector,
                      executionSpaceId: where.executionSpaceId,
                      dossierId: id,
                    },
                  });
                }
              } else {
                await tx.evolutionTargetBarrier.deleteMany({
                  where: {
                    ...selector,
                    executionSpaceId: where.executionSpaceId,
                    dossierId: id,
                  },
                });
              }
            }
            const update = await tx.evolutionDossier.updateMany({
              where: {
                ...where,
                id,
                revision: postgresBigInt(expectedRevision),
              },
              data: {
                revision: postgresBigInt(d.revision),
                status: d.status,
                updatedAt: d.updatedAt,
                payload,
              },
            });
            if (update.count !== 1) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier revision changed",
              );
            }
            return structuredClone(d);
          }, { isolationLevel: "ReadCommitted" })
        );
      },
      targetOwner: (repositoryId: string, operatorId: string) =>
        this.#exclusive(() =>
          this.client.$transaction(async (tx) => {
            if (
              repositoryId !== destination.repositoryId ||
              !scope.targets.some((t) => t.target.operatorId === operatorId)
            ) {
              throw new EvolutionError(
                "EVOLUTION_INVALID",
                "Foreign software target",
              );
            }
            const b = await tx.evolutionTargetBarrier.findUnique({
              where: {
                projectId_systemId_repositoryId_targetScopeKey_operatorId: {
                  ...this.#scope,
                  repositoryId,
                  targetScopeKey: where.targetScopeKey,
                  operatorId,
                },
              },
            });
            if (!b) return null;
            if (b.executionSpaceId !== destination.executionSpaceId) corrupt();
            const row = await this.#row(tx, b.dossierId);
            if (!row) corrupt();
            if (row.kind === "request-owner-adoption-v2") {
              const d = await this.#parseRequest(b.dossierId, row);
              if (
                d.status !== "armed" ||
                d.intent.target.operatorId !== operatorId ||
                d.repositoryId !== repositoryId ||
                d.intent.target.executionSpaceId !==
                  destination.executionSpaceId
              ) corrupt();
            } else {
              const d = await this.#parseScoped(b.dossierId, row);
              if (
                !hasEvolutionBarrier(d.status) ||
                d.repositoryId !== repositoryId ||
                d.scope.destination.executionSpaceId !==
                  destination.executionSpaceId ||
                !d.scope.targets.some((t) => t.target.operatorId === operatorId)
              ) corrupt();
            }
            return b.dossierId;
          }, { isolationLevel: "RepeatableRead" })
        ),
    };
  }

  readonly #softwareSwaps = new WeakMap<object, {
    previous: ScopedSoftwareEvolutionDossierV2;
    next: ScopedSoftwareEvolutionDossierV2;
    manifest: ScopedSoftwareAdoptionManifestV2;
    receipt: ScopedSoftwareAdoptionReceiptV2;
    manifestPayload: string;
  }>();
  readonly #softwareLocks = new WeakMap<
    object,
    { tx: Prisma.TransactionClient; previous: string }
  >();

  /** Prepared facts are private to this adapter. The token is not authority. */
  async prepareScopedAdoptionSwap(
    oldValue: ScopedSoftwareEvolutionDossierV2,
    newValue: ScopedSoftwareEvolutionDossierV2,
    manifestInput: ScopedSoftwareAdoptionManifestV2,
    receiptInput: ScopedSoftwareAdoptionReceiptV2,
  ): Promise<object> {
    const previous = await parseScopedSoftwareDossier(oldValue);
    const next = await parseScopedSoftwareDossier(newValue);
    const manifest = structuredClone(manifestInput),
      receipt = structuredClone(receiptInput);
    await assertScopedSoftwareTransition(previous, next);
    assertScopedSoftwareAdoptionRevisionSequence(manifest);
    const previousPin = previous.scope.targets.find((t) =>
      canonical(t.target) === canonical(manifest.target)
    );
    const target = previous.proposal.targets.find((t) =>
      t.operatorId === manifest.target.operatorId
    );
    const payload = canonical(manifest);
    if (
      previous.status !== "published-awaiting-adoption" ||
      !previous.publication ||
      !previousPin || !target ||
      canonical(previousPin.previousPin) !==
        canonical(manifest.boundary.previousPin) ||
      manifest.dossierId !== previous.id ||
      manifest.intentDigest !== previous.intentDigest ||
      manifest.proposalDigest !== previous.proposal.digest ||
      canonical(manifest.adoptionAuthorization) !==
        canonical(previous.adoptionAuthorization) ||
      canonical(receipt.target) !== canonical(manifest.target) ||
      receipt.operatorId !== target.operatorId ||
      receipt.previousDigest !== target.previousDigest ||
      receipt.candidateDigest !== target.candidateDigest ||
      receipt.proposalDigest !== previous.proposal.digest ||
      receipt.version !== previous.publication.version ||
      receipt.authorizationRuntimeRevision !==
        manifest.authorizationRuntimeRevision ||
      receipt.committedRuntimeRevision !== manifest.committedRuntimeRevision ||
      receipt.manifestDigest !== await sha256(payload) ||
      next.adoptions.length !== previous.adoptions.length + 1 ||
      previous.adoptions.some((r) => r.operatorId === receipt.operatorId) ||
      !next.adoptions.some((r) => canonical(r) === canonical(receipt)) ||
      !["published-awaiting-adoption", "adopted"].includes(next.status)
    ) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Invalid scoped adoption packet",
      );
    }
    const packet = Object.freeze({});
    this.#softwareSwaps.set(packet, {
      previous,
      next,
      manifest,
      receipt,
      manifestPayload: payload,
    });
    return packet;
  }

  async lockScopedAdoptionInTransaction(
    tx: Prisma.TransactionClient,
    packet: object,
  ): Promise<object> {
    const data = this.#softwareSwaps.get(packet);
    if (!data) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign scoped adoption packet",
      );
    }
    return await this.lockScopedDossierInTransaction(tx, data.previous);
  }

  /** Lock the exact published dossier before the first state/native effect;
   * the final receipt packet can only be prepared after journal insertion. */
  async lockScopedDossierInTransaction(
    tx: Prisma.TransactionClient,
    input: ScopedSoftwareEvolutionDossierV2,
  ): Promise<object> {
    const previous = await parseScopedSoftwareDossier(input);
    await this.#lockRepository(tx, previous.repositoryId);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.client, "EvolutionDossier")
      }
      WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId} AND "id"=${previous.id} FOR UPDATE NOWAIT`,
    );
    const row = await this.#row(tx, previous.id);
    if (
      !row ||
      canonical(await this.#parseScoped(previous.id, row)) !==
        canonical(previous)
    ) {
      throw new EvolutionError(
        "EVOLUTION_CONFLICT",
        "Scoped dossier changed before adoption",
      );
    }
    const token = Object.freeze({});
    this.#softwareLocks.set(token, { tx, previous: canonical(previous) });
    return token;
  }

  /** Complete only after the manifest and guarded admission update succeeded in
   * this same transaction. A replay or foreign transaction cannot use a token. */
  async completeScopedAdoptionLocked(
    tx: Prisma.TransactionClient,
    packet: object,
    token: object,
  ): Promise<ScopedSoftwareEvolutionDossierV2> {
    const data = this.#softwareSwaps.get(packet),
      locked = this.#softwareLocks.get(token);
    if (
      !data || !locked || locked.tx !== tx ||
      locked.previous !== canonical(data.previous)
    ) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign scoped adoption transaction token",
      );
    }
    this.#softwareLocks.delete(token);
    const d = data.previous, target = data.manifest.target;
    const matches = await tx.$queryRaw<Array<{ revision: bigint }>>(
      Prisma.sql`SELECT "revision" FROM ${
        postgresQualifiedTable(this.client, "SpaceManifest")
      }
      WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId} AND "executionSpaceId"=${target.executionSpaceId}
      AND "kind"='runtime-adoption' AND "revision"=${
        postgresBigInt(data.receipt.journalRevision)
      }
      AND "digest"=${data.receipt.manifestDigest} AND "payload"=${data.manifestPayload} AND xmin=pg_current_xact_id()::xid`,
    );
    const destination = d.scope.destination;
    const updatedAdmissions = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.client, "SpaceExecutionAdmission")
      }
      WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId} AND "openingId"=${destination.openingId}
      AND "executionSpaceId"=${destination.executionSpaceId} AND "revision"=${data.manifest.admissionRevision}
      AND "status"='active' AND xmin=pg_current_xact_id()::xid`,
    );
    const admission = await tx.spaceExecutionAdmission.findFirst({
      where: {
        ...this.#scope,
        openingId: destination.openingId,
        executionSpaceId: destination.executionSpaceId,
        status: "active",
      },
    });
    const permissions = admission
      ? JSON.parse(admission.permissionsJson)
      : null;
    if (
      matches.length !== 1 || updatedAdmissions.length !== 1 || !admission ||
      admission.id !== updatedAdmissions[0].id ||
      admission.revision !== data.manifest.admissionRevision ||
      permissions?.sourceVersion !== data.receipt.version ||
      canonical(permissions?.modelDigests) !==
        canonical([data.receipt.candidateDigest])
    ) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Exact same-transaction adoption proof is missing",
      );
    }
    const selector = {
      ...this.#scope,
      repositoryId: d.repositoryId,
      targetScopeKey: `request:${target.executionSpaceId}`,
      operatorId: target.operatorId,
    };
    const barrier = await tx.evolutionTargetBarrier.findUnique({
      where: {
        projectId_systemId_repositoryId_targetScopeKey_operatorId: selector,
      },
    });
    if (
      !barrier || barrier.dossierId !== d.id ||
      barrier.executionSpaceId !== target.executionSpaceId
    ) {
      throw new EvolutionError(
        "EVOLUTION_BARRIER_LOST",
        "Scoped adoption barrier changed",
      );
    }
    // Other targets remain fenced until their own exact receipts commit.
    await tx.evolutionTargetBarrier.deleteMany({
      where: {
        ...selector,
        executionSpaceId: target.executionSpaceId,
        dossierId: d.id,
      },
    });
    const result = await tx.evolutionDossier.updateMany({
      where: {
        ...this.#scope,
        id: d.id,
        kind: "software-evolution-scoped-v2",
        revision: postgresBigInt(d.revision),
      },
      data: {
        revision: postgresBigInt(data.next.revision),
        status: data.next.status,
        updatedAt: data.next.updatedAt,
        payload: canonical(data.next),
      },
    });
    if (result.count !== 1) {
      throw new EvolutionError(
        "EVOLUTION_CONFLICT",
        "Scoped adoption dossier changed",
      );
    }
    return structuredClone(data.next);
  }

  #requestWhere(target: RequestAdoptionTarget) {
    const t = parseRequestAdoptionTarget(target);
    if (canonical(t.host) !== canonical(this.#scope)) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign Request adoption scope",
      );
    }
    return {
      ...this.#scope,
      repositoryId: t.repositoryId,
      kind: "request-owner-adoption-v2",
      targetScopeKey: requestAdoptionScopeKey(t),
      executionSpaceId: t.executionSpaceId,
    };
  }

  #sameRequest(
    target: RequestAdoptionTarget,
    dossier: RequestOwnerAdoptionDossier,
  ) {
    if (canonical(target) !== canonical(dossier.intent.target)) corrupt();
  }

  async #assertRequestTarget(
    tx: Prisma.TransactionClient | PrismaClient,
    target: RequestAdoptionTarget,
    dossier?: RequestOwnerAdoptionDossier,
  ): Promise<OpeningRecord> {
    this.#requestWhere(target);
    const opening = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.#scope,
          executionSpaceId: target.executionSpaceId,
        },
      },
    });
    const space = await tx.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.#scope,
          executionSpaceId: target.executionSpaceId,
        },
      },
    });
    if (
      !opening || !space || opening.id !== target.openingId ||
      opening.caseId !== target.caseId ||
      opening.branchId !== target.branchId || space.caseId !== target.caseId ||
      space.parentExecutionSpaceId !== "main" || !opening.baseJson
    ) corrupt();
    const base = JSON.parse(opening.baseJson);
    assertOpeningBase(base);
    if (
      base?.manifest?.source?.repositoryId !== target.repositoryId ||
      !opening.baseDigest ||
      await requestSpaceDigest(base) !== opening.baseDigest ||
      dossier &&
        (dossier.intent.openingBaseDigest !== opening.baseDigest ||
          requestAdoptionOwnerId(dossier.intent) !== opening.ownerId ||
          dossier.intent.previous.admission.id !== opening.admissionId ||
          dossier.intent.previous.admission.ownerId !== opening.ownerId)
    ) corrupt();
    if (base.requestOwner.operatorId !== target.operatorId) {
      const row = opening.admissionId
        ? await tx.spaceExecutionAdmission.findFirst({
          where: { ...this.#scope, id: opening.admissionId },
        })
        : null;
      const admission = row ? decodeSpaceExecutionAdmission(row) : null;
      const permissions = admission?.permissions;
      // SpaceAdmissions persists the one branchTeam producer's result. Bind
      // that evidence to this opening; a runtime registration is not membership.
      // Current model digests may advance beyond a historical dossier's pin.
      if (
        !admission || canonical(admission.scope) !== canonical(this.#scope) ||
        admission.openingId !== opening.id ||
        admission.executionSpaceId !== target.executionSpaceId ||
        admission.ownerId !== opening.ownerId ||
        admission.baseDigest !== opening.baseDigest ||
        !Array.isArray(permissions?.operatorIds) ||
        permissions.operatorIds[0] !== base.requestOwner.operatorId ||
        permissions.operatorIds.indexOf(target.operatorId) < 1 ||
        permissions.operatorIds.length > MAX_BRANCH_TEAM + 1 ||
        new Set(permissions.operatorIds).size !==
          permissions.operatorIds.length ||
        !Array.isArray(permissions.modelDigests) ||
        permissions.modelDigests.length !== permissions.operatorIds.length ||
        !permissions.modelDigests.every(isSha256Hex) ||
        canonical(permissions.acts) !== canonical(["conversation"])
      ) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISMATCH",
          "The Request adoption target is not a verified admitted team member",
          {
            context: {
              ...target.host,
              executionSpaceId: target.executionSpaceId,
              caseId: target.caseId,
              operatorId: target.operatorId,
            },
            recovery:
              "Select the Request owner or a verified member of this Request's admitted branch team.",
          },
        );
      }
    }
    return decodeRequestSpaceOpening(opening);
  }

  async #assertRequestReceipt(
    tx: Prisma.TransactionClient,
    opening: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
  ): Promise<void> {
    if (!dossier.receipt) return;
    const chain = await new PostgresRequestSourceAdmissionStore(this.client)
      .readAdmittedSource(tx, opening);
    const entry = chain.execution.adoptions.find((entry) =>
      entry.manifest.commandId === dossier.id
    );
    if (
      !entry || canonical(entry.receipt) !== canonical(dossier.receipt) ||
      canonical(entry.manifest.intent) !== canonical(dossier.intent) ||
      canonical(entry.manifest.completion) !== canonical(dossier.completion)
    ) corrupt();
    const history = await tx.runtimeRevision.findFirst({
      where: {
        ...this.#scope,
        executionSpaceId: opening.executionSpaceId,
        operatorId: dossier.intent.target.operatorId,
        revision: BigInt(dossier.receipt.committedRuntimeRevision),
      },
    });
    if (!history) corrupt();
    const state = decodePostgresRuntimeState(history);
    if (
      state.id !==
        `request:${opening.executionSpaceId}:${dossier.intent.target.operatorId}` ||
      canonical(state.executionModel) !==
        canonical(dossier.intent.candidate.model) ||
      state.events.filter((event) =>
          event.effectiveModelUpdate?.dossierId === dossier.id &&
          event.effectiveModelUpdate.caseId === opening.caseId &&
          event.effectiveModelUpdate.to.digest ===
            dossier.intent.candidate.model.version.digest
        ).length !== 1
    ) corrupt();
  }

  #notifyRequest(
    dossier: RequestOwnerAdoptionDossier,
  ): RequestOwnerAdoptionDossier {
    const key = canonical(dossier.intent.target);
    for (const listener of this.#requestListeners.get(key) ?? []) {
      try {
        listener();
      } catch { /* Post-commit notification cannot undo the receipt. */ }
    }
    return structuredClone(dossier);
  }

  /** Same adapter/client, explicit typed Request facade. It never defaults to Main. */
  readonly requestAdoptions: RequestOwnerAdoptionStorePort = {
    onChange: (target, listener) => {
      this.#requestWhere(target);
      const key = canonical(target),
        listeners = this.#requestListeners.get(key) ?? new Set<() => void>();
      listeners.add(listener);
      this.#requestListeners.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) this.#requestListeners.delete(key);
      };
    },
    get: (input, id) => {
      const target = parseRequestAdoptionTarget(input);
      this.#requestWhere(target);
      return this.#exclusive(() =>
        this.client.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
          const row = await this.#row(tx, id);
          if (!row) return null;
          if (row.kind === "software-evolution-v1") {
            this.#parse(id, row);
            return null;
          }
          if (row.kind === "software-evolution-scoped-v2") {
            await this.#parseScoped(id, row);
            return null;
          }
          const dossier = await this.#parseRequest(id, row);
          // Another Request's known ID is not an owned result.
          if (canonical(dossier.intent.target) !== canonical(target)) {
            return null;
          }
          const opening = await this.#assertRequestTarget(tx, target, dossier);
          await this.#assertRequestReceipt(tx, opening, dossier);
          return dossier;
        }, { isolationLevel: "RepeatableRead" })
      );
    },
    listPending: (input) => {
      const target = parseRequestAdoptionTarget(input),
        where = this.#requestWhere(target);
      return this.#exclusive(async () => {
        const rows = await this.client.evolutionDossier.findMany({
          where: { ...where, status: { in: pending } },
          orderBy: { id: "asc" },
        });
        return await Promise.all(rows.map(async (row) => {
          const d = await this.#parseRequest(row.id, row);
          this.#sameRequest(target, d);
          await this.#assertRequestTarget(this.client, target, d);
          return d;
        }));
      });
    },
    listRecent: (input, limit) => {
      const target = parseRequestAdoptionTarget(input),
        where = this.#requestWhere(target);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) {
        return Promise.reject(
          new EvolutionError(
            "EVOLUTION_INVALID",
            "Invalid dossier history bound",
          ),
        );
      }
      return this.#exclusive(async () => {
        const rows = await this.client.evolutionDossier.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          take: limit,
        });
        return await Promise.all(rows.map(async (row) => {
          const d = await this.#parseRequest(row.id, row);
          this.#sameRequest(target, d);
          await this.#assertRequestTarget(this.client, target, d);
          return d;
        }));
      });
    },
    create: async (input, value) => {
      const target = parseRequestAdoptionTarget(input),
        where = this.#requestWhere(target),
        next = await parseRequestOwnerAdoptionDossier(value);
      this.#sameRequest(target, next);
      const payload = canonical(next);
      if (
        new TextEncoder().encode(payload).length > MAX_DOSSIER_BYTES ||
        next.status !== "prepared" || next.revision !== 0
      ) {
        throw new EvolutionError(
          "EVOLUTION_INVALID",
          "New Request dossier must be bounded and prepared at revision zero",
        );
      }
      return await this.#exclusive(async () => {
        const result = await postgresExecutionTransaction(
          this.client,
          async (tx) => {
            await this.#lockRepository(tx, target.repositoryId);
            if (await this.#row(tx, next.id)) {
              throw new EvolutionError(
                "EVOLUTION_CONFLICT",
                "Dossier already exists",
              );
            }
            await this.#assertRepositoryCapacity(tx, target.repositoryId);
            await this.#assertRequestTarget(tx, target, next);
            await tx.evolutionDossier.create({
              data: {
                ...where,
                id: next.id,
                revision: postgresBigInt(next.revision),
                status: next.status,
                updatedAt: next.updatedAt,
                payload,
              },
            });
            return next;
          },
          { isolationLevel: "ReadCommitted" },
        );
        return this.#notifyRequest(result);
      });
    },
    compareAndSwap: async (input, id, expectedRevision, value) => {
      const target = parseRequestAdoptionTarget(input),
        packet = await this.prepareRequestSwap(
          target,
          id,
          expectedRevision,
          value,
        );
      return await this.#exclusive(async () => {
        const result = await postgresExecutionTransaction(
          this.client,
          async (tx) => {
            await this.#lockRepository(tx, target.repositoryId);
            const token = await this.lockRequestMutationInTransaction(
              tx,
              packet,
            );
            return await this.swapRequestPreparedLocked(tx, packet, token);
          },
          { isolationLevel: "ReadCommitted" },
        );
        return this.#notifyRequest(result);
      });
    },
    targetOwner: (input) => {
      const target = parseRequestAdoptionTarget(input);
      this.#requestWhere(target);
      return this.#exclusive(() =>
        this.client.$transaction(async (tx) => {
          const barrier = await tx.evolutionTargetBarrier.findUnique({
            where: {
              projectId_systemId_repositoryId_targetScopeKey_operatorId: {
                ...this.#scope,
                repositoryId: target.repositoryId,
                targetScopeKey: requestAdoptionScopeKey(target),
                operatorId: target.operatorId,
              },
            },
          });
          if (!barrier) return null;
          if (barrier.executionSpaceId !== target.executionSpaceId) corrupt();
          const row = await this.#row(tx, barrier.dossierId);
          if (!row) corrupt();
          if (row.kind === "software-evolution-scoped-v2") {
            const d = await this.#parseScoped(barrier.dossierId, row);
            if (
              !hasEvolutionBarrier(d.status) ||
              d.repositoryId !== target.repositoryId ||
              d.scope.destination.executionSpaceId !==
                target.executionSpaceId ||
              !d.scope.targets.some((t) =>
                t.target.operatorId === target.operatorId
              )
            ) corrupt();
            await this.#assertRequestTarget(tx, target);
            return d.id;
          }
          const d = await this.#parseRequest(barrier.dossierId, row);
          this.#sameRequest(target, d);
          await this.#assertRequestTarget(tx, target);
          if (d.status !== "armed") corrupt();
          return d.id;
        }, { isolationLevel: "RepeatableRead" })
      );
    },
  };

  readonly #requestPackets = new WeakMap<
    object,
    {
      target: RequestAdoptionTarget;
      id: string;
      expectedRevision: number;
      next: RequestOwnerAdoptionDossier;
      payload: string;
    }
  >();
  readonly #requestLocks = new WeakMap<
    object,
    { tx: Prisma.TransactionClient; packet: object }
  >();

  /** Validation and serialization happen before the final transaction. Tokens are
   * adapter-owned facts, not authority and not portable between stores/transactions. */
  async prepareRequestSwap(
    targetInput: RequestAdoptionTarget,
    id: string,
    expectedRevision: number,
    input: RequestOwnerAdoptionDossier,
  ) {
    const target = parseRequestAdoptionTarget(targetInput);
    this.#requestWhere(target);
    const next = await parseRequestOwnerAdoptionDossier(input);
    this.#sameRequest(target, next);
    if (
      next.id !== id || !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 || next.revision !== expectedRevision + 1
    ) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Invalid Request dossier CAS",
      );
    }
    const payload = canonical(next);
    if (new TextEncoder().encode(payload).length > MAX_DOSSIER_BYTES) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Evolution dossier exceeds its size bound",
      );
    }
    const packet = Object.freeze({});
    this.#requestPackets.set(packet, {
      target: structuredClone(target),
      id,
      expectedRevision,
      next: structuredClone(next),
      payload,
    });
    return packet;
  }

  async lockRequestMutationInTransaction(
    tx: Prisma.TransactionClient,
    packet: Awaited<ReturnType<PostgresEvolutionStore["prepareRequestSwap"]>>,
  ) {
    const data = this.#requestPackets.get(packet);
    if (!data) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign Request dossier packet",
      );
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.client, "EvolutionDossier")
      } WHERE "projectId"=${this.#scope.projectId} AND "systemId"=${this.#scope.systemId} AND "id"=${data.id} FOR UPDATE NOWAIT`,
    );
    const row = await this.#row(tx, data.id);
    if (!row || row.revision !== postgresBigInt(data.expectedRevision)) {
      throw new EvolutionError(
        "EVOLUTION_CONFLICT",
        "Request dossier revision changed",
      );
    }
    const previous = await this.#parseRequest(data.id, row);
    this.#sameRequest(data.target, previous);
    await assertRequestOwnerAdoptionTransition(previous, data.next);
    await this.#assertRequestTarget(tx, data.target, previous);
    const token = Object.freeze({});
    this.#requestLocks.set(token, { tx, packet });
    return token;
  }

  async swapRequestPreparedLocked(
    tx: Prisma.TransactionClient,
    packet: Awaited<ReturnType<PostgresEvolutionStore["prepareRequestSwap"]>>,
    token: object,
  ): Promise<RequestOwnerAdoptionDossier> {
    const data = this.#requestPackets.get(packet),
      locked = this.#requestLocks.get(token);
    if (!data || !locked || locked.tx !== tx || locked.packet !== packet) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Foreign Request dossier transaction token",
      );
    }
    this.#requestLocks.delete(token);
    const target = data.target,
      selector = {
        ...this.#scope,
        repositoryId: target.repositoryId,
        targetScopeKey: requestAdoptionScopeKey(target),
        operatorId: target.operatorId,
      };
    const owner = await tx.evolutionTargetBarrier.findUnique({
      where: {
        projectId_systemId_repositoryId_targetScopeKey_operatorId: selector,
      },
    });
    if (
      owner &&
      (owner.dossierId !== data.id ||
        owner.executionSpaceId !== target.executionSpaceId)
    ) {
      throw new EvolutionError(
        "EVOLUTION_TARGET_RESERVED",
        "Request already has a pending adoption",
      );
    }
    if (data.next.status === "armed") {
      if (!owner) {
        await tx.evolutionTargetBarrier.create({
          data: {
            ...selector,
            executionSpaceId: target.executionSpaceId,
            dossierId: data.id,
          },
        });
      }
    } else {
      if (data.next.status === "adopted" && !owner) corrupt();
      await tx.evolutionTargetBarrier.deleteMany({
        where: {
          ...selector,
          executionSpaceId: target.executionSpaceId,
          dossierId: data.id,
        },
      });
    }
    const update = await tx.evolutionDossier.updateMany({
      where: {
        ...this.#requestWhere(target),
        id: data.id,
        revision: postgresBigInt(data.expectedRevision),
      },
      data: {
        revision: postgresBigInt(data.next.revision),
        status: data.next.status,
        updatedAt: data.next.updatedAt,
        payload: data.payload,
      },
    });
    if (update.count !== 1) {
      throw new EvolutionError(
        "EVOLUTION_CONFLICT",
        "Request dossier revision changed",
      );
    }
    return structuredClone(data.next);
  }

  /** Caller invokes only after its transaction COMMIT. */
  notifyRequestCommitted(dossier: RequestOwnerAdoptionDossier): void {
    this.#notifyRequest(dossier);
  }

  /** Close this handle only; the host closes the shared client after draining. */
  close(): Promise<void> {
    const work = this.#tail.then(() => {
      this.#closed = true;
      this.#listeners.clear();
      this.#requestListeners.clear();
    });
    this.#tail = work;
    return work;
  }
}

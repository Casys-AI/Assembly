import { PostgresSpaceCredentials } from "./request-space-control-store.ts";
import type { ModelTagMutationPort } from "../../../application/work/saved-systems/ports.ts";
import {
  TAG_MUTATION_MIN_VALIDITY_MS,
  TAG_MUTATION_TRANSACTION,
  tagMutationBudget,
} from "./tag-mutation-budget.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import {
  decodePostgresOpening,
  type PostgresOpeningRow,
} from "./request-space-store.ts";
import {
  PostgresRequestSourceAdmissionStore,
  requestReleaseSourceEvidence,
} from "./request-source-admission-store.ts";
import { assertOpeningBase } from "../../../domain/work/request-spaces/opening.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";
import { SavedSystemError } from "../../../domain/work/records/saved-systems.ts";
import {
  assertReleaseRetentionIntent,
  type ReleaseRetentionAuthorization,
  releaseRetentionIntentDigest,
  type ReleaseRetentionProof,
} from "../../../domain/work/records/release-retention.ts";

export type ReleaseCreationPhase = "accepted" | "fresh";
/** Atomic current-control fence for an exact accepted intention, no execution grant. */
export class PostgresReleaseCreationGuard implements ModelTagMutationPort {
  private readonly credentials: PostgresSpaceCredentials;
  private readonly sourceAdmissions: PostgresRequestSourceAdmissionStore;
  constructor(
    private readonly client: PrismaClient,
    private readonly primary: PostgresPrimarySpaceControlSource,
  ) {
    primary.assertClient(client);
    this.credentials = new PostgresSpaceCredentials(client, primary);
    this.sourceAdmissions = new PostgresRequestSourceAdmissionStore(client);
  }
  /** No release row is inserted: Git's exact create-only ref is the identity.
   * The service already holds the shared repository writer lock. */
  async run(
    authorization: ReleaseRetentionAuthorization,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const native = tagMutationBudget();
    await this.client.$transaction(async (tx) => {
      await this.assertLocked(tx, authorization, "fresh");
      await this.assertNativeLocked(tx, authorization);
      await native(operation);
    }, TAG_MUTATION_TRANSACTION);
  }
  /** Refresh time validity after source/Opening/scope waits, under the same
   * already-held lock order, and reserve the shared native+completion window. */
  async assertNativeLocked(
    tx: Prisma.TransactionClient,
    authorization: ReleaseRetentionAuthorization,
  ): Promise<void> {
    await this.credentials.assertRetainReleaseForNative(
      tx,
      authorization.controller,
      TAG_MUTATION_MIN_VALIDITY_MS,
    ).catch((error) => {
      if (error instanceof RequestSpaceError) {
        throw new SavedSystemError(
          "FORBIDDEN",
          "Current tag authority does not cover the bounded native operation.",
        );
      }
      throw error;
    });
  }
  async assertLocked(
    tx: Prisma.TransactionClient,
    authorization: ReleaseRetentionAuthorization,
    phase: ReleaseCreationPhase = "accepted",
  ): Promise<ReleaseRetentionProof> {
    const { intent, controller } = authorization;
    assertReleaseRetentionIntent(intent);
    const host = this.primary.binding.scope;
    const deny = () =>
      new SavedSystemError(
        "FORBIDDEN",
        "Current exact Release retention authority is unavailable.",
      );
    if (
      intent.scope.projectId !== host.projectId ||
      intent.scope.systemId !== host.systemId ||
      (intent.source.branch.kind === "main" &&
        intent.source.requestAdmission !== undefined)
    ) throw deny();
    const current = await this.credentials.assertRetainRelease(tx, controller)
      .catch((error) => {
        if (error instanceof RequestSpaceError) throw deny();
        throw error;
      });
    if (intent.source.branch.kind === "case") {
      const rows = await tx.$queryRaw<PostgresOpeningRow[]>(
        Prisma
          .sql`SELECT * FROM ${
          postgresQualifiedTable(this.client, "SpaceOpening")
        } WHERE "projectId"=${host.projectId} AND "systemId"=${host.systemId} AND "executionSpaceId"=${intent.scope.executionSpaceId} AND "caseId"=${intent.source.branch.caseId} FOR SHARE`,
      );
      const row = rows[0];
      if (
        !row || row.ownerId !== controller.ownerId || !row.baseJson ||
        !row.baseDigest ||
        !["runtime-ready", "admitted", "dispatched"].includes(row.phase)
      ) throw deny();
      const opening = decodePostgresOpening(row);
      const base = opening.base!;
      assertOpeningBase(base);
      const retainedSource = base.manifest.source;
      if (
        await requestSpaceDigest(base) !== row.baseDigest ||
        await requestSpaceDigest(base.manifest) !== base.manifestDigest ||
        base.manifest.origin.projectId !== host.projectId ||
        base.manifest.origin.systemId !== host.systemId ||
        !retainedSource ||
        retainedSource.repositoryId !== intent.source.repositoryId ||
        intent.source.branchRef !== `refs/heads/requests/${opening.branchId}`
      ) throw deny();
      try {
        const reference = intent.source.requestAdmission;
        const chain = reference !== undefined || phase === "fresh"
          ? await this.sourceAdmissions.readAdmittedSource(tx, opening)
          : undefined;
        if (reference !== undefined) {
          const verified = requestReleaseSourceEvidence(
            opening,
            chain!,
            reference,
          );
          if (
            verified.source.repositoryId !== intent.source.repositoryId ||
            verified.source.version !== intent.source.sourceVersion ||
            verified.sourceDigest !== intent.source.sourceDigest ||
            intent.source.admittedHeadVersion !== intent.source.sourceVersion
          ) throw deny();
        } else if (
          retainedSource.sourceVersion !== intent.source.sourceVersion ||
          retainedSource.sourceDigest !== intent.source.sourceDigest
        ) throw deny();
        // Existing same-key work keeps its immutable historical receipt. Only
        // the first acceptance must still match the admitted head under this
        // Opening SHARE lock, which excludes source append's UPDATE fence.
        if (
          phase === "fresh" && (
            chain!.head.source.repositoryId !== intent.source.repositoryId ||
            chain!.head.source.version !== intent.source.sourceVersion ||
            chain!.head.sourceDigest !== intent.source.sourceDigest ||
            (reference !== undefined
              ? reference.revision !== chain!.head.revision ||
                reference.manifestDigest !== chain!.head.manifestDigest
              : chain!.head.revision !== 1)
          )
        ) {
          throw new SavedSystemError(
            "SOURCE_STALE",
            "The admitted Request source changed before Release acceptance.",
          );
        }
      } catch (error) {
        if (error instanceof RequestSpaceError) throw deny();
        throw error;
      }
    }
    return {
      act: "retain-release",
      intentDigest: await releaseRetentionIntentDigest(intent),
      ownerId: controller.ownerId,
      capabilityId: controller.capabilityId,
      capabilityRevision: controller.capabilityRevision,
      sessionId: controller.sessionId,
      sessionRevision: current.sessionRevision,
      authority: current.authority,
      adoptedState: current.adoptedState,
      authorizedAt: current.authorizedAt,
    };
  }
}

import type { ClockPort } from "../../../application/work/runtime/ports.ts";
import { SystemClock } from "../../../infrastructure/clock.ts";
import {
  assertReleasePublication,
  publicationEvent,
  type ReleasePublication,
  type ReleasePublicationIssue,
} from "../../../domain/work/records/release-publication.ts";
import { afterCommittedReleaseMutation } from "../../../application/work/saved-systems/notifications.ts";
import {
  TAG_MUTATION_TRANSACTION,
  tagMutationBudget,
} from "./tag-mutation-budget.ts";
import type {
  PostgresReleaseCreationGuard,
  ReleaseCreationPhase,
} from "./release-creation-guard.ts";
import {
  type ReleaseRetentionAuthorization,
  type ReleaseRetentionIntent,
  releaseRetentionIntentDigest,
  type ReleaseRetentionProof,
} from "../../../domain/work/records/release-retention.ts";
import type { SavedSystemStorePort } from "../../../application/work/saved-systems/ports.ts";
import {
  assertReleaseTagRejection,
  assertReleaseTagSelection,
  assertSavedSystemTag,
  type ReleaseTagRejection,
} from "../../../domain/work/records/release-tags.ts";
import {
  assertSavedCapture,
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
  savedSystemObservation,
  type SavedSystemRecord,
  type SavedSystemScope,
} from "../../../domain/work/records/saved-systems.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";

type Tx = Prisma.TransactionClient;
type SavedSystemIntentionInput = Pick<
  Parameters<SavedSystemStorePort["begin"]>[0],
  "scope" | "saveKey" | "commandDigest" | "metadata" | "capture"
>;
export type SavedSystemRow = {
  id: string;
  saveKey: string;
  commandDigest: string;
  creationAuthorization?: string | null;
  tagSelection?: string | null;
  tagBinding?: string | null;
  tagRepositoryId?: string | null;
  tagName?: string | null;
  tagVerified?: boolean;
  tagRejection?: string | null;
  metadata: string;
  capture: string;
  createdAt: Date;
  status: SavedSystemRecord["status"];
  manifest: string | null;
  digest: string | null;
  issues: string;
  revision: number;
  publication?: string | null;
};
export function decodeSavedSystemRow(row: SavedSystemRow): SavedSystemRecord {
  const {
    tagSelection,
    tagBinding,
    tagRepositoryId: _tagRepositoryId,
    tagName: _tagName,
    tagVerified,
    tagRejection,
    publication,
    ...legacy
  } = row;
  let rejection: ReleaseTagRejection | undefined;
  if (tagRejection !== undefined && tagRejection !== null) {
    const parsed: unknown = JSON.parse(tagRejection);
    assertReleaseTagRejection(parsed);
    rejection = parsed;
    if (
      [tagSelection, tagBinding, _tagRepositoryId, _tagName].some((value) =>
        value !== null && value !== undefined
      ) || tagVerified ||
      row.status !== "conflict" || row.manifest !== null || row.digest !== null
    ) throw error();
  }
  let progress: ReleasePublication | undefined;
  if (publication != null) {
    const parsed: unknown = JSON.parse(publication);
    assertReleasePublication(parsed);
    progress = parsed;
  }
  return {
    ...legacy,
    ...(progress ? { publication: progress } : {}),
    ...(rejection !== undefined ? { rejection } : {}),
    ...(tagSelection && tagBinding
      ? {
        tag: {
          selection: JSON.parse(tagSelection),
          binding: JSON.parse(tagBinding),
          verified: tagVerified === true,
        },
      }
      : {}),
    creationAuthorization: row.creationAuthorization
      ? JSON.parse(row.creationAuthorization)
      : null,
    metadata: JSON.parse(row.metadata),
    capture: JSON.parse(row.capture),
    createdAt: row.createdAt.toISOString(),
    manifest: row.manifest === null ? null : JSON.parse(row.manifest),
    issues: JSON.parse(row.issues),
  };
}
function error(): SavedSystemError {
  return new SavedSystemError(
    "CAPTURE_CONFLICT",
    "The saved system selection changed.",
  );
}
function tagError(): SavedSystemError {
  return new SavedSystemError(
    "TAG_UNAVAILABLE",
    "The exact Release tag is unavailable or already reserved.",
  );
}

export class PostgresSavedSystemStore implements SavedSystemStorePort {
  constructor(
    private readonly client: PrismaClient,
    private readonly creationGuard?: Pick<
      PostgresReleaseCreationGuard,
      "assertLocked" | "assertNativeLocked"
    >,
    private readonly now: () => number = () => performance.now(),
    private readonly notifyCatalogue: () => void = () => {},
    private readonly clock: ClockPort = new SystemClock(),
  ) {}
  private catalogueTransaction(
    operation: (tx: Tx, mutated: () => void) => Promise<SavedSystemRecord>,
    options?: typeof TAG_MUTATION_TRANSACTION,
  ): Promise<SavedSystemRecord> {
    let changed = false;
    const commit = this.client.$transaction(
      (tx) =>
        operation(tx, () => {
          changed = true;
        }),
      options,
    ).then((value) => ({ value, changed }));
    return afterCommittedReleaseMutation(commit, this.notifyCatalogue);
  }
  private async authorize(
    tx: Tx,
    authorization: ReleaseRetentionAuthorization | undefined,
    intent: ReleaseRetentionIntent,
    phase: ReleaseCreationPhase = "accepted",
  ): Promise<ReleaseRetentionProof | null> {
    if (!this.creationGuard) return null; // Generic mechanics only; production injects a guard.
    if (
      !authorization ||
      await releaseRetentionIntentDigest(authorization.intent) !==
        await releaseRetentionIntentDigest(intent)
    ) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "The exact Release command requires current creation authority.",
      );
    }
    return await this.creationGuard.assertLocked(tx, authorization, phase);
  }
  private intent(
    scope: SavedSystemScope,
    row: Pick<SavedSystemRecord, "saveKey" | "commandDigest" | "capture">,
  ): ReleaseRetentionIntent {
    if (!row.capture.source) throw error();
    return {
      scope,
      saveKey: row.saveKey,
      commandDigest: row.commandDigest,
      source: row.capture.source,
    };
  }
  private table() {
    return postgresQualifiedTable(this.client, "SavedSystem");
  }
  private async lockScope(tx: Tx, scope: SavedSystemScope) {
    const row = await tx.executionSpace.updateMany({
      where: scope,
      data: { executionSpaceId: scope.executionSpaceId },
    });
    if (row.count !== 1) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The execution space is unavailable.",
      );
    }
  }
  private async getRow(
    tx: Tx | PrismaClient,
    scope: SavedSystemScope,
    id: string,
  ): Promise<SavedSystemRow | null> {
    const rows = await tx.$queryRaw<SavedSystemRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "executionSpaceId"=${scope.executionSpaceId} AND "id"=${id}`,
    );
    return rows[0] ?? null;
  }
  private async insertRejection(
    tx: Tx,
    input: SavedSystemIntentionInput,
    rejection: ReleaseTagRejection,
    proof: ReleaseRetentionProof | null,
  ): Promise<SavedSystemRecord> {
    const rows = await tx.$queryRaw<SavedSystemRow[]>(
      Prisma
        .sql`INSERT INTO ${this.table()} ("id", "projectId", "systemId", "executionSpaceId", "saveKey", "commandDigest", "metadata", "capture", "status", "issues", "creationAuthorization", "tagRejection", "publication") VALUES (${crypto.randomUUID()}, ${input.scope.projectId}, ${input.scope.systemId}, ${input.scope.executionSpaceId}, ${input.saveKey}, ${input.commandDigest}, ${
        JSON.stringify(input.metadata)
      }, ${JSON.stringify(input.capture)}, 'conflict', '[]', ${
        proof ? JSON.stringify(proof) : null
      }, ${JSON.stringify(rejection)}, ${
        JSON.stringify(publicationEvent(
          undefined,
          {
            step: "acceptance",
            status: "refused",
            issue: rejection.code,
          },
          "refused",
          this.clock.now(),
        ))
      }) RETURNING *`,
    );
    return decodeSavedSystemRow(rows[0]);
  }
  async begin(
    input: Parameters<SavedSystemStorePort["begin"]>[0],
  ): Promise<SavedSystemRecord> {
    return await this.catalogueTransaction(async (tx, mutated) => {
      const intent = this.creationGuard
        ? this.intent(input.scope, input)
        : undefined;
      if (
        intent && await savedSystemDigest({
            scope: input.scope,
            saveKey: input.saveKey,
            metadata: input.metadata,
            source: {
              branch: intent.source.branch,
              sourceVersion: intent.source.sourceVersion,
            },
            ...(input.tag ? { tag: input.tag.selection } : {}),
          }) !== input.commandDigest
      ) throw error();
      const historicalProof = intent
        ? await this.authorize(tx, input.authorization, intent)
        : null;
      await this.lockScope(tx, input.scope);
      const existing = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${input.scope.projectId} AND "systemId"=${input.scope.systemId} AND "executionSpaceId"=${input.scope.executionSpaceId} AND "saveKey"=${input.saveKey}`,
      );
      if (existing[0]) {
        if (existing[0].commandDigest !== input.commandDigest) {
          throw new SavedSystemError(
            "SAVE_KEY_CONFLICT",
            "The save key belongs to a different command.",
          );
        }
        const stored = decodeSavedSystemRow(existing[0]);
        if (stored.rejection) {
          if (
            await savedSystemDigest(stored.rejection.tag) !==
              await savedSystemDigest(input.tag?.selection ?? null)
          ) throw tagError();
          if (this.creationGuard) {
            await this.authorize(
              tx,
              input.authorization,
              this.intent(input.scope, stored),
            );
          }
          return stored;
        }
        if (
          await savedSystemDigest(
            stored.tag
              ? {
                selection: stored.tag.selection,
                binding: stored.tag.binding,
              }
              : null,
          ) !== await savedSystemDigest(
            input.tag
              ? {
                selection: input.tag.selection,
                binding: input.tag.binding,
              }
              : null,
          )
        ) throw tagError();
        if (this.creationGuard) {
          await this.authorize(
            tx,
            input.authorization,
            this.intent(input.scope, stored),
          );
        }
        if (
          (stored.status === "pending" || stored.status === "incomplete") &&
          stored.capture.source && stored.capture.prerequisites.some((entry) =>
            entry.kind === "missing-asset"
          )
        ) {
          const capture = structuredClone(input.capture);
          if (
            await savedSystemDigest(capture.origin) !==
              await savedSystemDigest(input.scope)
          ) {
            throw error();
          }
          const { admittedHeadVersion: _oldHead, ...accepted } =
            stored.capture.source;
          const { admittedHeadVersion: _newHead, ...resolved } =
            capture.source ?? {};
          if (
            await savedSystemDigest(accepted) !==
              await savedSystemDigest(resolved)
          ) {
            throw error();
          }
          // Repair source-derived missing closure without moving the accepted
          // version or admission evidence. CAS invalidates concurrent old work.
          capture.source = structuredClone(stored.capture.source);
          assertSavedCapture(capture);
          if (
            await savedSystemDigest(capture) !==
              await savedSystemDigest(stored.capture)
          ) {
            const proof = intent
              ? await this.authorize(tx, input.authorization, intent)
              : null;
            const rows = await tx.$queryRaw<SavedSystemRow[]>(
              Prisma.sql`UPDATE ${this.table()} SET "capture"=${
                JSON.stringify(capture)
              }, "creationAuthorization"=COALESCE("creationAuthorization",${
                proof ? JSON.stringify(proof) : null
              }), "status"='pending', "manifest"=NULL, "digest"=NULL, "issues"='[]', "revision"="revision"+1 WHERE "id"=${stored.id} AND "revision"=${stored.revision} RETURNING *`,
            );
            if (!rows[0]) {
              throw error();
            }
            mutated();
            return decodeSavedSystemRow(rows[0]);
          }
        }
        if (intent) {
          const proof = await this.authorize(tx, input.authorization, intent);
          if (
            !stored.creationAuthorization &&
            ["pending", "incomplete"].includes(stored.status)
          ) {
            const rows = await tx.$queryRaw<SavedSystemRow[]>(
              Prisma.sql`UPDATE ${this.table()} SET "creationAuthorization"=${
                JSON.stringify(proof)
              }, "revision"="revision"+1 WHERE "id"=${stored.id} AND "revision"=${stored.revision} RETURNING *`,
            );
            if (!rows[0]) {
              throw error();
            }
            mutated();
            return decodeSavedSystemRow(rows[0]);
          }
        }
        return stored;
      }
      if (this.creationGuard && !input.tag) {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "Select a tag for this Release.",
        );
      }
      const capture = structuredClone(input.capture);
      if (
        !capture.source || !capture.admission ||
        await savedSystemDigest(capture.origin) !==
          await savedSystemDigest(input.scope)
      ) throw error();
      assertSavedCapture(capture);
      const tag = input.tag ? structuredClone(input.tag) : undefined;
      if (tag) {
        assertSavedSystemTag(tag, capture.source.sourceVersion);
        if (tag.verified) throw tagError();
      }
      let proof: ReleaseRetentionProof | null = null;
      if (intent) {
        try {
          proof = await this.authorize(
            tx,
            input.authorization,
            intent,
            "fresh",
          );
        } catch (error) {
          if (
            !(error instanceof SavedSystemError &&
              error.code === "SOURCE_STALE") || !tag
          ) {
            throw error;
          }
          // Current authority and immutable historical source evidence remain
          // locked. Close this exact command in the same transaction, without
          // reserving its tag or admitting the historical source for publication.
          mutated();
          return await this.insertRejection(tx, { ...input, capture }, {
            code: "SOURCE_STALE",
            tag: tag.selection,
          }, historicalProof);
        }
      }
      const id = crypto.randomUUID();
      const rows = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`INSERT INTO ${this.table()} ("id", "projectId", "systemId", "executionSpaceId", "saveKey", "commandDigest", "metadata", "capture", "status", "issues", "creationAuthorization", "tagSelection", "tagBinding", "tagRepositoryId", "tagName", "tagVerified", "publication") VALUES (${id}, ${input.scope.projectId}, ${input.scope.systemId}, ${input.scope.executionSpaceId}, ${input.saveKey}, ${input.commandDigest}, ${
          JSON.stringify(input.metadata)
        }, ${JSON.stringify(capture)}, 'pending', '[]', ${
          proof ? JSON.stringify(proof) : null
        }, ${tag ? JSON.stringify(tag.selection) : null}, ${
          tag ? JSON.stringify(tag.binding) : null
        }, ${tag ? capture.source.repositoryId : null}, ${
          tag?.selection.name ?? null
        }, false, ${
          JSON.stringify(publicationEvent(
            undefined,
            {
              step: "acceptance",
              status: "completed",
            },
            "pending",
            this.clock.now(),
          ))
        }) ON CONFLICT ("projectId", "systemId", "tagRepositoryId", "tagName") DO NOTHING RETURNING *`,
      );
      if (!rows[0]) throw tagError();
      mutated();
      return decodeSavedSystemRow(rows[0]);
    });
  }
  async rejectTag(
    input: Parameters<NonNullable<SavedSystemStorePort["rejectTag"]>>[0],
  ): Promise<SavedSystemRecord> {
    assertReleaseTagSelection(input.tag);
    const rejection = {
      code: input.reason ?? "TAG_UNAVAILABLE",
      tag: input.tag,
    };
    assertReleaseTagRejection(rejection);
    const capture = structuredClone(input.capture);
    if (
      !capture.source || !capture.admission ||
      await savedSystemDigest(capture.origin) !==
        await savedSystemDigest(input.scope)
    ) throw error();
    assertSavedCapture(capture);
    if (
      await savedSystemDigest({
        scope: input.scope,
        saveKey: input.saveKey,
        metadata: input.metadata,
        source: {
          branch: capture.source.branch,
          sourceVersion: capture.source.sourceVersion,
        },
        tag: input.tag,
      }) !== input.commandDigest
    ) throw error();
    return await this.catalogueTransaction(async (tx, mutated) => {
      const intent = this.creationGuard
        ? this.intent(input.scope, input)
        : undefined;
      if (intent) await this.authorize(tx, input.authorization, intent);
      await this.lockScope(tx, input.scope);
      const existing = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${input.scope.projectId} AND "systemId"=${input.scope.systemId} AND "executionSpaceId"=${input.scope.executionSpaceId} AND "saveKey"=${input.saveKey}`,
      );
      if (existing[0]) {
        if (existing[0].commandDigest !== input.commandDigest) {
          throw new SavedSystemError(
            "SAVE_KEY_CONFLICT",
            "The save key belongs to a different command.",
          );
        }
        const stored = decodeSavedSystemRow(existing[0]);
        if (this.creationGuard) {
          await this.authorize(
            tx,
            input.authorization,
            this.intent(input.scope, stored),
          );
        }
        return stored;
      }
      const proof = intent
        ? await this.authorize(tx, input.authorization, intent)
        : null;
      mutated();
      return await this.insertRejection(
        tx,
        { ...input, capture },
        rejection,
        proof,
      );
    });
  }
  async confirmTag(
    input: Parameters<NonNullable<SavedSystemStorePort["confirmTag"]>>[0],
  ): Promise<SavedSystemRecord> {
    // The caller already holds the repository writer lock. Acquire authority
    // and scope SQL locks only inside that order, then perform bounded Git CAS.
    // Count acquisition/guards against the same conservative absolute budget.
    const native = tagMutationBudget(this.now);
    return await this.catalogueTransaction(async (tx, mutated) => {
      const accepted = await this.getRow(tx, input.scope, input.id);
      if (!accepted) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The saved system is unavailable.",
        );
      }
      if (this.creationGuard) {
        await this.authorize(
          tx,
          input.authorization,
          this.intent(input.scope, decodeSavedSystemRow(accepted)),
        );
      }
      await this.lockScope(tx, input.scope);
      const row = await this.getRow(tx, input.scope, input.id);
      if (!row) throw error();
      const stored = decodeSavedSystemRow(row);
      if (
        row.revision !== input.expectedRevision ||
        input.preparationId !== undefined &&
          stored.publication?.runId !== input.preparationId ||
        !["pending", "incomplete"].includes(row.status)
      ) return stored;
      if (!stored.tag || !stored.capture.source) throw tagError();
      assertSavedSystemTag(stored.tag, stored.capture.source.sourceVersion);
      if (this.creationGuard) {
        if (!input.authorization) {
          throw new SavedSystemError(
            "FORBIDDEN",
            "Current tag authority is unavailable.",
          );
        }
        await this.creationGuard.assertNativeLocked(tx, input.authorization);
      }
      await native(input.ensure);
      if (stored.tag.verified) return stored;
      const rows = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`UPDATE ${this.table()} SET "tagVerified"=true, "revision"="revision"+1 WHERE "id"=${input.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw error();
      mutated();
      return decodeSavedSystemRow(rows[0]);
    }, TAG_MUTATION_TRANSACTION);
  }
  async availableTags(
    scope: SavedSystemScope,
    repositoryId: string,
    names: string[],
  ): Promise<string[]> {
    if (!names.length) return [];
    const rows = await this.client.$queryRaw<Array<{ tagName: string }>>(
      Prisma
        .sql`SELECT "tagName" FROM ${this.table()} WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "tagRepositoryId"=${repositoryId} AND "tagName" IN (${
        Prisma.join(names)
      })`,
    );
    const reserved = new Set(rows.map((row) => row.tagName));
    return names.filter((name) => !reserved.has(name));
  }
  async finalize(
    input: Parameters<SavedSystemStorePort["finalize"]>[0],
  ): Promise<SavedSystemRecord> {
    return await this.catalogueTransaction(async (tx, mutated) => {
      const accepted = await this.getRow(tx, input.scope, input.id);
      if (!accepted) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The saved system is unavailable.",
        );
      }
      const intent = this.creationGuard
        ? this.intent(input.scope, decodeSavedSystemRow(accepted))
        : undefined;
      if (intent) await this.authorize(tx, input.authorization, intent);
      await this.lockScope(tx, input.scope);
      const row = await this.getRow(tx, input.scope, input.id);
      if (!row) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The saved system is unavailable.",
        );
      }
      if (
        row.revision !== input.expectedRevision ||
        input.preparationId !== undefined &&
          decodeSavedSystemRow(row).publication?.runId !==
            input.preparationId ||
        row.status === "retained" ||
        row.status === "conflict"
      ) return decodeSavedSystemRow(row);
      if (row.tagSelection && !row.tagVerified) throw tagError();
      const stored: SavedSystemCapture = JSON.parse(row.capture);
      if (
        !stored.admission || !input.capture.admission ||
        await savedSystemDigest(stored.admission) !==
          await savedSystemDigest(input.capture.admission)
      ) throw error();
      const expectedIds = [...stored.admission.operatorIds].sort();
      const manifestIds = input.manifest.operators.map((operator) =>
        operator.operatorId
      ).sort();
      if (
        await savedSystemDigest(expectedIds) !==
          await savedSystemDigest(manifestIds)
      ) throw error();
      const observed = await savedSystemDigest(savedSystemObservation(stored));
      const same = await savedSystemDigest(stored.source) ===
          await savedSystemDigest(input.manifest.source) &&
        observed ===
          await savedSystemDigest(savedSystemObservation(input.capture));
      const status = same ? input.status : "conflict";
      const manifest = same ? JSON.stringify(input.manifest) : null;
      const digest = same ? input.digest : null;
      const issues = JSON.stringify(same ? input.issues : ["CAPTURE_CHANGED"]);
      const publication = publicationEvent(
        decodeSavedSystemRow(row).publication,
        {
          step: "manifest-finalization",
          status: !same
            ? "refused"
            : input.status === "retained"
            ? "completed"
            : "incomplete",
          ...(!same
            ? { issue: "CAPTURE_CHANGED" as const }
            : input.status === "incomplete"
            ? { issue: "PREREQUISITES_REQUIRED" as const }
            : {}),
        },
        !same
          ? "refused"
          : input.status === "retained"
          ? "completed"
          : "incomplete",
        this.clock.now(),
      );
      if (intent) {
        await this.authorize(
          tx,
          input.authorization,
          this.intent(input.scope, decodeSavedSystemRow(row)),
        );
      }
      const rows = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma
          .sql`UPDATE ${this.table()} SET "publication"=${
          JSON.stringify(publication)
        }, "status"=${status}, "manifest"=${manifest}, "digest"=${digest}, "issues"=${issues}, "revision"="revision"+1 WHERE "id"=${input.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw error();
      mutated();
      return decodeSavedSystemRow(rows[0]);
    });
  }
  async markIncomplete(
    input: Parameters<SavedSystemStorePort["markIncomplete"]>[0],
  ): Promise<SavedSystemRecord> {
    return await this.catalogueTransaction(async (tx, mutated) => {
      const accepted = await this.getRow(tx, input.scope, input.id);
      if (!accepted) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The saved system is unavailable.",
        );
      }
      const intent = this.creationGuard
        ? this.intent(input.scope, decodeSavedSystemRow(accepted))
        : undefined;
      if (intent) await this.authorize(tx, input.authorization, intent);
      await this.lockScope(tx, input.scope);
      const row = await this.getRow(tx, input.scope, input.id);
      if (!row) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The saved system is unavailable.",
        );
      }
      if (
        row.revision !== input.expectedRevision ||
        input.preparationId !== undefined &&
          decodeSavedSystemRow(row).publication?.runId !==
            input.preparationId ||
        !["pending", "incomplete"].includes(row.status)
      ) return decodeSavedSystemRow(row);
      if (intent) {
        await this.authorize(
          tx,
          input.authorization,
          this.intent(input.scope, decodeSavedSystemRow(row)),
        );
      }
      const failed = input.failure === "technical";
      const issue: ReleasePublicationIssue | undefined = failed
        ? "PUBLICATION_FAILED"
        : input.failure === "tag"
        ? "TAG_UNAVAILABLE"
        : input.failure === "asset"
        ? "EXACT_ASSET_UNAVAILABLE"
        : input.issues.includes("PREREQUISITES_REQUIRED")
        ? "PREREQUISITES_REQUIRED"
        : input.issues.includes("TAG_UNAVAILABLE")
        ? "TAG_UNAVAILABLE"
        : input.issues.includes("EXACT_ASSET_UNAVAILABLE")
        ? "EXACT_ASSET_UNAVAILABLE"
        : undefined;
      const publication = publicationEvent(
        decodeSavedSystemRow(row).publication,
        {
          step: input.failure === "tag"
            ? "tag-verification"
            : failed
            ? "manifest-finalization"
            : input.failure === "asset"
            ? "asset-retention"
            : "preparation",
          status: failed ? "failed" : "incomplete",
          ...(issue ? { issue } : {}),
        },
        failed ? "failed" : "incomplete",
        this.clock.now(),
      );
      const rows = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma.sql`UPDATE ${this.table()} SET "publication"=${
          JSON.stringify(publication)
        }, "status"='incomplete', "issues"=${
          JSON.stringify(input.issues)
        }, "revision"="revision"+1 WHERE "id"=${input.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw error();
      mutated();
      return decodeSavedSystemRow(rows[0]);
    });
  }
  async progress(
    input: Parameters<NonNullable<SavedSystemStorePort["progress"]>>[0],
  ): Promise<SavedSystemRecord> {
    return await this.catalogueTransaction(async (tx, mutated) => {
      const initial = await this.getRow(tx, input.scope, input.id);
      if (!initial) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The Release is unavailable.",
        );
      }
      if (this.creationGuard) {
        await this.authorize(
          tx,
          input.authorization,
          this.intent(input.scope, decodeSavedSystemRow(initial)),
        );
      }
      await this.lockScope(tx, input.scope);
      const row = await this.getRow(tx, input.scope, input.id);
      if (!row) throw error();
      const stored = decodeSavedSystemRow(row);
      if (
        row.revision !== input.expectedRevision ||
        !["pending", "incomplete"].includes(row.status) ||
        !input.start && stored.publication?.runId !== input.runId
      ) return stored;
      // Only the bounded service's start/recovery and actual step observations
      // are accepted. A progress call cannot manufacture completion/refusal.
      if (
        input.outcome !== "preparing" ||
        input.start &&
          (!["preparation", "recovery"].includes(input.event.step) ||
            input.event.status !== "started") ||
        !input.start && !["started", "completed"].includes(input.event.status)
      ) throw error();
      const publication = publicationEvent(
        stored.publication,
        input.event,
        input.outcome,
        this.clock.now(),
        input.runId,
      );
      const rows = await tx.$queryRaw<SavedSystemRow[]>(
        Prisma.sql`UPDATE ${this.table()} SET "publication"=${
          JSON.stringify(publication)
        }, "revision"="revision"+1 WHERE "id"=${input.id} AND "revision"=${input.expectedRevision} RETURNING *`,
      );
      if (!rows[0]) throw error();
      mutated();
      return decodeSavedSystemRow(rows[0]);
    });
  }
  async find(
    scope: SavedSystemScope,
    saveKey: string,
  ): Promise<SavedSystemRecord | null> {
    const rows = await this.client.$queryRaw<SavedSystemRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "executionSpaceId"=${scope.executionSpaceId} AND "saveKey"=${saveKey}`,
    );
    return rows[0] ? decodeSavedSystemRow(rows[0]) : null;
  }
  async list(scope: SavedSystemScope): Promise<SavedSystemRecord[]> {
    const rows = await this.client.$queryRaw<SavedSystemRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId} AND "executionSpaceId"=${scope.executionSpaceId} ORDER BY "createdAt" DESC, "id" DESC LIMIT 100`,
    );
    return rows.map(decodeSavedSystemRow);
  }
  async get(
    scope: SavedSystemScope,
    id: string,
  ): Promise<SavedSystemRecord | null> {
    const row = await this.getRow(this.client, scope, id);
    return row ? decodeSavedSystemRow(row) : null;
  }
}

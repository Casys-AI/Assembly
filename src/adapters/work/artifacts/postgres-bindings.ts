import type {
  ArtifactBinding,
  ArtifactVersion,
} from "../../../../prisma/generated/client.ts";
import type { PrismaClient } from "../../out/postgres/client.ts";
import { postgresExecutionTransaction } from "../../out/postgres/execution-transaction.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "../../out/postgres/scope.ts";
import {
  artifactSourceBindingId,
  artifactSourceBindingProvenance,
  type ArtifactSourceBindingRecord,
  type ArtifactSourceBindingsPort,
  type ArtifactSourceBindingWrite,
  artifactSourceVersionId,
  assertArtifactSourceBindingProvenance,
} from "../../../application/work/artifacts/publication.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  ArtifactSourceError,
  type ArtifactSourceReference,
  requireSource,
  sourceIdentity,
  validateSourceBindingReference,
  validateSourceReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import {
  artifactSourceContentDigest,
  assertQueuedArtifactSourcePublication,
} from "../../../domain/work/artifacts/source-publication.ts";

const MAX_PROVENANCE_BYTES = 131_072;
interface PostgresArtifactBindingsOptions {
  client: PrismaClient;
  scope: PostgresRuntimeScope;
  repositoryId: string;
  sourceScopeId: string;
}

/** PostgreSQL publishes immutable source identities and target-local receipts.
 * No source text, moving head or active-admission state is maintained here. */
export class PostgresArtifactBindings implements ArtifactSourceBindingsPort {
  readonly #client: PrismaClient;
  readonly #scope: PostgresRuntimeScope;
  readonly #repositoryId: string;
  readonly #sourceScopeId: string;
  constructor(options: PostgresArtifactBindingsOptions) {
    assertPostgresRuntimeScope(options.scope);
    requireSource(
      sourceIdentity(options.repositoryId) &&
        sourceIdentity(options.sourceScopeId),
      "invalid",
    );
    this.#client = options.client;
    this.#scope = Object.freeze({ ...options.scope });
    this.#repositoryId = options.repositoryId;
    this.#sourceScopeId = options.sourceScopeId;
  }
  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ArtifactSourceError) throw error;
      throw new ArtifactSourceError("repository");
    }
  }
  #reference(row: ArtifactVersion): ArtifactSourceReference {
    requireSource(
      row.projectId === this.#scope.projectId &&
        row.systemId === this.#scope.systemId &&
        row.repositoryId === this.#repositoryId &&
        row.sourceScopeId === this.#sourceScopeId,
      "scope",
    );
    // Old rows remain preserved, but never become an active inline/v1 fallback.
    requireSource(row.sourceReferenceVersion === 2n, "integrity");
    const reference = {
      version: 2,
      scopeId: row.sourceScopeId,
      repositoryId: row.repositoryId,
      artifactId: row.artifactId,
      kind: row.kind,
      commitOid: row.commitOid,
      entryPath: row.entryPath,
      manifestPath: row.manifestPath,
      contentEncoding: row.contentEncoding,
      contentDigest: row.contentDigest,
      manifestFormat: row.manifestFormat,
      manifestDigestVersion: row.manifestDigestVersion,
      manifestDigest: row.manifestDigest,
    };
    validateSourceReference(reference);
    return reference;
  }
  async #decode(
    row: ArtifactBinding & { version: ArtifactVersion },
  ): Promise<ArtifactSourceBindingRecord> {
    requireSource(
      row.projectId === this.#scope.projectId &&
        row.systemId === this.#scope.systemId &&
        row.executionSpaceId === this.#scope.executionSpaceId &&
        row.operatorId === this.#scope.operatorId && row.revision === 1n,
      "scope",
    );
    const reference = this.#reference(row.version);
    requireSource(
      row.versionId === await artifactSourceVersionId(reference) &&
        row.bindingId ===
          await artifactSourceBindingId({
            ...this.#scope,
            ownerId: row.ownerId,
            localArtifactId: row.localArtifactId,
            invocationId: row.invocationId,
          }),
      "integrity",
    );
    requireSource(
      new TextEncoder().encode(row.provenancePayload).length <=
        MAX_PROVENANCE_BYTES,
      "limit",
    );
    let envelope: { version: number; value: unknown; digest: string };
    try {
      envelope = JSON.parse(row.provenancePayload);
    } catch {
      throw new ArtifactSourceError("integrity");
    }
    requireSource(
      !!envelope && typeof envelope === "object" &&
        Object.keys(envelope).length === 3 &&
        envelope.version === 1 &&
        envelope.digest === await canonicalDigest(envelope.value) &&
        canonical(envelope) === row.provenancePayload,
      "integrity",
    );
    assertArtifactSourceBindingProvenance(envelope.value);
    const binding = {
      version: 1 as const,
      bindingId: row.bindingId,
      versionId: row.versionId,
      revision: 1,
      ownerId: row.ownerId,
      localArtifactId: row.localArtifactId,
      invocationId: row.invocationId,
      reference,
    };
    validateSourceBindingReference(binding);
    return { binding, provenance: envelope.value };
  }
  async bind(
    input: ArtifactSourceBindingWrite,
  ): Promise<ArtifactSourceBindingRecord> {
    const frozen = structuredClone(input);
    return await this.#safe(async () => {
      const { publication, receipt } = frozen;
      await assertQueuedArtifactSourcePublication(
        publication,
        this.#repositoryId,
      );
      requireSource(
        Object.entries(this.#scope).every(([key, value]) =>
          publication.target[key as keyof PostgresRuntimeScope] === value
        ),
        "scope",
      );
      const reference = receipt.reference;
      validateSourceReference(reference);
      requireSource(
        reference.repositoryId === this.#repositoryId &&
          reference.scopeId === this.#sourceScopeId &&
          reference.artifactId === publication.source.artifactId &&
          reference.kind === publication.source.kind &&
          reference.contentDigest ===
            await artifactSourceContentDigest(publication.source) &&
          receipt.version === 1 &&
          receipt.command?.commandId === publication.publicationId &&
          receipt.baseVersion === publication.baseVersion &&
          receipt.baseSourceDigest === publication.baseSourceDigest &&
          frozen.requestDigest === await canonicalDigest(publication),
        "integrity",
      );
      const versionId = await artifactSourceVersionId(reference);
      const bindingId = await artifactSourceBindingId(publication.target);
      const provenance = artifactSourceBindingProvenance(frozen);
      assertArtifactSourceBindingProvenance(provenance);
      const provenancePayload = canonical({
        version: 1,
        value: provenance,
        digest: await canonicalDigest(provenance),
      });
      requireSource(
        new TextEncoder().encode(provenancePayload).length <=
          MAX_PROVENANCE_BYTES,
        "limit",
      );
      return await postgresExecutionTransaction(this.#client, async (tx) => {
        // Both FK envelopes must already be registered by trusted composition.
        const repository = await tx.sourceRepository.findUnique({
          where: {
            projectId_systemId_repositoryId: {
              projectId: this.#scope.projectId,
              systemId: this.#scope.systemId,
              repositoryId: this.#repositoryId,
            },
          },
        });
        requireSource(
          repository?.sourceScopeId === this.#sourceScopeId,
          "scope",
        );
        await tx.artifactVersion.createMany({
          data: [{
            projectId: this.#scope.projectId,
            systemId: this.#scope.systemId,
            versionId,
            artifactId: reference.artifactId,
            kind: reference.kind,
            sourceReferenceVersion: 2n,
            sourceScopeId: reference.scopeId,
            repositoryId: reference.repositoryId,
            commitOid: reference.commitOid,
            manifestPath: reference.manifestPath,
            entryPath: reference.entryPath,
            contentDigest: reference.contentDigest,
            contentEncoding: reference.contentEncoding,
            manifestFormat: reference.manifestFormat,
            manifestDigestVersion: reference.manifestDigestVersion,
            manifestDigest: reference.manifestDigest,
            // This is canonical SQL publication of a retained version, not its Git CAS time.
            publishedAt: new Date(),
          }],
          skipDuplicates: true,
        });
        const version = await tx.artifactVersion.findUnique({
          where: {
            projectId_systemId_versionId: {
              projectId: this.#scope.projectId,
              systemId: this.#scope.systemId,
              versionId,
            },
          },
        });
        requireSource(
          version &&
            canonical(this.#reference(version)) === canonical(reference),
          "integrity",
        );
        await tx.artifactBinding.createMany({
          data: [{
            ...this.#scope,
            bindingId,
            ownerId: publication.target.ownerId,
            localArtifactId: publication.target.localArtifactId,
            invocationId: publication.target.invocationId,
            versionId,
            revision: 1n,
            provenancePayload,
          }],
          skipDuplicates: true,
        });
        const row = await tx.artifactBinding.findUnique({
          where: {
            projectId_systemId_executionSpaceId_operatorId_bindingId: {
              ...this.#scope,
              bindingId,
            },
          },
          include: { version: true },
        });
        requireSource(
          row && row.ownerId === publication.target.ownerId &&
            row.localArtifactId === publication.target.localArtifactId &&
            row.invocationId === publication.target.invocationId &&
            row.versionId === versionId &&
            row.provenancePayload === provenancePayload,
          "integrity",
        );
        return await this.#decode(row);
      });
    });
  }
  async read(bindingId: string): Promise<ArtifactSourceBindingRecord | null> {
    requireSource(sourceIdentity(bindingId), "invalid");
    return await this.#safe(async () => {
      const row = await this.#client.artifactBinding.findUnique({
        where: {
          projectId_systemId_executionSpaceId_operatorId_bindingId: {
            ...this.#scope,
            bindingId,
          },
        },
        include: { version: true },
      });
      return row ? await this.#decode(row) : null;
    });
  }
}

import { matchesExactRevision } from "../../../domain/shared-kernel/revision-id.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  type ArtifactSource,
  type ArtifactSourceBusinessProof,
  artifactSourceContentDigest,
  artifactSourceProofModel,
  assertArtifactSourceBusinessProof,
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "../../../domain/work/artifacts/source-publication.ts";
import {
  type ArtifactSourceBindingReference,
  type ArtifactSourceReference,
  requireSource,
  sourceDigest,
  sourceIdentity,
  validateSourceBindingReference,
  validateSourceReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import type { ToolDraft } from "../../../domain/work/records/candidates.ts";
import { toolDraftDigest } from "./catalog.ts";
import { skillContentDigest } from "../../../domain/skills/context-skills.ts";
import type {
  ArtifactSourcePublicationReceipt,
  ArtifactSourceRepositoryPort,
} from "./source-repository.ts";

export type {
  ArtifactSourceBusinessProof,
  QueuedArtifactSourcePublication,
} from "../../../domain/work/artifacts/source-publication.ts";
export type BoundArtifactSource = ArtifactSourceBindingReference;

/** Captured by trusted composition, never selected by a model/provider argument. */
export interface ArtifactSourceRuntimeScope {
  readonly projectId: string;
  readonly systemId: string;
  readonly executionSpaceId: string;
  readonly operatorId: string;
}
interface ArtifactSourceBindingProvenance {
  version: 1;
  publicationId: string;
  requestDigest: string;
  baseVersion: string;
  baseSourceDigest: string;
  proof: ArtifactSourceBusinessProof;
  upstream?: ArtifactSourceReference;
  command: { commandId: string; commandDigest: string };
}
export interface ArtifactSourceBindingRecord {
  binding: BoundArtifactSource;
  provenance: ArtifactSourceBindingProvenance;
}
export interface ArtifactSourceBindingWrite {
  publication: QueuedArtifactSourcePublication;
  requestDigest: string;
  receipt: ArtifactSourcePublicationReceipt;
}
/** Each invocation creates an immutable binding; active catalogs retain their own CAS. */
export interface ArtifactSourceBindingsPort {
  bind(input: ArtifactSourceBindingWrite): Promise<ArtifactSourceBindingRecord>;
  read(bindingId: string): Promise<ArtifactSourceBindingRecord | null>;
}
export interface QueuedArtifactSourcePublisher {
  /** Recheck current business authority even when returning a completed/recovered receipt. */
  publish(
    publication: QueuedArtifactSourcePublication,
  ): Promise<ArtifactSourcePublicationReceipt>;
}
interface ArtifactSourcePublicationInput {
  artifactId: string;
  ownerId: string;
  localArtifactId: string;
  invocationId: string;
  baseVersion: string;
  expectedDigest: string;
  proof: ArtifactSourceBusinessProof;
  upstream?: ArtifactSourceReference;
}
interface ToolArtifactSourcePublication extends ArtifactSourcePublicationInput {
  draft: ToolDraft;
}
export interface SkillArtifactSourcePublication
  extends ArtifactSourcePublicationInput {
  content: string;
}
export interface ArtifactSourceSelection {
  expectedBinding: BoundArtifactSource;
  bindingId: string;
  ownerId: string;
  localArtifactId: string;
  expectedDigest: string;
  reference: ArtifactSourceReference;
}
export interface ArtifactSourceServicePort {
  publishTool(
    input: ToolArtifactSourcePublication,
  ): Promise<BoundArtifactSource>;
  publishSkill(
    input: SkillArtifactSourcePublication,
  ): Promise<BoundArtifactSource>;
  resolveTool(selection: ArtifactSourceSelection): Promise<ToolDraft>;
  resolveSkill(selection: ArtifactSourceSelection): Promise<string>;
}
interface ArtifactSourceServiceOptions {
  scope: ArtifactSourceRuntimeScope;
  repositoryId: string;
  sourceScopeId: string;
  repository: ArtifactSourceRepositoryPort;
  queuedPublisher: QueuedArtifactSourcePublisher;
  bindings: ArtifactSourceBindingsPort;
  sourceHeader(
    version: string,
  ): Promise<{ version: string; sourceDigest: string }>;
}

export async function artifactSourceVersionId(
  reference: ArtifactSourceReference,
): Promise<string> {
  validateSourceReference(reference);
  return `source-version:${await canonicalDigest(reference)}`;
}
export async function artifactSourceBindingId(
  target: QueuedArtifactSourcePublication["target"],
): Promise<string> {
  return `source-binding:${await canonicalDigest({
    projectId: target.projectId,
    systemId: target.systemId,
    executionSpaceId: target.executionSpaceId,
    operatorId: target.operatorId,
    ownerId: target.ownerId,
    invocationId: target.invocationId,
  })}`;
}
export function artifactSourceBindingProvenance(
  input: ArtifactSourceBindingWrite,
): ArtifactSourceBindingProvenance {
  const { publication, receipt } = input;
  requireSource(
    receipt.command && sourceDigest(input.requestDigest),
    "integrity",
  );
  return {
    version: 1,
    publicationId: publication.publicationId,
    requestDigest: input.requestDigest,
    baseVersion: publication.baseVersion,
    baseSourceDigest: publication.baseSourceDigest,
    proof: structuredClone(publication.proof),
    ...(publication.upstream
      ? { upstream: structuredClone(publication.upstream) }
      : {}),
    command: structuredClone(receipt.command),
  };
}
export function assertArtifactSourceBindingProvenance(
  value: unknown,
): asserts value is ArtifactSourceBindingProvenance {
  requireSource(
    !!value && typeof value === "object" && !Array.isArray(value),
    "integrity",
  );
  const provenance = value as ArtifactSourceBindingProvenance;
  const allowed = [
    "version",
    "publicationId",
    "requestDigest",
    "baseVersion",
    "baseSourceDigest",
    "proof",
    "upstream",
    "command",
  ];
  requireSource(
    Object.keys(provenance).every((key) => allowed.includes(key)) &&
      provenance.version === 1 &&
      sourceIdentity(provenance.publicationId) &&
      sourceDigest(provenance.requestDigest) &&
      sourceDigest(provenance.baseSourceDigest) &&
      typeof provenance.baseVersion === "string" &&
      matchesExactRevision(provenance.baseVersion) &&
      !!provenance.command && sourceIdentity(provenance.command.commandId) &&
      sourceDigest(provenance.command.commandDigest) &&
      Object.keys(provenance.command).length === 2,
    "integrity",
  );
  assertArtifactSourceBusinessProof(provenance.proof);
  requireSource(
    artifactSourceProofModel(provenance.proof).repositoryVersion ===
      provenance.baseVersion,
    "integrity",
  );
  if (provenance.upstream !== undefined) {
    validateSourceReference(provenance.upstream);
  }
}

/** Retention, scoped SQL settlement and exact reads. This service grants no
 * candidate admission, activation, skill loading or cross-owner reuse rights. */
export class ArtifactSourceService implements ArtifactSourceServicePort {
  readonly #options: ArtifactSourceServiceOptions;
  constructor(options: ArtifactSourceServiceOptions) {
    requireSource(
      [
        options.scope.projectId,
        options.scope.systemId,
        options.scope.executionSpaceId,
        options.scope.operatorId,
        options.repositoryId,
        options.sourceScopeId,
      ].every(sourceIdentity),
      "invalid",
    );
    this.#options = { ...options, scope: Object.freeze({ ...options.scope }) };
  }
  async publishTool(
    input: ToolArtifactSourcePublication,
  ): Promise<BoundArtifactSource> {
    const frozen = structuredClone(input);
    requireSource(
      await toolDraftDigest(frozen.draft) === frozen.expectedDigest,
      "integrity",
    );
    return await this.#publish(frozen, {
      artifactId: frozen.artifactId,
      kind: "tool-draft",
      content: frozen.draft,
    });
  }
  async publishSkill(
    input: SkillArtifactSourcePublication,
  ): Promise<BoundArtifactSource> {
    const frozen = structuredClone(input);
    requireSource(
      await skillContentDigest(frozen.content) === frozen.expectedDigest,
      "integrity",
    );
    return await this.#publish(frozen, {
      artifactId: frozen.artifactId,
      kind: "skill-document",
      content: frozen.content,
    });
  }
  async #publish(
    input: ArtifactSourcePublicationInput,
    source: ArtifactSource,
  ): Promise<BoundArtifactSource> {
    requireSource(
      [
        input.ownerId,
        input.localArtifactId,
        input.invocationId,
        input.artifactId,
      ].every(sourceIdentity) && sourceDigest(input.expectedDigest),
      "invalid",
    );
    const header = await this.#options.sourceHeader(input.baseVersion);
    requireSource(
      header.version === input.baseVersion && sourceDigest(header.sourceDigest),
      "integrity",
    );
    const target = {
      ...this.#options.scope,
      ownerId: input.ownerId,
      localArtifactId: input.localArtifactId,
      invocationId: input.invocationId,
    };
    const bindingId = await artifactSourceBindingId(target);
    const publication: QueuedArtifactSourcePublication = {
      publicationId: `source-${bindingId.slice("source-binding:".length)}`,
      source,
      baseVersion: input.baseVersion,
      baseSourceDigest: header.sourceDigest,
      target,
      proof: input.proof,
      ...(input.upstream ? { upstream: input.upstream } : {}),
    };
    await assertQueuedArtifactSourcePublication(
      publication,
      this.#options.repositoryId,
    );
    const requestDigest = await canonicalDigest(publication);
    // Queue retry/recovery resolves the immutable source-command anchor first.
    // SQL settlement below is its own canonical commit, never a Git/SQL transaction.
    const receipt = await this.#options.queuedPublisher.publish(
      structuredClone(publication),
    );
    validateSourceReference(receipt.reference);
    requireSource(
      receipt.version === 1 &&
        receipt.baseVersion === publication.baseVersion &&
        receipt.baseSourceDigest === publication.baseSourceDigest &&
        !!receipt.command &&
        receipt.command.commandId === publication.publicationId &&
        receipt.reference.repositoryId === this.#options.repositoryId &&
        receipt.reference.scopeId === this.#options.sourceScopeId &&
        receipt.reference.artifactId === source.artifactId &&
        receipt.reference.kind === source.kind &&
        receipt.reference.contentDigest === input.expectedDigest,
      "integrity",
    );
    const anchored = await this.#options.repository.findByCommand(
      receipt.command,
    );
    requireSource(
      anchored && canonical(anchored) === canonical(receipt),
      "integrity",
    );
    const resolved = await this.#options.repository.read(receipt.reference);
    requireSource(
      canonical(resolved) === canonical(source) &&
        await artifactSourceContentDigest(resolved) === input.expectedDigest,
      "integrity",
    );
    const record = await this.#options.bindings.bind({
      publication,
      requestDigest,
      receipt,
    });
    validateSourceBindingReference(record.binding);
    requireSource(
      record.binding.bindingId === bindingId &&
        record.binding.ownerId === target.ownerId &&
        record.binding.localArtifactId === target.localArtifactId &&
        record.binding.invocationId === target.invocationId &&
        record.provenance.requestDigest === requestDigest &&
        canonical(record.binding.reference) === canonical(receipt.reference),
      "integrity",
    );
    return structuredClone(record.binding);
  }
  async resolveTool(selection: ArtifactSourceSelection): Promise<ToolDraft> {
    const source = await this.#resolve(selection, "tool-draft");
    requireSource(source.kind === "tool-draft", "integrity");
    requireSource(
      await toolDraftDigest(source.content) === selection.expectedDigest,
      "integrity",
    );
    return structuredClone(source.content);
  }
  async resolveSkill(selection: ArtifactSourceSelection): Promise<string> {
    const source = await this.#resolve(selection, "skill-document");
    requireSource(source.kind === "skill-document", "integrity");
    requireSource(
      await skillContentDigest(source.content) === selection.expectedDigest,
      "integrity",
    );
    return source.content;
  }
  async #resolve(
    input: ArtifactSourceSelection,
    kind: ArtifactSource["kind"],
  ): Promise<ArtifactSource> {
    const selection = structuredClone(input);
    validateSourceBindingReference(selection.expectedBinding);
    requireSource(
      [selection.bindingId, selection.ownerId, selection.localArtifactId].every(
        sourceIdentity,
      ) && sourceDigest(selection.expectedDigest),
      "invalid",
    );
    validateSourceReference(selection.reference);
    requireSource(
      selection.reference.repositoryId === this.#options.repositoryId &&
        selection.reference.scopeId === this.#options.sourceScopeId,
      "scope",
    );
    const record = await this.#options.bindings.read(selection.bindingId);
    requireSource(record, "not-found");
    validateSourceBindingReference(record.binding);
    requireSource(
      canonical(record.binding) === canonical(selection.expectedBinding),
      "integrity",
    );
    assertArtifactSourceBindingProvenance(record.provenance);
    requireSource(
      record.binding.bindingId === selection.bindingId &&
        record.binding.ownerId === selection.ownerId &&
        record.binding.localArtifactId === selection.localArtifactId &&
        record.binding.reference.kind === kind &&
        record.binding.reference.contentDigest === selection.expectedDigest &&
        canonical(record.binding.reference) === canonical(selection.reference),
      "integrity",
    );
    const anchored = await this.#options.repository.findByCommand(
      record.provenance.command,
    );
    requireSource(
      anchored && anchored.baseVersion === record.provenance.baseVersion &&
        anchored.baseSourceDigest === record.provenance.baseSourceDigest &&
        canonical(anchored.reference) === canonical(selection.reference),
      "integrity",
    );
    const source = await this.#options.repository.read(selection.reference);
    requireSource(
      source.kind === kind &&
        source.artifactId === selection.reference.artifactId &&
        await artifactSourceContentDigest(source) === selection.expectedDigest,
      "integrity",
    );
    return source;
  }
}

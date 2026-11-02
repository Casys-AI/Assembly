import { matchesExactRevision } from "../../shared-kernel/revision-id.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { sha256 } from "../../primitives/execution-digest.ts";
import { parseModelRevisionRef } from "../../model/value-objects/element-ref.ts";
import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";
import {
  requireSkillAuthority,
  requireSkillContent,
  type SkillAuthority,
} from "../../skills/context-skills.ts";
import type { BehaviorInvocationRequest } from "../execution/modeled-behavior.ts";
import { TOOL_KINDS } from "../../shared-kernel/tool-kind.ts";
import type { ToolDraft } from "../candidates.ts";
import {
  type ArtifactSourceReference,
  requireSource,
  sourceDigest,
  sourceIdentity,
  validateSourceReference,
} from "./source-reference.ts";

export type ArtifactSource =
  | { artifactId: string; kind: "tool-draft"; content: ToolDraft }
  | { artifactId: string; kind: "skill-document"; content: string };

/** Captured by existing admitted business flows. These facts are not fresh
 * authorization: the worker's host port revalidates current admission. */
export type ArtifactSourceBusinessProof =
  | {
    kind: "native-action";
    ownerId: string;
    modelVersion: BehaviorModelVersion;
    flowRootNativeId: string;
    nativeActionId: string;
    mechanism: "propose_candidate";
    invocationId: string;
  }
  | {
    kind: "modeled-behavior";
    invocation: Pick<
      BehaviorInvocationRequest,
      "behavior" | "modelVersion" | "callerId" | "invocationId"
    >;
  }
  | { kind: "skill-authority"; authority: SkillAuthority }
  | {
    kind: "admitted-model-seed";
    ownerId: string;
    sourceElementId: string;
    modelVersion: BehaviorModelVersion;
  };

export interface QueuedArtifactSourcePublication {
  publicationId: string;
  source: ArtifactSource;
  baseVersion: string;
  baseSourceDigest: string;
  target: {
    projectId: string;
    systemId: string;
    executionSpaceId: string;
    operatorId: string;
    ownerId: string;
    localArtifactId: string;
    invocationId: string;
  };
  proof: ArtifactSourceBusinessProof;
  upstream?: ArtifactSourceReference;
}

const MAX_QUEUED_ARTIFACT_SOURCE_BYTES = 1_048_576;
const MAX_QUEUED_ARTIFACT_PROOF_BYTES = 65_536;

function closed(value: object, fields: readonly string[]) {
  requireSource(
    Object.keys(value).every((key) => fields.includes(key)),
    "invalid",
  );
}

/** Existing exact source encodings: tool JSON field order and raw UTF-8 skill
 * text remain unchanged; this is not a model/compiler recipe identity. */
export async function artifactSourceContentDigest(
  source: ArtifactSource,
): Promise<string> {
  requireSource(
    !!source && typeof source === "object" && sourceIdentity(source.artifactId),
    "invalid",
  );
  closed(source, ["artifactId", "kind", "content"]);
  let text: string;
  if (source.kind === "skill-document") {
    requireSkillContent(source.content, MAX_QUEUED_ARTIFACT_SOURCE_BYTES);
    text = source.content;
  } else {
    requireSource(
      source.kind === "tool-draft" && !!source.content &&
        typeof source.content === "object",
      "invalid",
    );
    const draft = source.content;
    closed(draft, ["name", "description", "kind", "code"]);
    const encoder = new TextEncoder(),
      decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    requireSource(
      [draft.name, draft.description, draft.code].every((value) =>
        typeof value === "string" &&
        decoder.decode(encoder.encode(value)) === value
      ) && TOOL_KINDS.includes(draft.kind),
      "invalid",
    );
    text = JSON.stringify({
      name: draft.name,
      description: draft.description,
      kind: draft.kind,
      code: draft.code,
    });
  }
  requireSource(
    new TextEncoder().encode(text).length <= MAX_QUEUED_ARTIFACT_SOURCE_BYTES,
    "limit",
  );
  return await sha256(text);
}

export function artifactSourceProofModel(
  proof: ArtifactSourceBusinessProof,
): BehaviorModelVersion {
  return proof.kind === "modeled-behavior"
    ? proof.invocation.modelVersion
    : proof.kind === "skill-authority"
    ? proof.authority.modelVersion
    : proof.modelVersion;
}

/** Validates only a bounded captured business proof, never current authority. */
export function assertArtifactSourceBusinessProof(
  proof: ArtifactSourceBusinessProof,
): void {
  requireSource(!!proof && typeof proof === "object", "invalid");
  requireSource(
    new TextEncoder().encode(canonical(proof)).length <=
      MAX_QUEUED_ARTIFACT_PROOF_BYTES,
    "limit",
  );
  if (proof.kind === "native-action") {
    closed(proof, [
      "kind",
      "ownerId",
      "modelVersion",
      "flowRootNativeId",
      "nativeActionId",
      "mechanism",
      "invocationId",
    ]);
    requireSource(
      [
        proof.ownerId,
        proof.flowRootNativeId,
        proof.nativeActionId,
        proof.invocationId,
      ].every(sourceIdentity) && proof.mechanism === "propose_candidate",
      "invalid",
    );
  } else if (proof.kind === "modeled-behavior") {
    closed(proof, ["kind", "invocation"]);
    const invocation = proof.invocation;
    requireSource(!!invocation && typeof invocation === "object", "invalid");
    closed(invocation, [
      "behavior",
      "modelVersion",
      "callerId",
      "invocationId",
    ]);
    requireSource(
      sourceIdentity(invocation.callerId) &&
        sourceIdentity(invocation.invocationId) &&
        sourceIdentity(invocation.behavior?.id) &&
        invocation.behavior.callerNativeId === invocation.callerId,
      "invalid",
    );
    closed(invocation.behavior, [
      "id",
      "name",
      "description",
      "targetNativeId",
      "targetTypeId",
      "inputTypeId",
      "callerNativeId",
      "inputSchema",
      "sourceIds",
    ]);
  } else if (proof.kind === "skill-authority") {
    closed(proof, ["kind", "authority"]);
    requireSkillAuthority(proof.authority, "install");
    closed(proof.authority, [
      "callerId",
      "policy",
      "modelVersion",
      "behaviorId",
      "invocationId",
      "permissions",
    ]);
    closed(proof.authority.policy, [
      "id",
      "ownerId",
      "allowedHosts",
      "maxSkillBytes",
      "maxInstalledSkills",
      "maxLoadedSkills",
      "maxLoadedCharacters",
    ]);
  } else {
    requireSource(proof.kind === "admitted-model-seed", "invalid");
    closed(proof, ["kind", "ownerId", "sourceElementId", "modelVersion"]);
    requireSource(
      sourceIdentity(proof.ownerId) && sourceIdentity(proof.sourceElementId),
      "invalid",
    );
  }
  const pin = artifactSourceProofModel(proof);
  requireSource(
    !!pin && typeof pin === "object" && sourceDigest(pin.digest) &&
      typeof pin.repositoryVersion === "string" &&
      matchesExactRevision(pin.repositoryVersion),
    "invalid",
  );
  closed(pin, ["digest", "repositoryVersion"]);
}

/** Structural and identity admission only. The host must compare the captured
 * business proof against its current admitted model before each effect/replay. */
export async function assertQueuedArtifactSourcePublication(
  publication: QueuedArtifactSourcePublication,
  repositoryId: string,
): Promise<void> {
  requireSource(!!publication && typeof publication === "object", "invalid");
  closed(publication, [
    "publicationId",
    "source",
    "baseVersion",
    "baseSourceDigest",
    "target",
    "proof",
    "upstream",
  ]);
  requireSource(
    sourceIdentity(publication.publicationId) &&
      sourceDigest(publication.baseSourceDigest),
    "invalid",
  );
  parseModelRevisionRef({ repositoryId, version: publication.baseVersion });
  const target = publication.target;
  requireSource(
    !!target && typeof target === "object" &&
      [
        target.projectId,
        target.systemId,
        target.executionSpaceId,
        target.operatorId,
        target.ownerId,
        target.localArtifactId,
        target.invocationId,
      ].every(sourceIdentity),
    "invalid",
  );
  closed(target, [
    "projectId",
    "systemId",
    "executionSpaceId",
    "operatorId",
    "ownerId",
    "localArtifactId",
    "invocationId",
  ]);
  const proof = publication.proof;
  assertArtifactSourceBusinessProof(proof);
  if (proof.kind === "native-action") {
    requireSource(
      publication.source.kind === "tool-draft" &&
        proof.ownerId === target.ownerId &&
        proof.invocationId === target.invocationId,
      "scope",
    );
  } else if (proof.kind === "modeled-behavior") {
    requireSource(
      proof.invocation.callerId === target.ownerId &&
        proof.invocation.invocationId === target.invocationId,
      "scope",
    );
  } else if (proof.kind === "skill-authority") {
    requireSource(
      publication.source.kind === "skill-document" &&
        proof.authority.callerId === target.ownerId &&
        proof.authority.invocationId === target.invocationId,
      "scope",
    );
  } else {
    requireSource(proof.ownerId === target.ownerId, "scope");
  }
  requireSource(
    artifactSourceProofModel(proof).repositoryVersion ===
      publication.baseVersion,
    "integrity",
  );
  const contentDigest = await artifactSourceContentDigest(publication.source);
  if (publication.upstream !== undefined) {
    validateSourceReference(publication.upstream);
    requireSource(
      publication.upstream.kind === publication.source.kind &&
        publication.upstream.contentDigest === contentDigest,
      "integrity",
    );
  }
}

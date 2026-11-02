import { assert as requireValue } from "../../../domain/primitives/assert.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { validateSourceBindingReference } from "../../../domain/work/artifacts/source-reference.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type {
  ArtifactReuseOrigin,
  Candidate,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";

/** Publication proves exact admitted bytes; it carries no target authority. */
export interface PublishedToolArtifact {
  agentId: string;
  candidate: Candidate;
  /** Fresh native catalog readback; its semantic digest must already be admitted
   * by the publishing runtime before the catalog port supplies this record. */
  model: ExecutableModel;
}

type ToolReuseAdmission = Pick<
  BehaviorInvocationRequest,
  "behavior" | "modelVersion" | "callerId" | "invocationId"
>;

export interface ToolReuseImport {
  proof: ToolReuseAdmission;
  artifact: PublishedToolArtifact;
}

export interface ToolReuseReceipt {
  source: Pick<ArtifactReuseOrigin, "agentId" | "candidateId" | "digest">;
  candidateId: string;
  candidateDigest: string;
  stage: Stage;
  active: boolean;
  testsPassed: boolean | null;
  correlationId: string;
  replayed: boolean;
}

/** This encoding preserves the existing draft digests byte for byte. */
export async function toolDraftDigest(draft: ToolDraft): Promise<string> {
  const value = {
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    code: draft.code,
  };
  return await sha256(JSON.stringify(value));
}

function exactBehavior(
  left: NativeBehaviorContract,
  right: NativeBehaviorContract,
): boolean {
  return canonical(left) === canonical(right);
}

/** Revalidate the caller against its admitted scope, not a global commit clock. */
export function requireToolReuseAdmission(
  proof: ToolReuseAdmission,
  model: ExecutableModel,
): NativeBehaviorContract {
  requireValue(
    typeof proof.invocationId === "string" && proof.invocationId.trim() &&
      proof.invocationId.length <= 512 &&
      proof.callerId === model.identity.builderId &&
      proof.modelVersion.digest === model.version.digest &&
      typeof proof.modelVersion.repositoryVersion === "string" &&
      proof.modelVersion.repositoryVersion.trim(),
    "La réutilisation exige une invocation et un appelant admis exacts.",
  );
  const matches = (model.behaviors ?? []).filter((behavior) =>
    behavior.id === proof.behavior.id &&
    behavior.callerNativeId === proof.callerId &&
    exactBehavior(behavior, proof.behavior)
  );
  requireValue(
    matches.length === 1,
    "La réutilisation n’est pas exposée à cet opérateur par son modèle admis.",
  );
  return matches[0]!;
}

/** A native active occurrence, its local admission and its bytes must agree. */
export async function publishedToolDraft(
  artifact: PublishedToolArtifact,
): Promise<ToolDraft> {
  const { agentId, candidate, model } = artifact;
  requireValue(
    candidate.sourceBinding,
    "The published artifact has no retained source binding.",
  );
  validateSourceBindingReference(candidate.sourceBinding);
  requireValue(
    candidate.sourceBinding.ownerId === agentId &&
      candidate.sourceBinding.localArtifactId === candidate.id &&
      candidate.sourceBinding.reference.kind === "tool-draft" &&
      candidate.sourceBinding.reference.contentDigest === candidate.digest,
    "The published artifact source binding does not match its exact owner and bytes.",
  );
  requireValue(
    agentId === model.identity.builderId &&
      model.version.repositoryVersion?.trim() &&
      candidate.stage === "active" && candidate.tests?.passed === true &&
      candidate.admission?.candidateId === candidate.id &&
      candidate.admission.candidateDigest === candidate.digest,
    "L’artefact source ne possède pas de publication admise vérifiable.",
  );
  const entries = model.catalog.filter((entry) =>
    entry.candidateId === candidate.id && entry.digest === candidate.digest &&
    entry.kind === candidate.kind && entry.name === candidate.name &&
    entry.status === "active" &&
    (!candidate.binding || entry.nativeId === candidate.binding.elementId) &&
    model.contracts.filter((contract) =>
        contract.nativeId === entry.contractId &&
        contract.kind === candidate.kind
      ).length === 1
  );
  requireValue(
    entries.length === 1,
    "Le catalogue natif ne confirme pas l’artefact source exact et actif.",
  );
  const draft: ToolDraft = {
    name: candidate.name,
    description: candidate.description,
    kind: candidate.kind,
    code: candidate.code,
  };
  requireValue(
    await toolDraftDigest(draft) === candidate.digest,
    "Les octets de l’artefact source ne correspondent plus à son digest admis.",
  );
  return structuredClone(draft);
}

export function reuseOrigin(input: ToolReuseImport): ArtifactReuseOrigin {
  return {
    ...(input.artifact.candidate.sourceBinding
      ? {
        sourceReference: structuredClone(
          input.artifact.candidate.sourceBinding.reference,
        ),
      }
      : {}),
    agentId: input.artifact.agentId,
    candidateId: input.artifact.candidate.id,
    digest: input.artifact.candidate.digest,
    correlationId: input.proof.invocationId,
    behaviorId: input.proof.behavior.id,
    sourceModelDigest: input.artifact.model.version.digest,
    sourceRepositoryVersion: input.artifact.model.version.repositoryVersion!,
  };
}

export function toolReuseReceipt(
  candidate: Candidate,
  replayed: boolean,
): ToolReuseReceipt {
  const origin = candidate.reusedFrom;
  requireValue(
    origin,
    "Le candidat ne possède pas de provenance de réutilisation.",
  );
  requireValue(
    candidate.digest === origin.digest,
    "Le candidat local ne conserve pas le digest de l’artefact réutilisé.",
  );
  return {
    source: {
      agentId: origin.agentId,
      candidateId: origin.candidateId,
      digest: origin.digest,
    },
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    stage: candidate.stage,
    active: candidate.stage === "active",
    testsPassed: candidate.tests?.passed ?? null,
    correlationId: origin.correlationId,
    replayed,
  };
}

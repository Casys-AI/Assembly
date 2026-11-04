import type { ArtifactEvidence } from "../conversation/chat-context.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";

/** Project recorded facts while keeping executable code and local continuations private. */
export function artifactEvidence(
  candidate: Candidate,
  observation: Pick<
    ArtifactEvidence,
    | "nativeStatus"
    | "nativeModelVersion"
    | "contentDigestMatches"
    | "activationConfirmed"
  >,
): ArtifactEvidence {
  const { id, name, kind, digest, stage, createdAt } = candidate;
  return structuredClone({
    id,
    name,
    kind,
    digest,
    localStage: stage,
    ...observation,
    createdAt,
    ...(candidate.tests ? { tests: candidate.tests } : {}),
    ...(candidate.review ? { review: candidate.review } : {}),
    ...(candidate.reviewExecution
      ? { reviewExecution: candidate.reviewExecution }
      : {}),
    ...(candidate.admissionDecision
      ? { admissionDecision: candidate.admissionDecision }
      : {}),
    ...(candidate.admission ? { admission: candidate.admission } : {}),
    ...(candidate.reusedFrom ? { reusedFrom: candidate.reusedFrom } : {}),
  });
}

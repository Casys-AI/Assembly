import type { Candidate } from "../../../domain/work/candidates.ts";
import {
  requireSource,
  validateSourceBindingReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import type { ArtifactSourceServicePort } from "./publication.ts";
import { toolDraftDigest } from "./catalog.ts";

/** Executable bytes always come from the exact retained target-local binding.
 * Candidate fields remain historical/presentation data, never a code fallback. */
export async function resolveCandidateSource(
  candidate: Candidate,
  ownerId: string,
  sources: ArtifactSourceServicePort | undefined,
): Promise<Candidate> {
  requireSource(sources && candidate.sourceBinding, "not-found");
  const binding = candidate.sourceBinding;
  validateSourceBindingReference(binding);
  requireSource(
    binding.ownerId === ownerId && binding.localArtifactId === candidate.id &&
      binding.reference.kind === "tool-draft" &&
      binding.reference.contentDigest === candidate.digest,
    "scope",
  );
  const draft = await sources.resolveTool({
    expectedBinding: binding,
    bindingId: binding.bindingId,
    ownerId,
    localArtifactId: candidate.id,
    expectedDigest: candidate.digest,
    reference: binding.reference,
  });
  requireSource(
    await toolDraftDigest(draft) === candidate.digest &&
      draft.name === candidate.name &&
      draft.description === candidate.description &&
      draft.kind === candidate.kind,
    "integrity",
  );
  return { ...structuredClone(candidate), ...draft };
}

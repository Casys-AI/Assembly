import { TOOL_KINDS } from "../../../domain/shared-kernel/tool-kind.ts";
import type { ToolDraft } from "../../../domain/work/candidates.ts";
import {
  requireSkillContent,
  skillContentDigest,
  SkillError,
} from "../../../domain/skills/context-skills.ts";
import { toolDraftDigest } from "../../../application/work/artifacts/catalog.ts";
import type { ArtifactSource } from "../../../domain/work/artifacts/source-publication.ts";
import {
  ArtifactSourceError,
  requireSource,
  sourceIdentity,
} from "../../../domain/work/artifacts/source-reference.ts";

export const MAX_ARTIFACT_CONTENT_BYTES = 1_048_576;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function artifactUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ArtifactSourceError("integrity");
  }
}
/** Reuses the original source encodings; manifest identity is separate. */
export async function encodeArtifactSource(
  source: ArtifactSource,
): Promise<{ text: string; digest: string }> {
  requireSource(sourceIdentity(source?.artifactId), "invalid");
  if (source.kind === "skill-document") {
    try {
      requireSkillContent(source.content, MAX_ARTIFACT_CONTENT_BYTES);
    } catch (error) {
      throw new ArtifactSourceError(
        error instanceof SkillError && error.code === "limit"
          ? "limit"
          : "invalid",
      );
    }
    requireSource(
      decoder.decode(encoder.encode(source.content)) === source.content,
      "invalid",
    );
    return {
      text: source.content,
      digest: await skillContentDigest(source.content),
    };
  }
  requireSource(
    source.kind === "tool-draft" && !!source.content &&
      typeof source.content === "object",
    "invalid",
  );
  const draft = source.content as ToolDraft;
  requireSource(
    [draft.name, draft.description, draft.code].every((value) =>
      typeof value === "string" &&
      decoder.decode(encoder.encode(value)) === value
    ) && TOOL_KINDS.includes(draft.kind),
    "invalid",
  );
  const text = JSON.stringify({
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    code: draft.code,
  });
  requireSource(
    encoder.encode(text).length <= MAX_ARTIFACT_CONTENT_BYTES,
    "limit",
  );
  return { text, digest: await toolDraftDigest(draft) };
}
export async function decodeArtifactSource(
  source: Omit<ArtifactSource, "content">,
  text: string,
  digest: string,
): Promise<ArtifactSource> {
  let parsed: ArtifactSource;
  try {
    parsed = source.kind === "skill-document"
      ? { artifactId: source.artifactId, kind: "skill-document", content: text }
      : {
        artifactId: source.artifactId,
        kind: "tool-draft",
        content: JSON.parse(text),
      };
  } catch {
    throw new ArtifactSourceError("integrity");
  }
  const checked = await encodeArtifactSource(parsed);
  requireSource(
    checked.text === text && checked.digest === digest,
    "integrity",
  );
  return parsed;
}

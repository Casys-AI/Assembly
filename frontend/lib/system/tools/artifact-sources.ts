import { signal } from "@preact/signals";
import { canonical } from "../../../../src/domain/primitives/canonical-json.ts";
import { toolDraftDigest } from "../../../../src/application/work/artifacts/catalog.ts";
import { skillContentDigest } from "../../../../src/domain/skills/context-skills.ts";
import {
  type ArtifactSourceBindingReference,
  validateSourceBindingReference,
} from "../../../../src/domain/work/artifacts/source-reference.ts";
import type {
  ArtifactSourceInspection,
  InspectedArtifactSource,
} from "../../../../src/domain/work/records/artifact-source-inspection.ts";
import type { ToolDraft } from "../../../../src/domain/work/records/candidates.ts";

export interface KnownArtifactSource {
  agentId: string;
  label: string;
  binding: ArtifactSourceBindingReference;
}
/** An explicit comparison pin lasts only for this mounted browser session. */
export const comparisonSource = signal<KnownArtifactSource | null>(null);

export function comparableSource(
  before: KnownArtifactSource | null,
  after: KnownArtifactSource,
): before is KnownArtifactSource {
  return !!before && before.agentId === after.agentId &&
    before.binding.ownerId === after.binding.ownerId &&
    before.binding.reference.repositoryId ===
      after.binding.reference.repositoryId &&
    before.binding.reference.scopeId === after.binding.reference.scopeId &&
    before.binding.reference.kind === after.binding.reference.kind &&
    canonical(before.binding) !== canonical(after.binding);
}
const failure = () =>
  new Error(
    "The exact retained source is unavailable. Read again or choose another known version.",
  );
export function sourceText(source: InspectedArtifactSource): string {
  return typeof source.content === "string"
    ? source.content
    : JSON.stringify(source.content, null, 2) + "\n";
}

/** Only exact records already observed by the user can be sent. Responses are
 * checked against the complete captured identities and original content digests. */
export async function readArtifactSources(
  agentId: string,
  bindings: readonly ArtifactSourceBindingReference[],
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<ArtifactSourceInspection> {
  const captured = structuredClone(bindings);
  if (captured.length < 1 || captured.length > 2) throw failure();
  for (const binding of captured) validateSourceBindingReference(binding);
  const response = await request(
    `/api/conversations/${encodeURIComponent(agentId)}/artifact-sources/read`,
    {
      method: "POST",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bindings: captured }),
    },
  );
  if (!response.ok) throw failure();
  const result = await response.json() as ArtifactSourceInspection;
  if (
    !result || !Array.isArray(result.sources) ||
    result.sources.length !== captured.length ||
    (captured.length === 2 && typeof result.patch !== "string") ||
    (captured.length === 1 && result.patch !== undefined)
  ) throw failure();
  for (let index = 0; index < captured.length; index++) {
    const source = result.sources[index]!, binding = captured[index]!;
    if (!source || canonical(source.binding) !== canonical(binding)) {
      throw failure();
    }
    let digest: string;
    if (binding.reference.kind === "skill-document") {
      if (typeof source.content !== "string") throw failure();
      digest = await skillContentDigest(source.content);
    } else {
      const draft = source.content as ToolDraft;
      if (
        !draft || typeof draft !== "object" || typeof draft.name !== "string" ||
        typeof draft.description !== "string" ||
        typeof draft.code !== "string" ||
        Object.keys(draft).length !== 4 ||
        !["read_web_page", "read_web_page_outline"].includes(draft.kind)
      ) throw failure();
      digest = await toolDraftDigest(draft);
    }
    if (digest !== binding.reference.contentDigest) throw failure();
  }
  return result;
}

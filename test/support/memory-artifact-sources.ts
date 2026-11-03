import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";
import { skillContentDigest } from "../../src/domain/skills/context-skills.ts";
import type {
  ArtifactSourceServicePort,
  BoundArtifactSource,
} from "../../src/application/work/artifacts/publication.ts";

/** Test-only retained artifact sources. Exact invocation/digest bindings are
 * verified like the real service boundary, but nothing is retained in Git or
 * PostgreSQL; this double never qualifies durable source retention. */
export function createMemoryArtifactSources(): ArtifactSourceServicePort {
  const retained = new Map<string, {
    binding: BoundArtifactSource;
    tool?: Awaited<ReturnType<ArtifactSourceServicePort["resolveTool"]>>;
    skill?: string;
  }>();
  async function bind(
    input: {
      artifactId: string;
      ownerId: string;
      localArtifactId: string;
      invocationId: string;
      expectedDigest: string;
    },
    kind: "tool-draft" | "skill-document",
  ): Promise<BoundArtifactSource> {
    const key = await executionDigest({
      ownerId: input.ownerId,
      invocationId: input.invocationId,
    });
    const manifestDigest = await executionDigest({
      artifactId: input.artifactId,
      digest: input.expectedDigest,
      kind,
    });
    const binding: BoundArtifactSource = {
      version: 1,
      bindingId: `source-binding:${key}`,
      versionId: `source-version:${manifestDigest}`,
      revision: 1,
      ownerId: input.ownerId,
      localArtifactId: input.localArtifactId,
      invocationId: input.invocationId,
      reference: {
        version: 2,
        scopeId: "memory-source-scope",
        repositoryId: "memory-source-repository",
        artifactId: input.artifactId,
        kind,
        commitOid: "a".repeat(40),
        entryPath: `artifacts/${manifestDigest}/${
          kind === "tool-draft" ? "source.json" : "SKILL.md"
        }`,
        manifestPath: `artifacts/${manifestDigest}/manifest.json`,
        contentEncoding: kind === "tool-draft"
          ? "tool-draft-json-v1"
          : "utf8-v1",
        contentDigest: input.expectedDigest,
        manifestFormat: "assembly-artifact-package-v2",
        manifestDigestVersion: "sha256-canonical-json-v1",
        manifestDigest,
      },
    };
    const previous = retained.get(binding.bindingId);
    if (previous && canonical(previous.binding) !== canonical(binding)) {
      throw new Error(
        "Memory artifact source conflict for the exact invocation",
      );
    }
    return binding;
  }
  function resolve(
    selection: Parameters<ArtifactSourceServicePort["resolveTool"]>[0],
    kind: "tool-draft" | "skill-document",
  ) {
    const record = retained.get(selection.bindingId);
    if (
      !record || record.binding.reference.kind !== kind ||
      record.binding.ownerId !== selection.ownerId ||
      record.binding.localArtifactId !== selection.localArtifactId ||
      record.binding.reference.contentDigest !== selection.expectedDigest ||
      canonical(record.binding.reference) !== canonical(selection.reference) ||
      canonical(record.binding) !== canonical(selection.expectedBinding)
    ) throw new Error("Retained memory artifact source is unavailable");
    return record;
  }
  return {
    async publishTool(input) {
      if (await toolDraftDigest(input.draft) !== input.expectedDigest) {
        throw new Error(
          "Memory tool draft digest does not match its publication",
        );
      }
      const binding = await bind(input, "tool-draft");
      const previous = retained.get(binding.bindingId);
      if (
        previous?.tool && canonical(previous.tool) !== canonical(input.draft)
      ) {
        throw new Error(
          "Memory artifact source conflict for the exact invocation",
        );
      }
      retained.set(binding.bindingId, {
        binding: structuredClone(binding),
        tool: structuredClone(input.draft),
      });
      return structuredClone(binding);
    },
    async publishSkill(input) {
      if (await skillContentDigest(input.content) !== input.expectedDigest) {
        throw new Error("Memory skill digest does not match its publication");
      }
      const binding = await bind(input, "skill-document");
      const previous = retained.get(binding.bindingId);
      if (previous?.skill !== undefined && previous.skill !== input.content) {
        throw new Error(
          "Memory artifact source conflict for the exact invocation",
        );
      }
      retained.set(binding.bindingId, {
        binding: structuredClone(binding),
        skill: input.content,
      });
      return structuredClone(binding);
    },
    resolveTool: (selection) =>
      Promise.resolve(structuredClone(resolve(selection, "tool-draft").tool!)),
    resolveSkill: (selection) =>
      Promise.resolve(resolve(selection, "skill-document").skill!),
  };
}

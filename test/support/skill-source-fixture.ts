import assert from "node:assert/strict";
import type { ContextSkillsPorts } from "../../src/application/skills/ports.ts";
import type {
  ArtifactSourceSelection,
  SkillArtifactSourcePublication,
} from "../../src/application/work/artifacts/publication.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  requireSkillAuthority,
  skillContentDigest,
} from "../../src/domain/skills/context-skills.ts";
import type { ArtifactSourceBindingReference } from "../../src/domain/work/artifacts/source-reference.ts";

/** Explicit unit-boundary double, not Git/SQL qualification. Documents are
 * resolved by their retained binding only, never by the installed inline copy. */
export function skillSourceFixture() {
  const retained = new Map<
    string,
    { binding: ArtifactSourceBindingReference; content: string }
  >();
  const publications: SkillArtifactSourcePublication[] = [];
  const resolutions: ArtifactSourceSelection[] = [];
  let unavailable = false;
  let replacement: string | undefined;
  let afterPublication: (() => void) | undefined;
  const ports: Pick<
    ContextSkillsPorts,
    "artifactSources" | "assertCurrentAuthority"
  > = {
    assertCurrentAuthority: (authority, permission) => {
      requireSkillAuthority(authority, permission);
      return Promise.resolve();
    },
    artifactSources: (ownerId) =>
      Promise.resolve({
        async publishSkill(input: SkillArtifactSourcePublication) {
          assert.equal(input.ownerId, ownerId);
          assert.equal(
            await skillContentDigest(input.content),
            input.expectedDigest,
          );
          const key = await executionDigest({
            ownerId,
            invocationId: input.invocationId,
          });
          const manifestDigest = await executionDigest({
            artifactId: input.artifactId,
            digest: input.expectedDigest,
          });
          const binding: ArtifactSourceBindingReference = {
            version: 1,
            bindingId: `source-binding:${key}`,
            versionId: `source-version:${manifestDigest}`,
            revision: 1,
            ownerId,
            localArtifactId: input.localArtifactId,
            invocationId: input.invocationId,
            reference: {
              version: 2,
              scopeId: "unit-source-scope",
              repositoryId: "unit-source-repository",
              artifactId: input.artifactId,
              kind: "skill-document",
              commitOid: "a".repeat(40),
              entryPath: `artifacts/${manifestDigest}/SKILL.md`,
              manifestPath: `artifacts/${manifestDigest}/manifest.json`,
              contentEncoding: "utf8-v1",
              contentDigest: input.expectedDigest,
              manifestFormat: "assembly-artifact-package-v2",
              manifestDigestVersion: "sha256-canonical-json-v1",
              manifestDigest,
            },
          };
          const previous = retained.get(binding.bindingId);
          if (previous) {
            assert.equal(previous.content, input.content);
            assert.equal(canonical(previous.binding), canonical(binding));
          } else {retained.set(binding.bindingId, {
              binding: structuredClone(binding),
              content: input.content,
            });}
          publications.push(structuredClone(input));
          afterPublication?.();
          return structuredClone(binding);
        },
        resolveSkill(selection: ArtifactSourceSelection) {
          resolutions.push(structuredClone(selection));
          if (unavailable) {
            return Promise.reject(new Error("Retained source unavailable"));
          }
          const record = retained.get(selection.bindingId);
          assert(record);
          assert.equal(selection.ownerId, ownerId);
          assert.equal(record.binding.ownerId, ownerId);
          assert.equal(
            record.binding.localArtifactId,
            selection.localArtifactId,
          );
          assert.equal(
            record.binding.reference.contentDigest,
            selection.expectedDigest,
          );
          assert.equal(
            canonical(record.binding.reference),
            canonical(selection.reference),
          );
          assert.equal(
            canonical(record.binding),
            canonical(selection.expectedBinding),
          );
          return Promise.resolve(replacement ?? record.content);
        },
      }),
  };
  return {
    ports,
    retained,
    publications,
    resolutions,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    replaceResolvedContent(value: string | undefined) {
      replacement = value;
    },
    afterPublication(callback: () => void) {
      afterPublication = callback;
    },
  };
}

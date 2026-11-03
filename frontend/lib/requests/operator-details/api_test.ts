import { deepStrictEqual, throws } from "node:assert/strict";
import type { RequestOperatorDetailsSnapshot } from "../../../../src/application/work/request-spaces/operator-details-view.ts";
import { parseModelRevisionId } from "../../../../src/domain/shared-kernel/revision-id.ts";
import { parseRequestOperatorDetails } from "./api.ts";

function fixture(): RequestOperatorDetailsSnapshot {
  const digest = "e".repeat(64), manifest = "b".repeat(64);
  return {
    caseId: "case-a",
    executionSpaceId: "space-a",
    operatorId: "native:owner",
    observedSource: {
      source: {
        repositoryId: "repo",
        version: parseModelRevisionId(`commit:${"c".repeat(40)}`),
      },
      modelDigest: "d".repeat(64),
      sourceAdmission: { revision: 1, manifestDigest: manifest },
      adoption: null,
    },
    runtimeRevision: 4,
    tools: [{
      id: "tool",
      name: "Tool",
      description: "Retained",
      digest,
      sourceBinding: {
        version: 1,
        bindingId: "binding",
        versionId: "version",
        revision: 1,
        ownerId: "native:owner",
        localArtifactId: "tool",
        invocationId: "invocation",
        reference: {
          version: 2,
          scopeId: "scope",
          repositoryId: "repo",
          artifactId: "artifact",
          kind: "tool-draft",
          commitOid: "a".repeat(40),
          entryPath: `artifacts/${manifest}/source.json`,
          manifestPath: `artifacts/${manifest}/manifest.json`,
          contentEncoding: "tool-draft-json-v1",
          contentDigest: digest,
          manifestFormat: "assembly-artifact-package-v2",
          manifestDigestVersion: "sha256-canonical-json-v1",
          manifestDigest: manifest,
        },
      },
    }],
    skills: {
      status: "available",
      revision: 1,
      items: [{
        id: "skill",
        name: "Installed",
        description: "Guidance",
        digest,
        loaded: true,
      }],
    },
  };
}
Deno.test("Request details boundary reconstructs only validated rendered fields and exact scope", () => {
  const value = fixture(),
    expected = {
      caseId: value.caseId,
      operatorId: value.operatorId,
      modelDigest: value.observedSource.modelDigest,
      version: value.observedSource.source.version,
      executionSpaceId: value.executionSpaceId,
    };
  deepStrictEqual(
    parseRequestOperatorDetails(
      { ...value, ignored: "not projected" },
      expected,
    ),
    value,
  );
  deepStrictEqual(
    parseRequestOperatorDetails({
      ...value,
      skills: { status: "unavailable", reason: "No persisted store" },
    }, expected).skills,
    { status: "unavailable", reason: "No persisted store" },
  );
});
Deno.test("Request details boundary refuses malformed successful payloads before rendering or source selection", () => {
  const value = fixture(),
    tool = value.tools[0],
    skill = value.skills.status === "available"
      ? value.skills.items[0]
      : undefined;
  const expected = {
    caseId: value.caseId,
    operatorId: value.operatorId,
    modelDigest: value.observedSource.modelDigest,
    version: value.observedSource.source.version,
    executionSpaceId: value.executionSpaceId,
  };
  const malformed: unknown[] = [
    null,
    {},
    { ...value, caseId: "other" },
    { ...value, operatorId: "other" },
    { ...value, executionSpaceId: "main" },
    { ...value, executionSpaceId: "space-b" },
    { ...value, runtimeRevision: -1 },
    {
      ...value,
      observedSource: {
        ...value.observedSource,
        source: { repositoryId: "repo", version: "main" },
      },
    },
    {
      ...value,
      observedSource: { ...value.observedSource, modelDigest: "bad" },
    },
    {
      ...value,
      observedSource: {
        ...value.observedSource,
        sourceAdmission: { revision: "1", manifestDigest: "b".repeat(64) },
      },
    },
    {
      ...value,
      observedSource: {
        ...value.observedSource,
        adoption: { commandId: "change" },
      },
    },
    { ...value, tools: [null] },
    { ...value, tools: [tool, tool] },
    { ...value, tools: [{ ...tool, name: {} }] },
    { ...value, tools: [{ ...tool, description: null }] },
    { ...value, tools: [{ ...tool, digest: "bad" }] },
    { ...value, tools: [{ ...tool, sourceBinding: {} }] },
    {
      ...value,
      tools: [{
        ...tool,
        sourceBinding: { ...tool.sourceBinding, ownerId: "foreign" },
      }],
    },
    {
      ...value,
      tools: [{
        ...tool,
        sourceBinding: {
          ...tool.sourceBinding,
          reference: {
            ...tool.sourceBinding.reference,
            contentDigest: "f".repeat(64),
          },
        },
      }],
    },
    { ...value, skills: { status: "available", revision: 1 } },
    { ...value, skills: { status: "available", revision: 1, items: {} } },
    { ...value, skills: { status: "available", revision: 1, items: [null] } },
    ...[
      { ...skill, loaded: "yes" },
      { ...skill, name: 5 },
      { ...skill, description: null },
      { ...skill, digest: "bad" },
      { ...skill, sourceBinding: tool.sourceBinding },
    ].map((item) => ({
      ...value,
      skills: { status: "available", revision: 1, items: [item] },
    })),
    { ...value, skills: { status: "unavailable", reason: {} } },
  ];
  for (const candidate of malformed) {
    throws(() => parseRequestOperatorDetails(candidate, expected));
  }
});

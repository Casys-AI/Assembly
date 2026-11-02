import type { ModelPort } from "../../src/application/work/runtime/ports.ts";

function unexpectedAuthoring(): never {
  throw Object.assign(new Error("Unexpected model authoring in this fixture"), {
    code: "TEST_MODEL_AUTHORING",
  });
}

/** Required authoring methods for fixtures that must never prepare or edit sources. */
export const unexpectedModelAuthoring: Pick<
  ModelPort,
  "previewApprovedChange" | "proposeEdit"
> = {
  previewApprovedChange: unexpectedAuthoring,
  proposeEdit: unexpectedAuthoring,
};

/** Explicit empty source diff for governance-only fixtures; never compiles SysML. */
export const emptyChangePreview: ModelPort["previewApprovedChange"] = (
  identity,
  change,
  expectedDigest,
) =>
  Promise.resolve({
    title: change.reason,
    author: identity.builderId,
    base: {
      repositoryVersion: "fixture:source-base",
      modelDigest: expectedDigest,
      sourceDigest: "fixture:source-digest",
    },
    sourceDigest: "fixture:source-digest",
    files: [],
    patch: "",
    additions: 0,
    deletions: 0,
  });

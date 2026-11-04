import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { ModelRepositoryError } from "../../model/repository.ts";
import { createOperatorEditAuthorization } from "./operator-edit-authorization.ts";

Deno.test("operator source edits require an explicit current edit policy", async () => {
  const model = artifactModel("actor");
  model.policy.mayProposeSysmlRevision = true;
  delete model.modelEditPolicy;
  await assert.rejects(
    createOperatorEditAuthorization(
      model,
      { version: "base", sources: {}, elements: [] },
      ["replace-source"],
    ),
    (error) =>
      error instanceof ModelRepositoryError &&
      error.code === "EDIT_SCOPE_DENIED",
  );
});

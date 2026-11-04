import assert from "node:assert/strict";
import { artifactModel } from "../../../../../test/support/tool-artifact-fixture.ts";
import { ModelRepositoryError } from "../../../model/repository.ts";
import { prepareModelAdministration } from "./operations.ts";

Deno.test("model administration requires the current administration mandate before revoking a delegation", async () => {
  const model = artifactModel("actor");
  delete model.modelAdministration;
  await assert.rejects(
    prepareModelAdministration(
      { version: "base", sources: {}, elements: [] },
      model.identity.projectId,
      model,
      { kind: "revoke", id: "delegation" },
      {
        compile: () => {
          throw new Error("Compilation must follow the mandate check");
        },
      },
    ),
    (error) =>
      error instanceof ModelRepositoryError &&
      error.code === "EDIT_SCOPE_DENIED",
  );
});

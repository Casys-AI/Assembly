import assert from "node:assert/strict";
import { validateEvolutionSourceAuthorization } from "./source-authorization.ts";

Deno.test("evolution admission refuses a missing separate evolution principal before compiling sources", async () => {
  const revision = {
    version: "base",
    sources: {},
    elements: [],
    documents: [],
    sourceDigest: "source",
    semanticDigest: "semantic",
    provenanceDigest: "provenance",
    sourceHashes: {},
    engineVersion: "test",
  };
  await assert.rejects(
    validateEvolutionSourceAuthorization(
      {
        authority: revision,
        before: revision,
        after: revision,
        author: "agent:actor",
        phase: "proposal",
      },
      "git:repository",
      {
        compile: () => {
          throw new Error("Compilation must follow principal validation");
        },
      },
    ),
    { message: "Missing separate evolution source authority" },
  );
});

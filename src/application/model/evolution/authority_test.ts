import { sourceEvolutionCompilation } from "../../../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import assert from "node:assert/strict";
import { NativeEvolutionAuthority } from "./authority.ts";

Deno.test("evolution authority refuses an unavailable proposal base before reading current rights", async () => {
  const unavailable = new Error("historical base unavailable");
  const reads: string[] = [];
  const authority = new NativeEvolutionAuthority({
    compilation: sourceEvolutionCompilation,
    projectId: "git:repository",
    repository: {
      at: (version) => {
        reads.push(version);
        return Promise.reject(unavailable);
      },
      current: () => {
        reads.push("current");
        throw new Error("Current authority must not authorize a missing base");
      },
    },
  });
  await assert.rejects(
    authority.authorize("accept", "actor", {
      id: "proposal",
      baseVersion: "base",
      version: "candidate",
      sourceDigest: "source",
      recipeDigest: "recipe",
      digest: "proposal-digest",
      targets: [],
      categories: [],
    }),
    (error) => error === unavailable,
  );
  assert.deepEqual(reads, ["base"]);
});

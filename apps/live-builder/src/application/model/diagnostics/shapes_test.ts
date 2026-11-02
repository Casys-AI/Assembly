import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { ModelDiagnostic } from "../../../domain/model/policies/diagnostics.ts";
import {
  compareDiagnostics,
  createShaclReportIdentity,
  ModelShapesError,
  shaclReportStoreVersion,
} from "./shapes.ts";

const digest = (char: string) => char.repeat(64);

Deno.test("report identity keys A, shapes, facts projector, engine and options", async () => {
  const identity = await createShaclReportIdentity({
    artifactDigest: digest("4"),
    shapesDigest: digest("5"),
    factsProjectorVersion: "ase-diagnostic-facts-v1",
    engineId: "rdf-validate-shacl",
    engineVersion: "0.6.0",
  });
  const version = shaclReportStoreVersion(identity);
  equal(version.includes("rdf-validate-shacl:0.6.0"), true);
  equal(version.includes(digest("5")), true);
  // Options change the identity without touching A or the shapes.
  const strict = await createShaclReportIdentity({
    artifactDigest: digest("4"),
    shapesDigest: digest("5"),
    factsProjectorVersion: "ase-diagnostic-facts-v1",
    engineId: "rdf-validate-shacl",
    engineVersion: "0.6.0",
    options: { strictUnmapped: true },
  });
  equal(strict.optionsDigest === identity.optionsDigest, false);
  await rejects(
    () =>
      createShaclReportIdentity({
        artifactDigest: "not-a-digest",
        shapesDigest: digest("5"),
        factsProjectorVersion: "v1",
        engineId: "e",
        engineVersion: "1",
      }),
    (error: unknown) =>
      error instanceof ModelShapesError &&
      error.code === "SHAPES_INVALID_INPUT",
  );
});

const loop = (overrides: Partial<ModelDiagnostic> = {}): ModelDiagnostic => ({
  code: "LOOP_WITHOUT_BUDGET",
  elementId: "unit-1",
  qualifiedName: "Sys::unit",
  severity: "warning",
  finding: "absent",
  message: "Conversation unit has no invocation budget policy.",
  remedy: { kind: "revision-template", template: "work-budget" },
  source: { file: "model.sysml", line: 2, column: 3 },
  ...overrides,
});
const capability: ModelDiagnostic = {
  code: "CAPABILITY_BEYOND_MANDATE",
  elementId: "policy-1",
  severity: "warning",
  finding: "present",
  message:
    "SkillPolicy allows hosts outside the network mandate: evil.example.",
};

Deno.test("comparison proves equality or names every divergence", () => {
  deepStrictEqual(
    compareDiagnostics({
      shacl: [loop(), capability],
      reference: [capability, loop()],
    }),
    {
      equal: true,
      matched: 2,
      onlyShacl: [],
      onlyReference: [],
      mismatched: [],
    },
  );
  const diverged = compareDiagnostics({
    shacl: [loop({ message: "different wording" })],
    reference: [loop(), capability],
  });
  equal(diverged.equal, false);
  equal(diverged.onlyReference.length, 1);
  equal(diverged.mismatched.length, 1);
  equal(diverged.mismatched[0]?.field, "message");
  // Restricting to claimed codes ignores unclaimed rules on both sides.
  equal(
    compareDiagnostics({
      shacl: [loop()],
      reference: [loop(), capability],
      codes: ["LOOP_WITHOUT_BUDGET"],
    }).equal,
    true,
  );
});

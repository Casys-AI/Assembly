import assert from "node:assert/strict";
import {
  activationFailure,
  CandidateActivationError,
  hasActivationIntent,
  requireActivation,
} from "./candidate-activation.ts";
import { ChangePublicationError } from "../../model/publication/change.ts";
import { HostEditError } from "../../model/editing/host-edit.ts";

const context = { changeId: "change", systemId: "system" };
const target = { qualifiedName: "System::catalog" };

Deno.test("only an admitted activating candidate holds an activation intent", () => {
  assert.equal(
    hasActivationIntent({ stage: "activating", activationModelDigest: "d" }),
    true,
  );
  assert.equal(hasActivationIntent({ stage: "activating" }), false);
  assert.equal(
    hasActivationIntent({ stage: "activating", activationModelDigest: "" }),
    false,
  );
  for (
    const stage of [
      "proposed",
      "testing",
      "reviewing",
      "awaiting-admission",
      "refused",
      "active",
      "failed",
    ] as const
  ) {
    assert.equal(
      hasActivationIntent({ stage, activationModelDigest: "d" }),
      false,
      stage,
    );
  }
});

Deno.test("activation failures are classified as transient or terminal after the intent", () => {
  const refusal = new CandidateActivationError(
    "ADMITTED_MODEL_CHANGED",
    { candidateId: "c" },
    "drift",
  );
  assert.deepEqual(activationFailure(refusal), {
    code: "ADMITTED_MODEL_CHANGED",
    terminal: true,
  });
  assert.equal(refusal.recovery, "refuse");
  // Only an explicitly transient publication failure is retryable.
  assert.deepEqual(
    activationFailure(
      new ChangePublicationError("PUBLICATION_FAILED", context, "io"),
    ),
    { code: "PUBLICATION_FAILED", terminal: false },
  );
  for (
    const code of [
      "PUBLICATION_NOT_APPLICABLE",
      "PUBLICATION_RECEIPT_TOO_LARGE",
      "PUBLICATION_RECEIPT_MISMATCH",
      "PUBLICATION_RECEIPT_MISSING",
      "PUBLICATION_ALREADY_APPLIED",
    ] as const
  ) {
    assert.deepEqual(
      activationFailure(new ChangePublicationError(code, context, "refused")),
      { code, terminal: true },
      code,
    );
  }
  const edit = (code: ConstructorParameters<typeof HostEditError>[0]) =>
    new HostEditError(code, { opIndex: 0, op: "insertMember", target }, "edit");
  assert.deepEqual(activationFailure(edit("TOOLKIT_REFUSED")), {
    code: "TOOLKIT_REFUSED",
    terminal: true,
  });
  // A reload recovery means the base moved: a new attempt reads the new base.
  assert.deepEqual(activationFailure(edit("TARGET_MODIFIED")), {
    code: "TARGET_MODIFIED",
    terminal: false,
  });
  // Anything unclassified stays retryable but bounded by the attempt limit.
  assert.deepEqual(activationFailure(new Error("socket hang up")), {
    code: "ACTIVATION_INTERRUPTED",
    terminal: false,
  });
  assert.deepEqual(activationFailure("not an error"), {
    code: "ACTIVATION_INTERRUPTED",
    terminal: false,
  });
});

Deno.test("requireActivation refuses with a code, its context and a recovery", () => {
  assert.doesNotThrow(() =>
    requireActivation(true, "ADMISSION_MISSING", { candidateId: "c" }, "m")
  );
  assert.throws(
    () =>
      requireActivation(
        undefined,
        "TESTS_NOT_PASSED",
        { candidateId: "c", count: 2 },
        "no tests",
      ),
    (error: unknown) =>
      error instanceof CandidateActivationError &&
      error.code === "TESTS_NOT_PASSED" && error.recovery === "refuse" &&
      error.context.candidateId === "c" && error.context.count === 2 &&
      error.message === "no tests",
  );
});

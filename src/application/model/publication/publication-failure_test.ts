import assert from "node:assert/strict";
import { publicationFailure } from "./publication-failure.ts";
import { HostEditError } from "../../../domain/model/editing/host-edit.ts";

Deno.test("publication failure preserves a host Toolkit refusal with a retry fallback", () => {
  const error = new HostEditError("TOOLKIT_REFUSED", {
    opIndex: -1,
    op: "setFeatureValue",
    target: { qualifiedName: "LiveBuilder::system" },
  }, "Host scalar writes require the Toolkit");
  const failure = publicationFailure(error, { changeId: "refused" }, "retry");
  assert.equal(failure.code, "PUBLICATION_NOT_APPLICABLE");
  assert.equal(failure.recovery, "refuse");
});

Deno.test("publication failure keeps an unavailable Toolkit worker retryable", () => {
  const error = Object.assign(new Error("Worker unavailable"), {
    code: "TOOLKIT_WORKER_UNAVAILABLE",
  });
  const failure = publicationFailure(
    error,
    { changeId: "unavailable" },
    "refuse",
  );
  assert.equal(failure.code, "PUBLICATION_FAILED");
  assert.equal(failure.recovery, "retry");
});

for (const name of ["SysmlToolkitTimeoutError", "TimedOut"]) {
  Deno.test(`publication failure keeps ${name} retryable`, () => {
    const error = new Error("Toolkit timeout");
    error.name = name;
    const failure = publicationFailure(
      error,
      { changeId: "timeout" },
      "refuse",
    );
    assert.equal(failure.code, "PUBLICATION_FAILED");
    assert.equal(failure.recovery, "retry");
  });
}

Deno.test("durable writer decision and scope refusals cannot become automatic retries", () => {
  for (const code of ["NEEDS_DECISION", "REFUSED", "WRITE_QUEUE_CONFLICT"]) {
    const error = Object.assign(new Error("Explicit decision required"), {
      code,
    });
    const failure = publicationFailure(error, { changeId: "change" }, "retry");
    assert.equal(failure.code, "PUBLICATION_NOT_APPLICABLE");
    assert.equal(failure.recovery, "refuse");
  }
});

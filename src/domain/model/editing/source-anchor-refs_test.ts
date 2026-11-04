import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
  scopedSoftwareSourceAdmissionRef,
  scopedSoftwareSourceCommandRef,
} from "./source-anchor-refs.ts";
import { ModelWriteCommandError } from "./write-command-error.ts";

// Characterization (R14 C0): these strings are persisted Git anchor refs.
// Pins the exact derivations and refusals before the B10 rename.

const HASH = "0123456789abcdef0123456789abcdef01234567";
const VERSION = `commit:${HASH}`;
const PROPOSAL = "123e4567-e89b-42d3-a456-426614174000";

function refused(fn: () => unknown): ModelWriteCommandError {
  try {
    fn();
  } catch (error) {
    ok(error instanceof ModelWriteCommandError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

Deno.test("command refs keep the write-commands namespace", () => {
  equal(requestSourceCommandRef("a"), "refs/ase/write-commands/a");
  equal(
    requestSourceCommandRef("Cmd_1.2-x"),
    "refs/ase/write-commands/Cmd_1.2-x",
  );
  equal(
    requestSourceCommandRef("x".repeat(128)),
    `refs/ase/write-commands/${"x".repeat(128)}`,
  );
  equal(
    requestSourceCommandRef("a.lock.b"),
    "refs/ase/write-commands/a.lock.b",
  );
});

Deno.test("malformed command ids are refused as invalid anchors", () => {
  for (
    const commandId of [
      "",
      "x".repeat(129),
      "-lead",
      ".lead",
      "_lead",
      "a..b",
      "end.",
      "end.lock",
      "a/b",
      "a b",
      "a:b",
    ]
  ) {
    const error = refused(() => requestSourceCommandRef(commandId));
    equal(error.name, "ModelWriteCommandError", commandId);
    equal(error.code, "WRITE_COMMAND_INVALID", commandId);
    equal(error.recovery, "refuse", commandId);
    equal(error.message, "Invalid write command anchor", commandId);
    deepStrictEqual(error.context, {
      reason: "Invalid write command anchor",
      path: "commandId",
    });
  }
});

Deno.test("admission refs bind the proposal to the bare commit hash", () => {
  equal(
    requestSourceAdmissionRef(PROPOSAL, VERSION),
    `refs/ase/admissions/${PROPOSAL}/${HASH}`,
  );
  // Only the character class and length are checked, not UUID structure.
  equal(
    requestSourceAdmissionRef("a".repeat(36), VERSION),
    `refs/ase/admissions/${"a".repeat(36)}/${HASH}`,
  );
});

Deno.test("malformed proposal ids are refused as invalid anchors", () => {
  for (
    const proposalId of [
      "",
      PROPOSAL.toUpperCase(),
      PROPOSAL.slice(1),
      PROPOSAL + "0",
      "g".repeat(36),
    ]
  ) {
    const error = refused(() => requestSourceAdmissionRef(proposalId, VERSION));
    equal(error.code, "WRITE_COMMAND_INVALID", proposalId);
    equal(error.message, "Invalid proposal admission anchor", proposalId);
    deepStrictEqual(error.context, {
      reason: "Invalid proposal admission anchor",
      path: "proposalId",
    });
  }
});

Deno.test("a non-commit version fails with the revision identity error", () => {
  for (
    const version of [
      "branch:main",
      HASH,
      `commit:${HASH.toUpperCase()}`,
      "commit:abc",
      "",
    ]
  ) {
    let error: unknown;
    try {
      requestSourceAdmissionRef(PROPOSAL, version);
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof Error, version);
    ok(!(error instanceof ModelWriteCommandError), version);
    equal(
      (error as Error).message,
      "Expected an immutable model commit identity",
      version,
    );
  }
});

Deno.test("scoped software refs only swap the namespace prefix", () => {
  equal(
    scopedSoftwareSourceCommandRef("cmd-1"),
    "refs/ase/software-evolution/write-commands/cmd-1",
  );
  equal(
    scopedSoftwareSourceAdmissionRef(PROPOSAL, VERSION),
    `refs/ase/software-evolution/admissions/${PROPOSAL}/${HASH}`,
  );

  const command = refused(() => scopedSoftwareSourceCommandRef("a/b"));
  equal(command.message, "Invalid write command anchor");
  // The admission variant validates its first argument as a proposal id.
  const admission = refused(() =>
    scopedSoftwareSourceAdmissionRef("cmd-1", VERSION)
  );
  equal(admission.message, "Invalid proposal admission anchor");
  deepStrictEqual(admission.context, {
    reason: "Invalid proposal admission anchor",
    path: "proposalId",
  });
});

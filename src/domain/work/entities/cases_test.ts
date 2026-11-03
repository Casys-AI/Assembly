import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { assertCasesState, type Case, closeCase, openCase } from "./cases.ts";
import { CaseError } from "../errors/case.ts";

function input(): Omit<Case, "status" | "closedAt"> {
  return {
    id: "session:case:1",
    number: 1,
    type: "request",
    objective: "Répondre à la demande",
    owner: "operator",
    openedBy: "operator",
    openedFrom: { conversationId: "session", messageId: "message" },
    modelPin: { digest: "executable-1", repositoryVersion: "source-1" },
    budget: { budgetId: "budget", scopeId: "legacy-scope" },
    createdAt: "2026-10-24T01:00:00.000Z",
  };
}

Deno.test("Case identity, origin and birth pin are copied without adding authority", () => {
  const source = input();
  const record = openCase(source);
  source.modelPin.digest = "mutated";
  source.openedFrom.messageId = "mutated";
  equal(record.modelPin.digest, "executable-1");
  equal(record.openedFrom.messageId, "message");
  equal(record.status, "open");
  deepStrictEqual(
    Object.keys(record).sort(),
    [...Object.keys(source), "status"].sort(),
  );
  assertCasesState({
    cases: [record],
    caseInvocation: { kind: "local", caseId: record.id },
  });
});

Deno.test("Job and Watch cannot be opened without an admitted scheduled native type", () => {
  for (const type of ["job", "watch"] as const) {
    throws(
      () => openCase({ ...input(), type }),
      (error: unknown) =>
        error instanceof CaseError && error.code === "INVALID_CASE",
    );
  }
});

Deno.test("Case closure requires an explicit outcome and a nonretroactive clock value", () => {
  const record = openCase(input());
  const done = closeCase(record, "done", "2026-10-24T02:00:00.000Z");
  equal(record.status, "open");
  equal(done.status, "closed-done");
  equal(done.closedAt, "2026-10-24T02:00:00.000Z");
  deepStrictEqual(done.modelPin, record.modelPin);
  equal(
    closeCase(record, "abandoned", record.createdAt).status,
    "closed-abandoned",
  );
  throws(() => closeCase(done, "done", done.closedAt!), {
    code: "CASE_CLOSED",
  });
  throws(() => closeCase(record, "done", "2026-10-23T00:00:00.000Z"), {
    code: "INVALID_CASE",
  });
});

Deno.test("Case state accepts legacy absence and rejects duplicate or dangling identities", () => {
  assertCasesState({});
  assertCasesState({ cases: [] });
  const record = openCase(input());
  assertCasesState({ cases: [record] });
  throws(
    () =>
      assertCasesState({
        cases: [record, record],
        caseInvocation: { kind: "local", caseId: record.id },
      }),
    { code: "INVALID_CASE" },
  );
  throws(
    () =>
      assertCasesState({
        cases: [],
        caseInvocation: { kind: "local", caseId: record.id },
      }),
    {
      code: "INVALID_CASE",
    },
  );
});

Deno.test("designer selection requires a matching durable identity and cannot mix delegated Case scopes", () => {
  const designer = {
    scopeId: "session:designer",
    budget: { budgetId: "budget", scopeId: "session:designer" },
  };
  assertCasesState({
    cases: [],
    designer,
    caseInvocation: { kind: "designer", scopeId: designer.scopeId },
  });
  throws(
    () =>
      assertCasesState({
        cases: [],
        caseInvocation: { kind: "designer", scopeId: designer.scopeId },
      }),
    { code: "INVALID_CASE" },
  );
  throws(
    () =>
      assertCasesState({
        cases: [],
        designer,
        caseInvocation: { kind: "designer", scopeId: "other" },
      }),
    { code: "INVALID_CASE" },
  );
  throws(
    () =>
      assertCasesState({
        cases: [],
        designer: {
          ...designer,
          budget: { budgetId: "budget", scopeId: "case-scope" },
        },
      }),
    { code: "INVALID_CASE" },
  );
});

Deno.test("several open Requests retain unique identities and a single invocation selection", () => {
  const first = openCase(input());
  const second = openCase({ ...input(), id: "session:case:2", number: 2 });
  assertCasesState({
    cases: [first, second],
    caseInvocation: { kind: "local", caseId: second.id },
  });
  for (
    const duplicate of [{ ...second, number: first.number }, {
      ...second,
      id: first.id,
    }]
  ) {
    throws(() => assertCasesState({ cases: [first, duplicate] }), {
      code: "INVALID_CASE",
    });
  }
});

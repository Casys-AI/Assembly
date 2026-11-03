import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { type Case, openCase } from "../../../../domain/work/entities/cases.ts";
import { CaseError } from "../../../../domain/work/errors/case.ts";
import type { SystemRuntimeState } from "../../../../domain/work/dialogue.ts";
import {
  CloseCase,
  PilotCase,
  ReadCurrentCase,
} from "./case-lifecycle-handler.ts";
import { RunScheduledCase } from "./scheduled-case-handler.ts";
import { OperatorCases } from "../operators.ts";

const AT = "2026-10-28T00:00:00.000Z";

function request(id: string): Case {
  return openCase({
    id,
    number: 1,
    type: "request",
    objective: `Objective ${id}`,
    owner: "operator",
    openedBy: "operator",
    openedFrom: { conversationId: "conversation" },
    modelPin: { digest: "pin" },
    createdAt: AT,
  });
}

Deno.test("CloseCase delegates to the runtime close mechanism", () => {
  const state = { cases: [request("c1")] } as unknown as SystemRuntimeState;
  CloseCase(state, "c1", "done", { now: () => AT });
  equal(state.cases![0].status, "closed-done");
});

Deno.test("PilotCase pilots every registered operator runtime", () => {
  const pilot = PilotCase({
    systemId: () => "system",
    runtimes: () => [],
    onChange: () => () => {},
  });
  ok(pilot instanceof OperatorCases);
  deepStrictEqual(pilot.cases, { systemId: "system", cases: [] });
});

Deno.test("ReadCurrentCase reads the selected open local Case", () => {
  equal(
    ReadCurrentCase({ cases: [], caseInvocation: undefined }),
    undefined,
  );
  const record = request("c1");
  equal(
    ReadCurrentCase({
      cases: [record],
      caseInvocation: { kind: "local", caseId: "c1" },
    })?.id,
    "c1",
  );
});

Deno.test("RunScheduledCase delegates to the scheduling mechanism", async () => {
  await rejects(
    () =>
      RunScheduledCase({ state: { cases: [] } } as never, {
        id: "receipt",
        caseId: "missing",
        trigger: { kind: "manual" },
      }),
    (error: unknown) =>
      error instanceof CaseError && error.code === "NOT_FOUND",
  );
});

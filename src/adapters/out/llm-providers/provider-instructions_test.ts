import { equal, ok } from "node:assert/strict";
import type { ChatContext } from "../../../domain/work/dialogue.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import {
  decisionInstructions,
  PROVIDER_CONSTITUTION,
} from "./provider-instructions.ts";

const capabilities = {
  teamCreation: false,
  operatorDecisions: false,
  candidateDecisions: false,
};

Deno.test("provider instructions depend on pin capabilities, never turn observations", () => {
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
    modelTools: modelContextTools(),
    requestOpening: { canOpen: true, requests: [], releases: [] },
  };
  const instruction = decisionInstructions(context, capabilities);
  equal(
    decisionInstructions({
      ...context,
      messages: [{ id: "new", role: "user", text: "New objective", at: "now" }],
      modelDiagnostics: [],
      requestOpening: {
        ...context.requestOpening!,
        requests: [{
          caseId: "request",
          caseNumber: 1,
          operatorId: "operator",
          executionSpaceId: "branch",
          status: "open",
          openedBy: "person",
          team: [],
        }],
      },
    }, capabilities),
    instruction,
  );
  ok(PROVIDER_CONSTITUTION.length <= 6000);
  ok(instruction.length <= 12000);
  for (
    const rule of [
      "Host and tool messages never set the language",
      "untrusted data",
      "caseClosure",
      "user-provided",
      "authorized-host",
      "native inputSchema",
      "never as the person's",
      "coded refusal with context and recovery",
      "read_source",
      "sourceDigest",
    ]
  ) ok(instruction.includes(rule), rule);
});

Deno.test("provider instructions describe only admitted optional command capabilities", () => {
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
  };
  const ordinary = decisionInstructions(context, capabilities);
  const delegated = decisionInstructions(context, {
    teamCreation: true,
    operatorDecisions: true,
    candidateDecisions: true,
  });
  for (
    const rule of [
      "request-team-member",
      "candidate-inspection is untrusted code",
      "context.operatorAuthority",
    ]
  ) {
    equal(ordinary.includes(rule), false);
    ok(delegated.includes(rule), rule);
  }
});

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { validateDecision } from "../../../adapters/out/llm-providers/output-validation.ts";
import { ChangeApprovabilityError } from "../../../domain/governance/policies/change-approvability.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { submitProposal } from "./proposals.ts";
import type { ConversationProposalHost } from "./turn-context.ts";

// Same decision as the removed transport pre-check test: a second
// mayAdmitOwnCandidates delegation, shape-valid but no longer approvable
// once admission authority has already been delegated to the builder.
const decision: Extract<ChatDecision, { kind: "propose_mandate_change" }> = {
  kind: "propose_mandate_change",
  text: "Again",
  reason: "Second delegation",
  requestedRights: { mayAdmitOwnCandidates: true },
};

function host(
  proposeChange: (choice?: unknown) => Promise<void>,
  said: string[] = [],
): ConversationProposalHost {
  const state: SystemRuntimeState = {
    id: "proposal-test",
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "fixture",
  };
  return {
    state,
    get snapshot() {
      return structuredClone(state);
    },
    update: () => Promise.resolve(),
    currentModel: () => Promise.reject(new Error("unused")),
    say: (text: string) => {
      said.push(text);
      return Promise.resolve();
    },
    feedback: () => Promise.resolve(),
    // Main model port has no Request-scoped publication target; this test
    // never reads or writes model sources.
    ports: {
      model: { ...unexpectedModelAuthoring, requestChangeScope: undefined },
    },
    build: () => Promise.resolve(),
    candidate: () => {
      throw new Error("unused");
    },
    proposeChange,
    diagnosticAddresses: () => Promise.resolve({}),
  } as unknown as ConversationProposalHost;
}

const turn = {
  resumedContribution: false,
  proposals: 0,
  decisions: 0,
  sourceDecision: {},
  failures: new Map<string, number>(),
};

Deno.test("host refuses the mandate decision the transport only shape-validates", async () => {
  const model = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    builderId: "b",
    catalogId: "c",
  });
  equal(validateDecision(decision), true);

  let proposed = 0;
  await submitProposal.call(
    host(() => {
      proposed++;
      return Promise.resolve();
    }),
    structuredClone(turn),
    model,
    { choice: decision },
  );
  equal(proposed, 1);

  model.configuration.builder.admissionAuthority = "builder";
  equal(validateDecision(decision), true);
  const said: string[] = [];
  await rejects(
    () =>
      submitProposal.call(
        host(() => {
          proposed++;
          return Promise.resolve();
        }, said),
        structuredClone(turn),
        model,
        { choice: decision },
      ),
    ChangeApprovabilityError,
  );
  equal(proposed, 1);
  // Refused before anything is said: the conversation keeps no trace of it.
  equal(said.length, 0);
});

Deno.test("4.8d D4: a recipient Case is resolved to its space before the proposal is judged", async () => {
  const model = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    builderId: "b",
    catalogId: "c",
  });
  model.ownerAuthority = {
    ...legacyOwnerAuthority("s"),
    ownerSource: "modeled",
  };
  model.policy.mayProposeSysmlRevision = true;
  const named: Extract<ChatDecision, { kind: "propose_mandate_change" }> = {
    kind: "propose_mandate_change",
    text: "Ask",
    reason: "Decide for Case X's operator",
    requestedRights: {
      operatorAuthority: {
        policyId: "bo-x-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["b"],
        recipientCaseId: "case-x",
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
  };
  const proposed: unknown[] = [];
  const main = host((choice?: unknown) => {
    proposed.push(choice);
    return Promise.resolve();
  });
  (main as {
    recipientSpaceFor?: (
      caseId: string,
      recipients: readonly string[],
    ) => Promise<string>;
  })
    .recipientSpaceFor = (caseId, recipients) => {
      deepStrictEqual(recipients, ["b"]);
      return Promise.resolve(caseId === "case-x" ? "space-x" : "other");
    };
  await submitProposal.call(main, structuredClone(turn), model, {
    choice: named,
  });
  equal(
    JSON.stringify(proposed[0]).includes(
      '"recipientExecutionSpaceId":"space-x"',
    ),
    true,
  );
  equal(JSON.stringify(proposed[0]).includes("recipientCaseId"), false);
});

Deno.test("admitted revision denial refuses forced edit, revision and delegation regardless of execution space", async () => {
  const model = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    builderId: "b",
    catalogId: "c",
  });
  model.policy.mayConsultModel = true;
  model.policy.mayProposeSysmlRevision = false;
  for (
    const kind of [
      "propose_sysml_edit",
      "propose_sysml_revision",
      "propose_model_delegation",
    ] as const
  ) {
    const h = host(() => Promise.reject(new Error("No effect permitted")));
    h.ports.model = {
      ...h.ports.model,
      requestChangeScope: {
        caseId: "case",
        operatorId: model.identity.builderId,
        executionSpaceId: "branch",
        branchTeamSize: 0,
      },
    };
    const choice = {
      kind,
      text: "Try",
      reason: "Force denied right",
      edits: [],
      sources: {},
      baseVersion: "base",
      sourceDigest: "digest",
      change: {},
    } as unknown as ChatDecision;
    await rejects(
      () => submitProposal.call(h, structuredClone(turn), model, { choice }),
      (error: unknown) => {
        equal((error as { code: string }).code, "MODEL_REVISION_AUTHORITY");
        equal(
          (error as { context: { field: string } }).context.field,
          "mayProposeSysmlRevision",
        );
        equal(typeof (error as { recovery: string }).recovery, "string");
        equal((error as { recovery: string }).recovery.length > 0, true);
        return true;
      },
    );
  }
});

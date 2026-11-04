import assert from "node:assert/strict";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import { MAX_BRANCH_TEAM } from "../../src/domain/work/records/conversations.ts";
import {
  branchTeamAgent,
  observingMain,
  PRIMARY_NAME,
} from "./request-branch-team-provider.ts";

Deno.test("controlled branch provider binds creation arms to the selected input and whole-team grant", async (t) => {
  const context = (activeInputMessageId: string): ChatContext => ({
    activeInputMessageId,
    case: { id: "case" },
    operator: { name: PRIMARY_NAME },
    messages: [{
      id: "first-input",
      role: "user",
      text: "Create Helper one.",
      at: "now",
      caseId: "case",
    }, {
      id: "second-input",
      role: "user",
      text: "Create Helper two.",
      at: "later",
      caseId: "case",
    }],
  } as unknown as ChatContext);
  await t.step(
    "the first adoption resume cannot consume the second creation arm",
    async () => {
      const f = branchTeamAgent();
      f.armCreation("case", "Helper one");
      const first = await f.agent.decide(context("first-input"));
      assert.equal(first.kind, "propose_agent_creation");
      assert(first.kind === "propose_agent_creation");
      assert.equal(first.name, "Helper one");
      f.armCreation("case", "Helper two");
      // A later message in the transcript cannot drive the resumed old input.
      assert.equal(
        (await f.agent.decide(context("first-input"))).kind,
        "reply",
      );
      const second = await f.agent.decide(context("second-input"));
      assert.equal(second.kind, "propose_agent_creation");
      assert(second.kind === "propose_agent_creation");
      assert.equal(second.name, "Helper two");
    },
  );
  await t.step(
    "the explicit member grant covers the allowed whole branch team",
    async () => {
      const f = branchTeamAgent();
      f.armCreation("case", "Granted parent", PRIMARY_NAME, true);
      const input = context("grant-input");
      input.messages = [{
        id: "grant-input",
        role: "user",
        text: "Create Granted parent.",
        at: "now",
        caseId: "case",
      }];
      const creation = await f.agent.decide(input);
      assert(creation.kind === "propose_agent_creation");
      assert(creation.role === "operator");
      assert(creation.operator && "kind" in creation.operator);
      assert(creation.operator.kind === "request-team-member");
      assert.deepEqual(creation.operator.creationGrant, {
        networkHosts: [],
        maxChildren: MAX_BRANCH_TEAM,
        maxDelegationDepth: 0,
      });
    },
  );
  await t.step(
    "a later BO order cannot be consumed by an older selected input",
    async () => {
      const f = branchTeamAgent();
      const oldText = "Ask Granted parent to create Granted grandchild.";
      const newText = "Ask Granted parent to create Over bound.";
      const selected = (id: string): ChatContext => ({
        ...context(id),
        messages: [{
          id: "old-bo-input",
          role: "user",
          text: oldText,
          at: "before",
          caseId: "case",
        }, {
          id: "new-bo-input",
          role: "user",
          text: newText,
          at: "after",
          caseId: "case",
        }],
        modeledBehaviors: [{
          id: "parent-inbox",
          description: "Granted parent",
        }],
      } as unknown as ChatContext);
      f.armCreation("case", "Over bound", "Granted parent");
      f.armContribution("case", "Granted parent", newText);
      assert.equal(
        (await f.agent.decide(selected("old-bo-input"))).kind,
        "reply",
      );
      const order = await f.agent.decide(selected("new-bo-input"));
      assert(order.kind === "invoke_behavior");
      assert.equal(
        JSON.parse(order.inputJson).text,
        "Create a teammate named Over bound.",
      );
    },
  );
  await t.step(
    "a later member creation cannot be consumed by its earlier adoption resume",
    async () => {
      const f = branchTeamAgent();
      const selected = (id: string): ChatContext => ({
        ...context(id),
        operator: { name: "Granted parent" },
        messages: [{
          id: "old-member-input",
          role: "tool",
          text: "Create a teammate named Granted grandchild.",
          at: "before",
          caseId: "case",
        }, {
          id: "new-member-input",
          role: "tool",
          text: "Create a teammate named Over bound.",
          at: "after",
          caseId: "case",
        }],
      } as unknown as ChatContext);
      f.armCreation("case", "Granted grandchild", "Granted parent");
      const first = await f.agent.decide(selected("old-member-input"));
      assert(first.kind === "propose_agent_creation");
      assert.equal(first.name, "Granted grandchild");
      f.armCreation("case", "Over bound", "Granted parent");
      assert.equal(
        (await f.agent.decide(selected("old-member-input"))).kind,
        "reply",
      );
      const second = await f.agent.decide(selected("new-member-input"));
      assert(second.kind === "propose_agent_creation");
      assert.equal(second.name, "Over bound");
    },
  );
});

Deno.test("Main grant arm belongs to the exact selected input and is consumed once", async () => {
  const main = observingMain();
  const inputText = "Prepare authority over the member.";
  main.armGrant({ caseId: "case", operatorId: "member", inputText });
  const context = (activeInputMessageId: string): ChatContext => ({
    activeInputMessageId,
    messages: [
      {
        id: "notification",
        role: "tool",
        text: "Unrelated notification",
        at: "now",
      },
      { id: "grant-input", role: "user", text: inputText, at: "now" },
    ],
  } as unknown as ChatContext);
  assert.equal(
    (await main.agent.decide(context("notification"))).kind,
    "reply",
  );
  const grant = await main.agent.decide(context("grant-input"));
  assert(grant.kind === "propose_mandate_change");
  assert("operatorAuthority" in grant.requestedRights);
  assert.deepEqual(grant.requestedRights.operatorAuthority?.recipients, [
    "member",
  ]);
  assert.equal((await main.agent.decide(context("grant-input"))).kind, "reply");
});

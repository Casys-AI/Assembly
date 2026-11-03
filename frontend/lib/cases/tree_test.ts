import { deepStrictEqual, equal } from "node:assert/strict";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { caseTree, caseTreeAgent, type CaseTreeNode } from "./tree.ts";

const CASE = "s:case:1";

function agent(
  id: string,
  messages: unknown[] = [],
  patch: Partial<AgentConversation> = {},
): AgentConversation {
  return {
    agentId: id,
    nativeId: `native:${id}`,
    name: id.toUpperCase(),
    responsibility: "",
    primary: false,
    canSend: true,
    revision: 1,
    busy: false,
    phase: "Ready",
    modelDigest: "digest",
    messages: messages as never,
    ...patch,
  };
}
/** A message in the Case at the given minute, delegated by `caller` if any. */
const said = (
  minute: number,
  caller?: string,
  caseId: string | undefined = CASE,
) => ({
  id: `m${minute}${caller ?? ""}`,
  role: "assistant",
  text: "…",
  at: `2026-10-24T10:${String(minute).padStart(2, "0")}:00Z`,
  ...(caseId && { caseId }),
  ...(caller && { work: { callerId: `native:${caller}` } }),
});

/** The tree as nested ids: the root's, then its children's. */
const shape = (node: CaseTreeNode): unknown =>
  node.children.length
    ? [node.agent?.agentId, node.children.map(shape)]
    : node.agent?.agentId;

Deno.test("the root is the owner, always there, even without a message", () => {
  const owner = agent("owner");
  const root = caseTree([owner, agent("quiet")], { id: CASE }, owner);
  equal(root.agent, owner);
  equal(root.name, "OWNER");
  deepStrictEqual(root.messages, []);
  deepStrictEqual(root.children, []);
  // Without a known owner the root has no agent, and is the Coordinator.
  const unknown = caseTree([agent("a", [said(1)])], { id: CASE }, null);
  equal(unknown.agent, null);
  equal(unknown.name, "Coordinator");
  deepStrictEqual(shape(unknown), [undefined, ["a"]]);
});

Deno.test("an agent sits under the agent that asked it, found by the first delegated message", () => {
  const owner = agent("owner", [said(1)]);
  const root = caseTree(
    [
      owner,
      agent("collector", [said(2, "owner")]),
      // A later message from another caller does not move it.
      agent("analyst", [said(3), said(4, "owner"), said(5, "collector")]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), ["owner", ["collector", "analyst"]]);
  const sibling = caseTree(
    [
      owner,
      agent("collector", [said(2, "owner")]),
      agent("analyst", [said(3), said(4, "collector")]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(sibling), ["owner", [["collector", ["analyst"]]]]);
});

Deno.test("an unknown caller, the owner, or no caller leaves the agent under the root", () => {
  const owner = agent("owner", [said(1)]);
  const root = caseTree(
    [
      owner,
      agent("by-stranger", [said(2, "stranger")]),
      agent("by-owner", [said(3, "owner")]),
      agent("by-nobody", [said(4)]),
      // The caller spoke in another Case only: it is not in this tree.
      agent("by-absent", [said(5, "absent")]),
      agent("absent", [said(6, undefined, "s:case:2")]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), [
    "owner",
    ["by-stranger", "by-owner", "by-nobody", "by-absent"],
  ]);
});

Deno.test("agents nest to any depth", () => {
  const owner = agent("owner", [said(1)]);
  const root = caseTree(
    [
      owner,
      agent("c", [said(4, "b")]),
      agent("b", [said(3, "a")]),
      agent("a", [said(2, "owner")]),
      agent("b2", [said(5, "a")]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), [
    "owner",
    [["a", [["b", ["c"]], "b2"]]],
  ]);
});

Deno.test("a loop of callers is cut, and an agent never sits under itself", () => {
  const owner = agent("owner", [said(1)]);
  const root = caseTree(
    [
      owner,
      agent("a", [said(2, "b")]),
      agent("b", [said(3, "a")]),
      agent("self", [said(4, "self")]),
      agent("x", [said(5, "z")]),
      agent("y", [said(6, "x")]),
      agent("z", [said(7, "y")]),
    ],
    { id: CASE },
    owner,
  );
  // Every agent appears once, reachable from the root.
  const seen: string[] = [];
  const walk = (node: CaseTreeNode) => {
    seen.push(node.agent!.agentId);
    node.children.forEach(walk);
  };
  walk(root);
  deepStrictEqual(seen.toSorted(), [
    "a",
    "b",
    "owner",
    "self",
    "x",
    "y",
    "z",
  ]);
  // b and z close their loops: they go under the root, in time order, and
  // the agents that hung from them follow.
  deepStrictEqual(shape(root), [
    "owner",
    [["b", ["a"]], "self", ["z", [["x", ["y"]]]]],
  ]);
});

Deno.test("siblings follow their first message in the Case; only the Case's messages count", () => {
  const owner = agent("owner", [
    said(9, undefined, "s:case:2"),
    said(3),
    said(1),
  ]);
  const root = caseTree(
    [
      owner,
      agent("late", [said(8)]),
      agent("early", [said(2), said(7)]),
      // Same minute as "early": the roster's order decides.
      agent("twin", [said(2)]),
      agent("elsewhere", [
        said(1, undefined, "s:case:2"),
        said(1, undefined, ""),
      ]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), ["owner", ["early", "twin", "late"]]);
  // A thread reads oldest first, only what was said in this Case.
  deepStrictEqual(root.messages.map((message) => message.at.slice(11, 16)), [
    "10:01",
    "10:03",
  ]);
  deepStrictEqual(
    root.children.map((node) => node.messages.length),
    [2, 1, 1],
  );
});

Deno.test("a node says whether its agent is busy", () => {
  const owner = agent("owner", [], { busy: true });
  const root = caseTree(
    [owner, agent("a", [said(1)], { busy: true }), agent("b", [said(2)])],
    { id: CASE },
    owner,
  );
  deepStrictEqual(
    [root, ...root.children].map((node) => node.busy),
    [true, true, false],
  );
});

Deno.test("a sub-agent is found at any depth; the root and strangers are not", () => {
  const owner = agent("owner", [said(1)]);
  const root = caseTree(
    [
      owner,
      agent("a", [said(2, "owner")]),
      agent("b", [said(3, "a")]),
    ],
    { id: CASE },
    owner,
  );
  equal(caseTreeAgent(root, "b")?.agent?.agentId, "b");
  equal(caseTreeAgent(root, "owner"), undefined);
  equal(caseTreeAgent(root, "nobody"), undefined);
  equal(caseTreeAgent(root, null), undefined);
  equal(caseTreeAgent(root, undefined), undefined);
});

Deno.test("admitted Request teammates are visible before speaking and follow their modeled parent", () => {
  const owner = agent("owner");
  const team = (
    parentOperatorId: string,
  ): NonNullable<AgentConversation["operatorTeam"]> => ({
    parentOperatorId,
    requestId: CASE,
    requestOwnerId: owner.nativeId,
    creationPolicyId: "policy:team",
  });
  const collector = agent("collector", [], {
    operatorTeam: team(owner.nativeId),
  });
  const analyst = agent("analyst", [], {
    operatorTeam: team(collector.nativeId),
  });
  const root = caseTree(
    [
      owner,
      analyst,
      collector,
      agent("global-peer"),
      agent("foreign-request", [], {
        operatorTeam: { ...team(owner.nativeId), requestId: "other" },
      }),
      agent("foreign-owner", [], {
        operatorTeam: { ...team(owner.nativeId), requestOwnerId: "other" },
      }),
      agent("audit", [], {
        runtimeOwned: false,
        operatorTeam: team(owner.nativeId),
      }),
      agent("contributor", [said(1, "owner")]),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), ["owner", ["contributor", ["collector", [
    "analyst",
  ]]]]);
  equal(caseTreeAgent(root, "analyst")?.messages.length, 0);
  equal(caseTreeAgent(root, "analyst")?.agent, analyst);
});

Deno.test("modeled Request team parent loops remain reachable once and never borrow foreign parents", () => {
  const owner = agent("owner");
  const member = (id: string, parent: string) =>
    agent(id, [], {
      operatorTeam: {
        parentOperatorId: `native:${parent}`,
        requestId: CASE,
        requestOwnerId: owner.nativeId,
      },
    });
  const root = caseTree(
    [
      owner,
      member("a", "b"),
      member("b", "a"),
      member("self", "self"),
      member("orphan", "foreign"),
      agent("foreign"),
    ],
    { id: CASE },
    owner,
  );
  deepStrictEqual(shape(root), ["owner", [["b", ["a"]], "self", "orphan"]]);
  equal(
    caseTree([member("a", "owner")], { id: CASE }, null).children.length,
    0,
  );
});

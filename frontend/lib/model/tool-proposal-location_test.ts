import { deepStrictEqual, equal, match } from "node:assert/strict";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../src/domain/work/records/conversations.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";
import { modelPageOf } from "../workbench/desk.ts";
import {
  readToolProposal,
  toolProposalHref,
  toolProposalSelection,
} from "./tool-proposal-location.ts";

const conversation = (agentId: string): AgentConversation => ({
  agentId,
  nativeId: `native:${agentId}`,
  name: "Twin",
  responsibility: "",
  primary: agentId === "alpha",
  canSend: true,
  revision: 7,
  busy: false,
  phase: "Ready",
  messages: [],
  modelDigest: "model",
});
const tool = (agentId: string): OperatorTool => ({
  agentId,
  agentName: "Twin",
  revision: 7,
  candidate: { ...snapshot().candidates[0], requiredAuthority: "human" },
});
const target = { operator: "beta", candidate: "c1", digest: "a".repeat(64) };
const fresh = () => ({
  catalogue: {
    systemId: "ui-fixture",
    version: "v1",
    tools: [tool("alpha"), tool("beta")],
  },
  conversations: [conversation("alpha"), conversation("beta")],
  loading: false,
  stale: false,
  historical: false,
});

Deno.test("tool addresses preserve exact opaque identity and select Model Activity by default", () => {
  const exact = {
    operator: "operator:beta /?",
    candidate: "tool&same",
    digest: "digest+#",
  };
  const href = toolProposalHref(exact);
  match(href, /^\/model\?operator=/);
  const address = new URL(href, "http://local");
  equal(address.searchParams.has("page"), false);
  equal(modelPageOf(address), "activity");
  deepStrictEqual(
    toolProposalSelection({ search: new URL(href, "http://local").search }),
    { kind: "selected", target: exact },
  );
  equal(toolProposalHref(tool("beta")), toolProposalHref(target));
});

Deno.test("explicit old Revisions tool addresses still select the same exact proposal", () => {
  const address = new URL(toolProposalHref(target), "http://local");
  address.searchParams.set("page", "revisions");
  equal(modelPageOf(address), "revisions");
  deepStrictEqual(toolProposalSelection({ search: address.search }), {
    kind: "selected",
    target,
  });
});

Deno.test("tool selection rejects incomplete, duplicate and historical target combinations", () => {
  deepStrictEqual(
    toolProposalSelection({ search: "?page=revisions&commit=main" }),
    { kind: "none" },
  );
  for (
    const search of [
      "?candidate=c1",
      "?operator=beta&candidate=c1&digest=",
      "?operator=beta&candidate=c1&digest=a&operator=alpha",
      ...["commit", "proposal", "from", "revision", "modelVersion", "version"]
        .map((name) => `?operator=beta&candidate=c1&digest=a&${name}=old`),
    ]
  ) {
    equal(toolProposalSelection({ search }).kind, "invalid", search);
  }
});

Deno.test("catalogue resolution uses exact owner, candidate and digest with no primary fallback", () => {
  const read = readToolProposal(target, fresh());
  equal(read.status, "ready");
  if (read.status === "ready") {
    equal(read.tool.agentId, "beta");
    equal(read.conversation.nativeId, "native:beta");
  }
  for (
    const [selection, code] of [
      [{ ...target, operator: "missing" }, "tool-proposal-owner-absent"],
      [{ ...target, candidate: "missing" }, "tool-proposal-candidate-absent"],
      [{ ...target, digest: "changed" }, "tool-proposal-digest-changed"],
    ] as const
  ) {
    const read = readToolProposal(selection, fresh());
    equal(read.status === "unavailable" && read.code, code);
  }
  const noOwner = readToolProposal(target, {
    ...fresh(),
    conversations: [conversation("alpha")],
  });
  equal(
    noOwner.status === "unavailable" && noOwner.code,
    "tool-proposal-owner-absent",
  );
});

Deno.test("freshness and historical boundaries prevent a present proposal from opening", () => {
  for (
    const [overrides, code] of [
      [{ catalogue: null }, "tool-proposal-catalogue-absent"],
      [{ loading: true }, "tool-proposal-loading"],
      [{ stale: true }, "tool-proposal-catalogue-stale"],
      [{ historical: true }, "tool-proposal-historical"],
    ] as const
  ) {
    const read = readToolProposal(target, { ...fresh(), ...overrides });
    equal(read.status === "unavailable" && read.code, code);
  }
});

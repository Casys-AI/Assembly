import { ok } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { modelContextTools } from "../../../application/work/context/model-tools.ts";
import type { ChatContext } from "../../../application/work/conversation/chat-context.ts";
import { ClaudeAgents } from "./agents.ts";

/** Synthetic BO: real compiled fixture contracts/flow plus one loaded skill.
 * Sizes are estimates, never Anthropic usage or evidence of a cache hit. */
function branchTurn(): ChatContext {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  const version = {
    digest: "a".repeat(64),
    repositoryVersion: `commit:${"b".repeat(40)}`,
  };
  const skill = {
    id: "writing",
    name: "Writing",
    description: "Write useful, concrete headlines.",
    digest: "c".repeat(64),
    byteLength: 7200,
    content: "Write useful, concrete headlines.\n".repeat(220),
    installedAt: "2026-11-02",
    loaded: true,
    source: {
      kind: "bundled" as const,
      location: "bundle:writing",
      acquiredAt: "2026-11-02",
      modelVersion: version,
    },
  };
  const { content: _content, ...metadata } = skill;
  return {
    modelVersion: version,
    admittedModelVersion: version,
    operator: {
      nativeId: "operator",
      name: "Branch Operator",
      instruction:
        "Produce three concrete headlines from the supplied objective.",
    },
    mandate: model.mandate,
    executionPolicy: model.policy,
    contracts: model.contracts,
    activeInputMessageId: "input",
    messages: [
      {
        id: "input",
        role: "user",
        text: "Write three headlines for the Assembly demo.",
        at: "now",
      },
      {
        id: "read",
        role: "tool",
        text: JSON.stringify(model.flows.conversation),
        at: "later",
        observation: {
          kind: "model-context",
          value: model.flows.conversation,
        } as ChatContext["messages"][number]["observation"],
      },
    ],
    case: {
      id: "request",
      number: 1,
      type: "request",
      objective: "Write three headlines for the Assembly demo.",
      owner: "operator",
      openedBy: "person",
      openedFrom: { conversationId: "main" },
      modelPin: version,
      status: "open",
      createdAt: "now",
      updatedAt: "now",
      messages: [],
    } as ChatContext["case"],
    activeTools: [],
    candidates: [],
    modelTools: modelContextTools(),
    modelSources: { version: version.repositoryVersion, sources: {} },
    modelContext: {
      version: version.repositoryVersion,
      sourceDigest: version.digest,
      files: ["configuration.sysml", "conversation.sysml", "skills.sysml"].map(
        (path) => ({
          path,
          sha256: version.digest,
          characters: 8000,
          byteLength: 8000,
        }),
      ),
      roots: { items: [], total: 0, truncated: false },
      limits: {
        maxPageSize: 50,
        maxSourceBytes: 120000,
        maxInspectSourceBytes: 12000,
      },
      coverage: "bounded-discovery-not-exhaustive-impact",
    },
    skills: {
      policy: {
        id: "skills",
        ownerId: "operator",
        allowedHosts: [],
        maxSkillBytes: 65536,
        maxInstalledSkills: 32,
        maxLoadedSkills: 4,
        maxLoadedCharacters: 48000,
      },
      catalog: [metadata],
      loaded: [skill],
    },
    modeledBehaviors: [
      {
        id: "load-skill",
        name: "ChargerSkill",
        description: "Load the exact installed skill by ID and digest.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, digest: { type: "string" } },
          required: ["id", "digest"],
          additionalProperties: false,
        },
      },
      {
        id: "read-evidence",
        name: "ConsulterPreuve",
        description:
          "Read exact journal evidence using messageId and messageDigest.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string" },
            messageDigest: { type: "string" },
          },
          required: ["messageId", "messageDigest"],
          additionalProperties: false,
        },
      },
    ].map((behavior) => ({
      ...behavior,
      callerNativeId: "operator",
      targetNativeId: behavior.id,
      targetTypeId: behavior.id,
      inputTypeId: `${behavior.id}-input`,
      sourceIds: [],
    })),
  };
}

Deno.test("BO provider payload stays within the 8000 estimated input-token budget", async () => {
  let payload = "", prefix = "";
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: (_url, init) => {
      payload = String(init?.body);
      const body = JSON.parse(payload);
      prefix = JSON.stringify({ tools: body.tools, system: body.system });
      return Promise.resolve(
        Response.json({
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: "reply",
            name: "reply",
            input: { text: "Three headlines." },
          }],
        }),
      );
    },
  });
  await agent.decideBatch(branchTurn());
  // Deterministic UTF-8 bytes / 4 estimate includes schemas and JSON overhead.
  // 8k gives room for this brief and one bounded small observation. Removing
  // unavailable decisions also reduces cacheable bytes: never pad the prefix
  // to satisfy a minimum size. This is not a provider-confirmed cache read.
  const estimate = (text: string) =>
    Math.ceil(new TextEncoder().encode(text).length / 4);
  console.log(
    JSON.stringify({
      payloadCharacters: payload.length,
      prefixCharacters: prefix.length,
      estimatedInputTokens: estimate(payload),
      estimatedCacheableTokens: estimate(prefix),
    }),
  );
  ok(estimate(payload) <= 8000, `payload estimate ${estimate(payload)} > 8000`);
});

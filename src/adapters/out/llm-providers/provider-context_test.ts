import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { ChatContext } from "../../../domain/work/dialogue.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  buildTurnBrief,
  MAX_TURN_BRIEF_CHARACTERS,
  ProviderContextLimitError,
  ProviderPinCardCache,
} from "./provider-context.ts";

function context(): ChatContext {
  return {
    messages: [{
      id: "input",
      role: "user",
      text: "Write three headlines.",
      at: "now",
    }],
    activeInputMessageId: "input",
    activeTools: [{
      id: "reader",
      name: "Read page",
      description: "Read",
      digest: "tool-pin",
      kind: "read_web_page",
    }],
    candidates: [],
    operator: {
      nativeId: "operator",
      name: "Writer",
      instruction: "Write clear headlines.",
    },
    modelVersion: { digest: "pin-a", repositoryVersion: "commit:a" },
    mandate: {
      id: "mandate",
      mayPropose: [],
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayActivate: false,
      network: { allowedHosts: ["example.com"] },
      supportedChanges: [],
    },
    modeledBehaviors: [{
      id: "load",
      name: "ChargerSkill",
      description: "Load one exact skill.\nMore details.",
      targetNativeId: "load-native",
      targetTypeId: "LoadSkill",
      callerNativeId: "operator",
      inputTypeId: "LoadSkillRequest",
      sourceIds: [],
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, digest: { type: "string" } },
        required: ["id", "digest"],
        additionalProperties: false,
      },
    }],
    modelSources: {
      version: "commit:a",
      sources: { "system.sysml": "DO NOT PUSH SOURCE" },
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
      catalog: [{
        id: "writing",
        name: "Writing",
        description: "Writing guidance",
        digest: "skill-pin",
        byteLength: 100,
        installedAt: "now",
        loaded: true,
        source: {
          kind: "bundled",
          location: "bundle:writing",
          acquiredAt: "now",
          modelVersion: { digest: "pin-a", repositoryVersion: "commit:a" },
        },
      }],
      loaded: [],
    },
  };
}

Deno.test("pin card is memoized per admitted pin, operator and invocation without turn state", () => {
  const cache = new ProviderPinCardCache();
  const initial = context();
  const card = cache.card(initial);
  const data = JSON.parse(card);
  equal(data.operator.instruction, "Write clear headlines.");
  ok(!("activeTools" in data));
  deepStrictEqual(data.modelFiles, ["system.sysml"]);
  equal(data.behaviors[0].input.id, "string");
  equal(data.skills[0].id, "writing");
  ok(!card.includes("DO NOT PUSH SOURCE"));
  ok(!card.includes("Write three headlines."));
  const next = context();
  next.messages.push({
    id: "observation",
    role: "tool",
    text: "large read".repeat(1000),
    at: "later",
  });
  next.modelSources!.sources["loaded.sysml"] = "another working-set read";
  next.skills!.catalog = [{ ...next.skills!.catalog[0]!, loaded: false }];
  equal(cache.card(next), card);
  next.modelVersion = { digest: "pin-b", repositoryVersion: "commit:b" };
  ok(cache.card(next) !== card);
  next.modelVersion = initial.modelVersion;
  next.operator = { ...next.operator!, nativeId: "another-operator" };
  ok(cache.card(next) !== card);
  next.operator = initial.operator;
  next.case = {
    id: "case",
    number: 1,
    type: "request",
    objective: "Headlines",
    owner: "operator",
    openedBy: "person",
    openedFrom: { conversationId: "conversation" },
    modelPin: { digest: "pin-a" },
    status: "open",
    createdAt: "now",
  };
  ok(cache.card(next) !== card);
});

Deno.test("turn brief keeps the exact opening input, task URLs, status, budget and Request targets only", async () => {
  const input = context();
  input.messages.push({
    id: "later",
    role: "user",
    text: "NOT THE OPENING INPUT",
    at: "later",
  });
  input.workBudget = {
    budgetId: "budget",
    scopeId: "scope",
    unit: "agent-invocation",
    limit: 10,
    consumed: 2,
    reserved: 1,
    remaining: 7,
    exhausted: false,
    suspended: false,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  input.requestOpening = {
    canOpen: true,
    releases: [],
    requests: [{
      caseId: "request",
      caseNumber: 1,
      operatorId: "bo",
      executionSpaceId: "private-space",
      status: "open",
      openedBy: "person",
      team: [{
        operatorId: "member",
        name: "Reviewer",
        parentOperatorId: "bo",
      }],
    }],
  };
  input.taskSourceInputs = [{
    kind: "human-selected-urls",
    rootRequestId: "request",
    source: {
      operatorId: "main",
      conversationId: "conversation",
      designerScopeId: "scope",
      messageId: "source",
      messageDigest: "a".repeat(64),
    },
    urls: ["https://example.com/exact?edition=2"],
  }];
  const brief = await buildTurnBrief(input);
  equal(brief.input?.text, "Write three headlines.");
  equal(brief.activeTools[0]?.id, "reader");
  equal(brief.budget?.remaining, 7);
  equal(brief.requests?.[0]?.operatorId, "bo");
  equal(brief.requests?.[0]?.team[0]?.operatorId, "member");
  deepStrictEqual(
    brief.taskSourceInputs?.[0]?.urls,
    input.taskSourceInputs[0]!.urls,
  );
  const serialized = JSON.stringify(brief);
  ok(serialized.length <= MAX_TURN_BRIEF_CHARACTERS);
  for (
    const excluded of [
      "NOT THE OPENING INPUT",
      "private-space",
      "modelSources",
      "candidates",
      "mandate",
    ]
  ) ok(!serialized.includes(excluded), excluded);
});

Deno.test("a large opening message has a bounded preview and an exact journal evidence reference", async () => {
  const input = context();
  input.messages[0]!.text = "A large user document. ".repeat(1000);
  const brief = await buildTurnBrief(input);
  ok(JSON.stringify(brief).length <= MAX_TURN_BRIEF_CHARACTERS);
  equal(brief.input?.truncated, true);
  equal(brief.input?.reference?.messageId, "input");
  equal(
    brief.input?.reference?.messageDigest,
    await executionDigest(input.messages[0]!),
  );
});

Deno.test("oversized exact task inputs fail with a coded recovery instead of corrupting a URL", async () => {
  const input = context();
  input.taskSourceInputs = [{
    kind: "human-selected-urls",
    rootRequestId: "request",
    source: {
      operatorId: "main",
      conversationId: "conversation",
      designerScopeId: "scope",
      messageId: "source",
      messageDigest: "a".repeat(64),
    },
    urls: Array.from(
      { length: 20 },
      (_, i) => `https://example.com/${i}/${"x".repeat(1000)}`,
    ),
  }];
  await rejects(() => buildTurnBrief(input), (error: unknown) => {
    ok(error instanceof ProviderContextLimitError);
    equal(error.code, "TURN_BRIEF_LIMIT");
    equal(error.context.maximumCharacters, MAX_TURN_BRIEF_CHARACTERS);
    ok(error.recovery.length > 0);
    return true;
  });
});

Deno.test("notice briefs retain current decision identities and a newer read pin without changing the execution card", async () => {
  const input = context();
  input.admittedModelVersion = {
    digest: "pin-a",
    repositoryVersion: "commit:execution",
  };
  input.messages[0] = {
    id: "input",
    role: "tool",
    text: "Decide this network request.",
    at: "now",
    noticeWake: true,
    operatorNotice: {
      kind: "authority-escalation",
      changeId: "change-1",
      requestedBy: "bo",
      caseId: "case-1",
      recipient: "operator",
      decisionAuthority: "operator",
      reason: "Network permission",
    },
  };
  const policy = {
    id: "network-policy",
    revision: 3,
    enabled: true,
    networkHosts: ["example.com"],
    recipients: ["bo"],
    acts: ["addNetworkHosts"],
  } as NonNullable<ChatContext["operatorAuthority"]>["policies"][number];
  const request = {
    id: "change-1",
    requestedBy: "bo",
    caseId: "case-1",
    baseRevision: 7,
    changeKind: "mandate-change",
    requestedRights: { addNetworkHosts: ["example.com"] },
  } as NonNullable<ChatContext["operatorAuthority"]>["requests"][number];
  input.operatorAuthority = {
    policies: [policy],
    requests: [request, { ...request, id: "unrelated" }],
    awaitingPerson: [{
      id: "change-awaiting",
      caseId: "case-2",
      executionSpaceId: "private",
      requester: {
        projectId: "project",
        systemId: "system",
        executionSpaceId: "private",
        operatorId: "peer",
      },
      changeKind: "mandate-change",
      status: "human-decision",
    }],
    awaitingPersonTruncated: false,
  };
  const cache = new ProviderPinCardCache();
  const card = cache.card(input);
  input.modelSources!.version = "commit:new-source";
  const brief = await buildTurnBrief(input);
  equal(cache.card(input), card);
  equal(brief.modelReadVersion, "commit:new-source");
  equal(brief.operatorAuthority?.requests.length, 1);
  equal(brief.operatorAuthority?.requests[0]?.baseRevision, 7);
  equal(JSON.parse(card).operatorAuthority.policies[0].revision, 3);
  equal(brief.operatorAuthority?.awaitingPerson[0]?.id, "change-awaiting");
  ok(!JSON.stringify(brief).includes("private"));
});

Deno.test("creation grants in a pin card do not disappear when the live Request is at capacity", () => {
  const input = context();
  input.executionPolicy = {
    maxAgentDecisions: 8,
    maxToolProposals: 1,
    maxFlowSteps: 24,
    urlSelectionMode: "user-provided",
    mayAddNetworkHosts: false,
    mayDelegateOwnAdmission: false,
    mayCreateReviewer: false,
    mayChangeUrlSelection: false,
    mayConsultModel: true,
    mayProposeSysmlRevision: false,
  };
  const grant = {
    id: "creation",
    revision: 2,
    enabled: true,
    holderNativeId: "operator",
    networkHosts: ["example.com"],
    maxChildren: 2,
    maxDelegationDepth: 0,
    mode: "per-creation",
  } as NonNullable<ChatContext["pinPolicies"]>["creation"][number];
  input.pinPolicies = {
    creation: [grant, { ...grant, id: "peer-grant", holderNativeId: "peer" }],
    authority: [],
    toolAdmission: [],
  };
  const cache = new ProviderPinCardCache();
  const cached = cache.card(input);
  const card = JSON.parse(cached);
  equal(card.operatorCreation.policies.length, 1);
  equal(card.operatorCreation.policies[0].id, "creation");
  deepStrictEqual(card.operatorCreation.provisionBounds.budget, {
    maxAgentDecisions: 8,
    maxToolProposals: 1,
    maxFlowSteps: 24,
  });
  equal(card.operatorCreation.provisionBounds.mayConsultModel, true);
  input.operatorCreation = {
    policies: [grant],
    provisionBounds: card.operatorCreation.provisionBounds,
  };
  input.workBudget = {
    budgetId: "budget",
    scopeId: "scope",
    unit: "agent-invocation",
    limit: 8,
    consumed: 8,
    reserved: 0,
    remaining: 0,
    exhausted: true,
    suspended: true,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  equal(cache.card(input), cached);
  equal(new ProviderPinCardCache().card(input), cached);
});

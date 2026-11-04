import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { Ajv } from "ajv";
import type { ChatContext } from "../../../application/work/conversation/chat-context.ts";
import { modelContextTools } from "../../../application/work/context/model-tools.ts";
import {
  StructuredAgents,
  type StructuredPromptParts,
} from "./structured-agents.ts";
import { buildProviderTools } from "./provider-tools.ts";
import { decisionSchema } from "./output-validation.ts";

class RecordingAgents extends StructuredAgents {
  readonly label = "recording";
  tools: string[] = [];
  batched = false;
  response?: unknown;
  parts?: StructuredPromptParts;
  schema?: object;
  prompt?: string;
  protected call(
    prompt: string,
    schema: object,
    parts?: StructuredPromptParts,
  ): Promise<unknown> {
    this.parts = parts;
    this.schema = schema;
    this.prompt = prompt;
    this.tools = buildProviderTools(schema).map((tool) => tool.name);
    const decision = { kind: "reply", text: "Observed" };
    return Promise.resolve(
      this.response ??
        (this.batched ? { calls: [{ id: "reply", decision }] } : decision),
    );
  }
}

Deno.test("behavior tools select canonical exposed ids and disappear without exposures", async () => {
  const agent = new RecordingAgents();
  const id = "f444e82c-cd07-56a2-9840-bdf42361bb19";
  const name = "ContributeTo_4be741d072cae0f21fb6d7f6";
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
    modelVersion: { digest: "behavior-pin" },
    operator: { nativeId: "bo", name: "BO", instruction: "Coordinate" },
    modeledBehaviors: [{
      id,
      name,
      description: "Contribute bounded work to the Request member.",
      callerNativeId: "bo",
      targetNativeId: "member-inbox",
      targetTypeId: "AgentInbox",
      inputTypeId: "WorkRequest",
      inputSchema: { type: "object" },
      sourceIds: [],
    }],
  };
  const secondId = "e444e82c-cd07-56a2-9840-bdf42361bb19";
  context.modeledBehaviors = [...context.modeledBehaviors!, {
    ...context.modeledBehaviors![0],
    id: secondId,
  }];
  agent.response = {
    kind: "invoke_behavior",
    text: "Ask the member",
    behaviorId: id,
    inputJson: '{"text":"Review the passage."}',
  };
  const selected = await agent.decide(context);
  equal(selected.kind, "invoke_behavior");
  if (selected.kind === "invoke_behavior") equal(selected.behaviorId, id);
  const tool = buildProviderTools(agent.schema!).find((tool) =>
    tool.name === "invoke_behavior"
  )!;
  const properties = tool.input_schema.properties as Record<
    string,
    { enum?: string[] }
  >;
  deepStrictEqual(properties.behaviorId.enum, [secondId, id]);
  equal(properties.behaviorId.enum!.includes(name), false);
  const prefix = agent.parts!.system;
  const sameSchema = structuredClone(agent.schema);
  context.modeledBehaviors = [...context.modeledBehaviors!].reverse();
  await agent.decide(structuredClone(context));
  equal(agent.parts!.system, prefix);
  deepStrictEqual(agent.schema, sameSchema);
  agent.response = undefined;
  context.modelVersion = { digest: "without-behaviors" };
  delete context.modeledBehaviors;
  await agent.decide(context);
  equal(agent.tools.includes("invoke_behavior"), false);
});

Deno.test("a Request exposes only granted team creation and refuses historical creation responses", async () => {
  const agent = new RecordingAgents();
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
    case: {
      id: "request",
      number: 1,
      type: "request",
      objective: "Read",
      owner: "operator",
      openedBy: "person",
      openedFrom: { conversationId: "main" },
      modelPin: { digest: "pin" },
      status: "open",
      createdAt: "now",
    },
  };
  const historical = {
    kind: "propose_agent_creation",
    text: "A reviewer",
    reason: "Review",
    name: "Reviewer",
    role: "operator",
    operator: {
      instruction: "Review",
      networkHosts: [],
      requestType: { name: "Review", maxInvocations: 1 },
      firstRequest: { objective: "Read" },
    },
  };
  for (const teamCreation of [false, true]) {
    context.pinCapabilities = {
      teamCreation,
      operatorDecisions: false,
      candidateDecisions: false,
    };
    agent.response = undefined;
    await agent.decide(context);
    const variants = (agent.schema as typeof decisionSchema).oneOf.filter(
      (entry) =>
        (entry.properties.kind as { const: string }).const ===
          "propose_agent_creation",
    );
    equal(variants.length, teamCreation ? 1 : 0);
    if (teamCreation) {
      const { oneOf: specs } = variants[0].properties.operator as {
        oneOf: Array<{ properties: { kind: { const: string } } }>;
      };
      equal(specs.length, 1);
      equal(specs[0].properties.kind!.const, "request-team-member");
    }
    agent.response = historical;
    await rejects(() => agent.decide(context), /Invalid agent decision schema/);
  }
  delete context.case;
  equal((await agent.decide(context)).kind, "propose_agent_creation");
});

Deno.test("Request reply schema reserves done for the person's verdict", async () => {
  const agent = new RecordingAgents();
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
    case: {
      id: "request",
      number: 1,
      type: "request",
      objective: "Read",
      owner: "operator",
      openedBy: "person",
      openedFrom: { conversationId: "main" },
      modelPin: { digest: "pin" },
      status: "open",
      createdAt: "now",
    },
  };
  await agent.decide(context);
  const reply = (agent.schema as typeof decisionSchema).oneOf.find((variant) =>
    (variant.properties.kind as { const: string }).const === "reply"
  )!;
  deepStrictEqual((reply.properties.caseClosure as { enum: string[] }).enum, [
    "abandoned",
  ]);
  const validate = new Ajv({ strict: true }).compile(agent.schema!);
  equal(
    validate({ kind: "reply", text: "Complete", caseClosure: "done" }),
    false,
  );
  equal(
    validate({ kind: "reply", text: "Stop", caseClosure: "abandoned" }),
    true,
  );
  for (const type of ["job", "watch", undefined] as const) {
    if (type) context.case!.type = type;
    else delete context.case;
    await agent.decide(context);
    const validateOutsideRequest = new Ajv({ strict: true }).compile(
      agent.schema!,
    );
    equal(
      validateOutsideRequest({
        kind: "reply",
        text: "Complete",
        caseClosure: "done",
      }),
      true,
    );
  }
});

Deno.test("creation right is exposed and accepted only when the host supports its request", async () => {
  const agent = new RecordingAgents();
  const context: ChatContext = {
    messages: [],
    activeTools: [],
    candidates: [],
    modelVersion: { digest: "same-pin", repositoryVersion: "commit:same" },
    operator: { nativeId: "bo", name: "BO", instruction: "Review" },
  };
  const proposal = {
    kind: "propose_mandate_change",
    text: "Request the right",
    reason: "Review the draft",
    requestedRights: {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 2,
        mode: "per-creation",
      },
    },
  };
  for (const supported of [false, true, false]) {
    context.mandate = {
      id: "mandate",
      network: { allowedHosts: [] },
      mayPropose: [],
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayActivate: false,
      supportedChanges: supported
        ? [{
          kind: "propose_mandate_change",
          requestedRights: "operatorCreation",
          description: "Ask for own branch creation",
        }]
        : [],
    };
    agent.response = undefined;
    await agent.decide(context);
    const variant = (agent.schema as typeof decisionSchema).oneOf.find((
      entry,
    ) =>
      (entry.properties.kind as { const: string }).const ===
        "propose_mandate_change"
    )!;
    const rights = variant.properties.requestedRights as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    equal(
      rights.oneOf.some((entry) => "operatorCreation" in entry.properties),
      supported,
    );
    equal(
      agent.parts!.system.includes('"requestedRights":"operatorCreation"'),
      supported,
      "the cached descriptive card must agree with the current request exposure",
    );
    agent.response = proposal;
    if (supported) {
      equal((await agent.decide(context)).kind, "propose_mandate_change");
    } else {
      await rejects(
        () => agent.decide(context),
        /Invalid agent decision schema/,
      );
    }
  }
});

for (const tools of [undefined, [], modelContextTools()]) {
  for (const batched of [false, true]) {
    Deno.test(`${batched ? "batch" : "scalar"} provider exposes consult_model only with available model read tools (${tools?.length ?? "absent"})`, async () => {
      const agent = new RecordingAgents();
      agent.batched = batched;
      const context: ChatContext = {
        messages: [],
        activeTools: [],
        candidates: [],
        modelTools: tools,
      };
      if (batched) await agent.decideBatch(context);
      else await agent.decide(context);
      equal(agent.tools.includes("consult_model"), !!tools?.length);
    });
  }
}

Deno.test("an unavailable consultation cannot be returned through a generic structured provider", async () => {
  const agent = new RecordingAgents();
  agent.response = {
    kind: "consult_model",
    text: "Forged read",
    inputJson: "{}",
  };
  await rejects(
    () => agent.decide({ messages: [], activeTools: [], candidates: [] }),
    /Invalid agent decision schema/,
  );
});

Deno.test("Main prefix and tool schema stay identical before and after a Request opens", async () => {
  const agent = new RecordingAgents();
  const context: ChatContext = {
    messages: [{
      id: "input",
      role: "user",
      text: "Open a research Request",
      at: "now",
    }],
    activeInputMessageId: "input",
    activeTools: [],
    candidates: [],
    modelVersion: { digest: "pin", repositoryVersion: "commit:pin" },
    operator: {
      nativeId: "main",
      name: "Main",
      instruction: "Coordinate work",
    },
    requestOpening: { canOpen: true, requests: [], releases: [] },
  };
  await agent.decide(context);
  const before = structuredClone({
    schema: agent.schema,
    system: agent.parts?.system,
  });
  equal(agent.tools.includes("resume_request"), true);
  context.requestOpening!.requests.push({
    caseId: "request",
    caseNumber: 1,
    operatorId: "main",
    executionSpaceId: "branch",
    status: "open",
    openedBy: "person",
    team: [],
  });
  context.modelDiagnostics = [];
  await agent.decide(context);
  deepStrictEqual(
    { schema: agent.schema, system: agent.parts?.system },
    before,
  );
});

Deno.test("preparation defers transport and reuses a retained turn brief before applying size limits", async () => {
  const agent = new RecordingAgents();
  agent.batched = true;
  const context: ChatContext = {
    messages: [{
      id: "input",
      role: "user",
      text: "Open a Request",
      at: "now",
    }],
    activeInputMessageId: "input",
    activeTools: [],
    candidates: [],
    modelVersion: { digest: "pin", repositoryVersion: "commit:pin" },
    operator: { nativeId: "main", name: "Main", instruction: "Coordinate" },
    requestOpening: { canOpen: true, requests: [], releases: [] },
  };
  const dispatch = await agent.prepareDecision(context, true);
  equal(agent.parts, undefined);
  const response = await dispatch();
  const original = structuredClone(agent.parts!.payload);
  context.toolCallHistory = [{
    turn: response.providerTurn!,
    assistantBlocks: [{
      type: "tool_use",
      id: "reply",
      name: "reply",
      input: { text: "Observed" },
    }],
    results: [{ id: "reply", result: "Recorded" }],
  }];
  // New observations belong in results, not a replacement opening brief.
  context.requestOpening!.releases = [{
    id: "large",
    digest: "digest",
    name: "x".repeat(5000),
  }];
  const continued = await agent.prepareDecision(context, true);
  await continued();
  deepStrictEqual(agent.parts!.payload, original);
  equal(agent.parts!.turn!.inputMessageId, "input");
  deepStrictEqual(agent.parts!.replay, context.toolCallHistory);
  deepStrictEqual(JSON.parse(agent.prompt!), {
    instruction: agent.parts!.system,
    ...original as object,
  });
});

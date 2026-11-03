import { invocationAdmission } from "../../governance/tool-invocation-admission.ts";
import {
  type RetainedToolDependencyDescriptor,
  retainedToolResourceId,
} from "../../../domain/work/retained-tool-dependencies.ts";
import type { RetainedToolsPort } from "../tools/active-tools.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { listBehavior } from "../../../../test/support/tool-artifact-fixture.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
  ToolFailure,
} from "../../../domain/work/dialogue.ts";
import { ToolInvocationError } from "../../../domain/work/errors/tool-invocation.ts";
import type { BehaviorAdmission } from "../../governance/behavior-call-admission.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
import type { Candidate, ToolDraft } from "../../../domain/work/candidates.ts";
import { checkInvocation, invokeTool, reportRefusal } from "./invocation.ts";
import type {
  ConversationInvocationHost,
  ConversationTurnState,
} from "./turn-context.ts";

function model(): ExecutableModel {
  const current = executableFixture({
    projectId: "invocation-project",
    editingContextId: "invocation-context",
    rootId: "invocation-root",
    systemId: "invocation-system",
    catalogId: "invocation-catalog",
    builderId: "operator",
  });
  current.version.repositoryVersion = "commit:exact";
  current.behaviors = [listBehavior("operator")];
  return current;
}

function turn(): ConversationTurnState {
  return {
    resumedContribution: false,
    proposals: 0,
    decisions: 0,
    sourceDecision: {},
    failures: new Map(),
  };
}

function state(): SystemRuntimeState {
  return {
    id: "invocation-test",
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "fixture",
  };
}

function host(
  current: ExecutableModel,
  runtime: SystemRuntimeState,
  overrides: Record<string, unknown> = {},
): ConversationInvocationHost {
  return {
    state: runtime,
    get snapshot() {
      return structuredClone(runtime);
    },
    update: (change: (state: SystemRuntimeState) => void) => {
      change(runtime);
      return Promise.resolve();
    },
    currentModel: () => Promise.resolve(current),
    inspectModelVersion: () => Promise.resolve(current),
    say: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
    ports: {
      runner: {
        test: () => Promise.reject(new Error("unused")),
        run: () => Promise.reject(new Error("unused")),
      },
      schemaValidator: { validate: () => ({ valid: true as const }) },
    },
    invocationAdmission: () => Promise.reject(new Error("unused")),
    candidate: () => {
      throw new Error("unused");
    },
    nativeCandidate: () => false,
    ...overrides,
  } as unknown as ConversationInvocationHost;
}

const toolChoice: Extract<ChatDecision, { kind: "invoke_tool" }> = {
  kind: "invoke_tool",
  text: "Read the page",
  toolId: "tool-1",
  input: { url: "https://example.org/page" },
};

Deno.test("checkInvocation admits an exact tool call and clears any behavior check", async () => {
  const current = model();
  const runtime = state();
  const said: string[] = [];
  const admission = {
    admitted: true,
    toolId: "tool-1",
    url: "https://example.org/page",
  };
  const runtimeHost = host(current, runtime, {
    say: (text: string) => {
      said.push(text);
      return Promise.resolve();
    },
    invocationAdmission: () => Promise.resolve(structuredClone(admission)),
  });
  const turnState = turn();
  turnState.behaviorAdmission = {
    kind: "behavior",
    admitted: false,
    behaviorId: "stale",
    invocationId: "stale",
  } as BehaviorAdmission;
  const result = await checkInvocation.call(
    runtimeHost,
    turnState,
    current,
    { choice: structuredClone(toolChoice) },
  );
  deepStrictEqual(said, ["Read the page"]);
  deepStrictEqual(turnState.admission, admission);
  equal(turnState.behaviorAdmission, undefined);
  deepStrictEqual(result.outputs?.decision, admission);
});

Deno.test("checkInvocation refuses a choice that is not a call", async () => {
  const current = model();
  const runtimeHost = host(current, state());
  await rejects(
    () =>
      checkInvocation.call(runtimeHost, turn(), current, {
        choice: { kind: "reply", text: "Done" },
      }),
    /Le contrôle natif exige une demande d’appel\./,
  );
});

Deno.test("checkInvocation admits an exact behavior call and clears any tool check", async () => {
  const current = model();
  const behavior = current.behaviors![0]!;
  const runtime = state();
  const said: string[] = [];
  const runtimeHost = host(current, runtime, {
    say: (text: string) => {
      said.push(text);
      return Promise.resolve();
    },
    ports: {
      behaviors: {
        supports: () => Promise.resolve(true),
        invoke: () => Promise.reject(new Error("unused")),
      },
      runner: {
        test: () => Promise.reject(new Error("unused")),
        run: () => Promise.reject(new Error("unused")),
      },
      schemaValidator: { validate: () => ({ valid: true as const }) },
    },
  });
  const turnState = turn();
  turnState.admission = { admitted: true, toolId: "stale" };
  const choice: Extract<ChatDecision, { kind: "invoke_behavior" }> = {
    kind: "invoke_behavior",
    text: "List the published tools",
    behaviorId: behavior.id,
    inputJson: "{}",
  };
  const result = await checkInvocation.call(runtimeHost, turnState, current, {
    choice,
  });
  deepStrictEqual(said, ["List the published tools"]);
  equal(turnState.admission, undefined);
  equal(turnState.behaviorAdmission?.admitted, true);
  equal(turnState.behaviorAdmission?.behaviorId, behavior.id);
  deepStrictEqual(result.outputs?.decision, turnState.behaviorAdmission);
});

Deno.test("checkInvocation reports an unauthorized behavior instead of throwing", async () => {
  const current = model();
  const runtimeHost = host(current, state(), {
    ports: {
      behaviors: {
        supports: () => Promise.resolve(true),
        invoke: () => Promise.reject(new Error("unused")),
      },
      runner: {
        test: () => Promise.reject(new Error("unused")),
        run: () => Promise.reject(new Error("unused")),
      },
      schemaValidator: { validate: () => ({ valid: true as const }) },
    },
  });
  const turnState = turn();
  const result = await checkInvocation.call(runtimeHost, turnState, current, {
    choice: {
      kind: "invoke_behavior",
      text: "Call the unknown behavior",
      behaviorId: "unknown-behavior",
      inputJson: "{}",
    },
  });
  equal(turnState.behaviorAdmission?.admitted, false);
  equal(
    turnState.behaviorAdmission?.failure?.code,
    "BEHAVIOR_NOT_AUTHORIZED",
  );
  deepStrictEqual(result.outputs?.decision, turnState.behaviorAdmission);
});

Deno.test("reportRefusal maps a refused behavior admission", () => {
  const turnState = turn();
  turnState.behaviorAdmission = {
    kind: "behavior",
    admitted: false,
    behaviorId: "behavior-1",
    invocationId: "invocation-1",
    failure: { code: "BEHAVIOR_UNAVAILABLE", message: "No executor" },
  };
  deepStrictEqual(reportRefusal(turnState), {
    outputs: {
      outcome: {
        succeeded: false,
        code: "BEHAVIOR_UNAVAILABLE",
        details: "No executor",
        behaviorId: "behavior-1",
        behaviorFailure: true,
      },
    },
  });
});

Deno.test("reportRefusal maps a refused tool admission", () => {
  const failure: ToolFailure = {
    code: "NETWORK_SCOPE_DENIED",
    message: "Host outside the mandate",
    retryable: false,
    toolId: "tool-1",
  };
  const turnState = turn();
  turnState.admission = { admitted: false, toolId: "tool-1", failure };
  deepStrictEqual(reportRefusal(turnState), {
    outputs: {
      outcome: {
        succeeded: false,
        code: "NETWORK_SCOPE_DENIED",
        details: "Host outside the mandate",
        failure,
      },
    },
  });
});

Deno.test("reportRefusal without a refused control throws", () => {
  let caught: unknown;
  try {
    reportRefusal(turn());
  } catch (error) {
    caught = error;
  }
  equal(
    (caught as Error).message,
    "Le refus natif ne possède pas de contrôle refusé.",
  );
});

Deno.test("invokeTool rejects a behavior effect without its exact check", async () => {
  const current = model();
  const behavior = current.behaviors![0]!;
  const runtimeHost = host(current, state());
  const turnState = turn();
  turnState.chosen = {
    kind: "invoke_behavior",
    text: "List the published tools",
    behaviorId: behavior.id,
    inputJson: "{}",
  };
  turnState.behaviorAdmission = {
    kind: "behavior",
    admitted: true,
    behaviorId: behavior.id,
    invocationId: "invocation-1",
  };
  await rejects(
    () =>
      invokeTool.call(runtimeHost, turnState, current, {
        decision: {
          kind: "behavior",
          admitted: true,
          behaviorId: behavior.id,
          invocationId: "another-invocation",
        },
      }),
    /L’action native exige le contrôle exact du comportement appelé\./,
  );
});

Deno.test("invokeTool rejects a tool effect without its exact admission", async () => {
  const current = model();
  const runtimeHost = host(current, state());
  const turnState = turn();
  turnState.chosen = structuredClone(toolChoice);
  await rejects(
    () =>
      invokeTool.call(runtimeHost, turnState, current, {
        decision: { admitted: true, toolId: "another-tool" },
      }),
    /L’action native n’a pas admis cet appel exact\./,
  );
});

async function toolCandidate(ownerId: string) {
  const draft: ToolDraft = {
    name: "reader",
    description: "Reads pages",
    kind: "read_web_page",
    code: "export default ({url, html}) => ({title: url, text: html})",
  };
  const digest = await toolDraftDigest(draft);
  const manifestDigest = "ab".repeat(32);
  const prefix = `artifacts/${manifestDigest}/`;
  return {
    draft,
    candidate: {
      ...structuredClone(draft),
      id: "tool-1",
      digest,
      stage: "active" as const,
      createdAt: "2026-10-30T00:00:00.000Z",
      baseCatalogRevision: 0,
      sourceBinding: {
        version: 1 as const,
        bindingId: "binding-1",
        versionId: "version-1",
        revision: 1,
        ownerId,
        localArtifactId: "tool-1",
        invocationId: "invocation-1",
        reference: {
          version: 2 as const,
          scopeId: "scope",
          repositoryId: "repo",
          artifactId: "tool-1",
          kind: "tool-draft" as const,
          commitOid: "12".repeat(20),
          entryPath: `${prefix}source.json`,
          manifestPath: `${prefix}manifest.json`,
          contentEncoding: "tool-draft-json-v1" as const,
          contentDigest: digest,
          manifestFormat: "assembly-artifact-package-v2" as const,
          manifestDigestVersion: "sha256-canonical-json-v1" as const,
          manifestDigest,
        },
      },
    },
  };
}

function toolHost(
  current: ExecutableModel,
  candidate: Candidate,
  run: () => Promise<{ url: string; title: string; text: string }>,
) {
  const runtime = state();
  runtime.candidates = [structuredClone(candidate)];
  if (!current.catalog.some((entry) => entry.candidateId === candidate.id)) {
    current.catalog.push({
      nativeId: "native-tool",
      candidateId: candidate.id,
      digest: candidate.digest,
      name: candidate.name,
      kind: candidate.kind,
      status: "active",
      contractId: current.contracts.find((contract) =>
        contract.kind === candidate.kind
      )!.nativeId,
    });
  }
  const admission = {
    admitted: true,
    toolId: "tool-1",
    url: "https://example.org/page",
  };
  const runtimeHost = host(current, runtime, {
    invocationAdmission: () => Promise.resolve(structuredClone(admission)),
    candidate: (id: string) => {
      if (id !== candidate.id) throw new Error("unknown candidate");
      return structuredClone(candidate);
    },
    nativeCandidate: () => true,
    ports: {
      runner: {
        test: () => Promise.reject(new Error("unused")),
        run,
      },
      artifactSources: {
        resolveTool: () => Promise.reject(new Error("unused")),
      },
      schemaValidator: { validate: () => ({ valid: true as const }) },
    },
  });
  return { runtimeHost, admission };
}

Deno.test("invokeTool runs an admitted tool and records its page", async () => {
  const current = model();
  const { draft, candidate } = await toolCandidate(
    current.identity.builderId,
  );
  const page = {
    url: "https://example.org/page",
    title: "Page",
    text: "Hello",
  };
  const { runtimeHost, admission } = toolHost(
    current,
    candidate,
    () => Promise.resolve(structuredClone(page)),
  );
  runtimeHost.ports.artifactSources = {
    resolveTool: () => Promise.resolve(structuredClone(draft)),
  } as unknown as NonNullable<
    ConversationInvocationHost["ports"]["artifactSources"]
  >;
  const turnState = turn();
  turnState.chosen = structuredClone(toolChoice);
  const result = await invokeTool.call(runtimeHost, turnState, current, {
    decision: structuredClone(admission),
  });
  deepStrictEqual(result.outputs?.outcome, {
    succeeded: true,
    code: "TOOL_COMPLETED",
    details: JSON.stringify(page),
    result: page,
    toolId: "tool-1",
  });
});

Deno.test("invokeTool maps a tool failure without throwing", async () => {
  const current = model();
  const { draft, candidate } = await toolCandidate(
    current.identity.builderId,
  );
  const admission = {
    admitted: true,
    toolId: "tool-1",
    url: "https://example.org/page",
  };
  for (
    const failure of [
      new ToolInvocationError({
        code: "FETCH_TIMEOUT",
        message: "Timed out",
        retryable: true,
        toolId: "tool-1",
        url: "https://example.org/page",
      }),
      new Error("boom"),
    ]
  ) {
    const { runtimeHost } = toolHost(
      current,
      candidate,
      () => Promise.reject(failure),
    );
    runtimeHost.ports.artifactSources = {
      resolveTool: () => Promise.resolve(structuredClone(draft)),
    } as unknown as NonNullable<
      ConversationInvocationHost["ports"]["artifactSources"]
    >;
    const turnState = turn();
    turnState.chosen = structuredClone(toolChoice);
    const result = await invokeTool.call(runtimeHost, turnState, current, {
      decision: structuredClone(admission),
    });
    const outcome = result.outputs?.outcome as {
      succeeded: boolean;
      code: string;
      details: string;
      failure: ToolFailure;
    };
    equal(outcome.succeeded, false);
    equal(
      outcome.code,
      failure instanceof ToolInvocationError
        ? "FETCH_TIMEOUT"
        : "TOOL_EXECUTION_FAILED",
    );
    equal(outcome.failure.toolId, "tool-1");
    equal(outcome.failure.url, "https://example.org/page");
  }
});

async function behaviorHost(
  current: ExecutableModel,
  invoke: (request: unknown) => Promise<unknown>,
) {
  const runtime = state();
  runtime.executionModel = current;
  const runtimeHost = host(current, runtime, {
    ports: {
      behaviors: {
        supports: () => Promise.resolve(true),
        invoke,
      },
      runner: {
        test: () => Promise.reject(new Error("unused")),
        run: () => Promise.reject(new Error("unused")),
      },
      schemaValidator: { validate: () => ({ valid: true as const }) },
    },
  });
  const behavior = current.behaviors![0]!;
  const turnState = turn();
  turnState.chosen = {
    kind: "invoke_behavior",
    text: "List the published tools",
    behaviorId: behavior.id,
    inputJson: "{}",
  };
  await checkInvocation.call(runtimeHost, turnState, current, {
    choice: structuredClone(turnState.chosen),
  });
  return { runtimeHost, turnState, behavior };
}

Deno.test("invokeTool runs an admitted behavior and confirms its exact result", async () => {
  const current = model();
  let seen: unknown;
  const { runtimeHost, turnState, behavior } = await behaviorHost(
    current,
    (request: unknown) => {
      seen = request;
      return Promise.resolve({
        behaviorId: behavior.id,
        invocationId: turnState.behaviorAdmission!.invocationId,
        targetNativeId: behavior.targetNativeId,
        modelVersion: {
          digest: current.version.digest,
          repositoryVersion: current.version.repositoryVersion,
        },
        result: { status: "done", value: 1 },
      });
    },
  );
  const checked = structuredClone(turnState.behaviorAdmission!);
  const result = await invokeTool.call(runtimeHost, turnState, current, {
    decision: structuredClone(checked),
  });
  const outcome = result.outputs?.outcome as {
    succeeded: boolean;
    code: string;
    behaviorId: string;
    behaviorResult: unknown;
  };
  equal(outcome.succeeded, true);
  equal(outcome.code, "BEHAVIOR_COMPLETED");
  equal(outcome.behaviorId, behavior.id);
  deepStrictEqual(outcome.behaviorResult, {
    behaviorId: behavior.id,
    invocationId: checked.invocationId,
    targetNativeId: behavior.targetNativeId,
    modelVersion: {
      digest: current.version.digest,
      repositoryVersion: current.version.repositoryVersion,
    },
    result: { status: "done", value: 1 },
  });
  equal(
    (seen as { invocationId?: string }).invocationId,
    checked.invocationId,
  );
  equal(runtimeHost.behaviorInvocation, undefined);
});

Deno.test("invokeTool keeps an unverifiable behavior result unconfirmed", async () => {
  const current = model();
  const { runtimeHost, turnState } = await behaviorHost(
    current,
    () => Promise.reject(new Error("provider down")),
  );
  const result = await invokeTool.call(runtimeHost, turnState, current, {
    decision: structuredClone(turnState.behaviorAdmission!),
  });
  const outcome = result.outputs?.outcome as {
    succeeded: boolean;
    code: string;
    details: string;
    behaviorFailure: boolean;
  };
  equal(outcome.succeeded, false);
  equal(outcome.code, "BEHAVIOR_RESULT_UNCONFIRMED");
  equal(outcome.behaviorFailure, true);
  equal(outcome.details.includes("provider down"), true);
});

Deno.test("retained invocation uses exact source bytes without a local Candidate and refuses a changed target before runner dispatch", async () => {
  const current = model();
  current.policy.urlSelectionMode = "authorized-host";
  const { draft, candidate } = await toolCandidate(current.identity.builderId);
  current.catalog = [{
    nativeId: "native-tool",
    candidateId: candidate.id,
    digest: candidate.digest,
    name: candidate.name,
    kind: candidate.kind,
    status: "active",
    contractId: current.contracts.find((contract) =>
      contract.kind === candidate.kind
    )!.nativeId,
  }];
  const descriptor: RetainedToolDependencyDescriptor = {
    format: "request-retained-tool/v1",
    target: {
      projectId: "host",
      systemId: "system",
      executionSpaceId: "space-a",
      caseId: "case-a",
      openingId: "opening-a",
      operatorId: current.identity.builderId,
      admissionId: "admission-a",
    },
    openingBaseDigest: "a".repeat(64),
    tool: {
      candidateId: candidate.id,
      digest: candidate.digest,
      sourceBinding: candidate.sourceBinding,
    },
  };
  let selected = descriptor, calls = 0;
  const retained: RetainedToolsPort = {
    list: async () => [{
      descriptor: structuredClone(selected),
      resourceId: await retainedToolResourceId(selected),
      draft: structuredClone(draft),
    }],
  };
  const runtime = state();
  const runtimeHost = host(current, runtime);
  runtimeHost.ports.retainedTools = retained;
  runtimeHost.ports.runner.run = (tool) => {
    calls++;
    deepStrictEqual(tool, {
      ...draft,
      id: candidate.id,
      digest: candidate.digest,
    });
    return Promise.resolve({
      url: toolChoice.input.url,
      title: "Page",
      text: "Body",
    });
  };
  runtimeHost.invocationAdmission = (decision, model) =>
    invocationAdmission.call(
      {
        state: runtime,
        ports: { retainedTools: retained },
        nativeCandidate: () => false,
        userSuppliedUrl: () => true,
        update: () => Promise.resolve(),
        feedback: () => Promise.resolve(),
      },
      decision,
      model,
    );
  const checked = await runtimeHost.invocationAdmission(toolChoice, current);
  equal(checked.admitted, true);
  const turnState = turn();
  turnState.chosen = structuredClone(toolChoice);
  const result = await invokeTool.call(runtimeHost, turnState, current, {
    decision: checked,
  });
  const page = { url: toolChoice.input.url, title: "Page", text: "Body" };
  deepStrictEqual(result.outputs?.outcome, {
    succeeded: true,
    code: "TOOL_COMPLETED",
    details: JSON.stringify(page),
    result: page,
    toolId: candidate.id,
  });
  equal(calls, 1);
  deepStrictEqual(runtime.candidates, []);
  selected = {
    ...descriptor,
    target: { ...descriptor.target, executionSpaceId: "space-b" },
  };
  await rejects(
    () =>
      invokeTool.call(runtimeHost, turnState, current, { decision: checked }),
    /avant l’effet/,
  );
  equal(calls, 1);
  deepStrictEqual(runtime.candidates, []);
});

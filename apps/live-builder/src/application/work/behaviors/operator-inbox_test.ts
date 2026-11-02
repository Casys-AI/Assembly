import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type {
  BehaviorInvocationRequest,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type {
  OperatorWorkAdmission,
  OperatorWorkResult,
} from "../operators/conversations.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../domain/work/records/conversations.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { OperatorInboxBehavior } from "./operator-inbox.ts";
import { availableBehaviors } from "../../governance/behavior-call-admission.ts";

function fixture() {
  const model = executableFixture({
    projectId: "repo",
    editingContextId: "repo",
    rootId: "root",
    systemId: "coordinator-system",
    catalogId: "coordinator-catalog",
    builderId: "coordinator",
  });
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = "commit:original-source";
  const behavior: NativeBehaviorContract = {
    id: "work-exposure",
    name: "ConfierTravail",
    description: "Transmit one bounded objective to the modeled worker.",
    targetNativeId: "worker-inbox",
    targetTypeId: "inbox-type",
    inputTypeId: "work-request-type",
    callerNativeId: "coordinator",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    sourceIds: ["work-exposure", "worker-inbox"],
  };
  model.behaviors = [behavior];
  const targets = new Map([["worker-inbox", "worker"]]);
  const dispatches: Array<{
    agentId: string;
    text: string;
    correlationId: string;
    proof: OperatorWorkAdmission;
  }> = [];
  const work: OperatorWorkResult = {
    agentId: "worker",
    correlationId: "work-invocation",
    invocationId: "work-invocation",
    status: "completed",
    revision: 12,
    modelVersion: {
      digest: "b".repeat(64),
      repositoryVersion: "commit:worker-source",
    },
    messages: [],
    candidateIds: [],
  };
  const provider = new OperatorInboxBehavior({
    targets,
    resolveCallerModel: (callerId) =>
      Promise.resolve(
        callerId === "coordinator" ? structuredClone(model) : null,
      ),
    dispatch(agentId, text, correlationId, proof) {
      dispatches.push({
        agentId,
        text,
        correlationId,
        proof: structuredClone(proof),
      });
      return Promise.resolve(structuredClone(work));
    },
  });
  const request: BehaviorInvocationRequest = {
    behavior: structuredClone(behavior),
    input: { text: "Examiner le dossier transmis." },
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    },
    callerId: "coordinator",
    invocationId: "work-invocation",
  };
  return { model, behavior, targets, dispatches, work, provider, request };
}

Deno.test("an exact admitted inbox call transmits its native proof and returns separately pinned operator evidence", async () => {
  const f = fixture();
  const original = structuredClone(f.request);
  const receipt = await f.provider.invoke(f.request);
  deepStrictEqual(f.dispatches, [{
    agentId: "worker",
    text: f.request.input.text,
    correlationId: f.request.invocationId,
    proof: f.request,
  }]);
  deepStrictEqual(receipt.modelVersion, f.request.modelVersion);
  deepStrictEqual(receipt.result, f.work);
  equal(receipt.targetNativeId, "worker-inbox");
  equal(receipt.invocationId, "work-invocation");
  deepStrictEqual(f.request, original);
});

Deno.test("a delegated inbox call retains the central case and accounting context outside the native input", async () => {
  const f = fixture();
  f.request.caseId = "case-7";
  f.request.caseContext = {
    caseId: "case-7",
    modelPin: f.request.modelVersion,
    budget: {
      scopeId: "central-case",
      ownerId: "coordinator",
      policy: {
        id: "central-budget",
        revision: 1,
        unit: "agent-invocation",
        limit: 5,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
      },
    },
  };
  const result = await f.provider.invoke(f.request);
  equal(result.caseId, "case-7");
  deepStrictEqual(f.dispatches[0].proof.caseContext, f.request.caseContext);
  deepStrictEqual(Object.keys(f.request.input), ["text"]);
});

Deno.test("a different caller, target, semantic contract or unadmitted digest cannot dispatch work", async () => {
  for (
    const change of [
      "caller",
      "target",
      "contract",
      "digest",
      "invocation",
    ] as const
  ) {
    const f = fixture();
    if (change === "caller") f.request.callerId = "peer";
    if (change === "target") {
      f.targets.set("other-inbox", "other-worker");
      f.request.behavior.targetNativeId = "other-inbox";
    }
    if (change === "contract") {
      f.request.behavior.description = "Invented authority";
    }
    if (change === "digest") f.request.modelVersion.digest = "unadmitted";
    if (change === "invocation") f.request.invocationId = "";
    await rejects(() => f.provider.invoke(f.request), /modèle admis/);
    equal(f.dispatches.length, 0, change);
  }
});

Deno.test("removing the native exposure or receiver refuses calls despite their remembered identifiers", async () => {
  for (const change of ["exposure", "receiver"] as const) {
    const f = fixture();
    if (change === "exposure") f.model.behaviors = [];
    else f.targets.clear();
    equal(
      await f.provider.supports(f.request.behavior, f.request.modelVersion),
      false,
    );
    await rejects(() => f.provider.invoke(f.request));
    equal(f.dispatches.length, 0);
  }
});

Deno.test("an inbox on the caller's own sequential runtime cannot recursively address itself", async () => {
  const f = fixture();
  f.targets.set("worker-inbox", "coordinator");
  equal(await f.provider.supports(f.behavior, f.request.modelVersion), false);
  await rejects(() => f.provider.invoke(f.request));
  equal(f.dispatches.length, 0);
});

Deno.test("native text input rejects excess fields, coercion, empty objectives and oversized requests before dispatch", async () => {
  for (
    const input of [
      {},
      { text: 7 },
      { text: "  \n" },
      { text: "x".repeat(MAX_USER_MESSAGE_CHARS + 1) },
      { text: "Travail", agentId: "unmodeled-target" },
    ]
  ) {
    const f = fixture();
    await rejects(
      () => f.provider.invoke({ ...f.request, input }),
      /objectif textuel borné/,
    );
    equal(f.dispatches.length, 0);
  }
});

Deno.test("a caller-exposed alternate schema cannot substitute arbitrary payloads for a native work request", async () => {
  const f = fixture();
  f.behavior.inputSchema = {
    type: "object",
    properties: { text: { type: "string" }, grant: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  f.request.behavior = structuredClone(f.behavior);
  equal(await f.provider.supports(f.behavior, f.request.modelVersion), false);
  await rejects(() => f.provider.invoke(f.request));
  equal(f.dispatches.length, 0);
});

Deno.test("scope-equivalent source advancement never replaces the caller's original provenance pin", async () => {
  const f = fixture();
  f.model.version.repositoryVersion = "commit:peer-operational-change";
  const receipt = await f.provider.invoke(f.request);
  equal(receipt.modelVersion.repositoryVersion, "commit:original-source");
  equal(
    f.dispatches[0]!.proof.modelVersion.repositoryVersion,
    "commit:original-source",
  );
});

Deno.test("caller-owned request mutations while native admission is awaiting cannot change receiver or objective", async () => {
  const f = fixture();
  let resolve!: () => void;
  const gate = new Promise<void>((done) => resolve = done);
  const provider = new OperatorInboxBehavior({
    ...f.provider.options,
    async resolveCallerModel() {
      await gate;
      return structuredClone(f.model);
    },
  });
  const result = provider.invoke(f.request);
  f.request.input.text = "Substituted objective";
  f.request.behavior.targetNativeId = "unmodeled-target";
  resolve();
  await result;
  equal(f.dispatches[0]!.agentId, "worker");
  equal(f.dispatches[0]!.text, "Examiner le dossier transmis.");
});

Deno.test("inbox availability follows the host's current contribution scope without replacing admitted exposure", async () => {
  const f = fixture();
  const checked: Array<[string, string]> = [];
  let available = false;
  const provider = new OperatorInboxBehavior({
    ...f.provider.options,
    canContribute(callerId, targetNativeId) {
      checked.push([callerId, targetNativeId]);
      return available;
    },
  });
  equal(await provider.supports(f.behavior, f.request.modelVersion), false);
  deepStrictEqual(checked, [["coordinator", "worker-inbox"]]);
  deepStrictEqual(await availableBehaviors(f.model, provider), []);
  await rejects(() => provider.invoke(f.request), /modèle admis/);
  equal(f.dispatches.length, 0);
  available = true;
  equal(await provider.supports(f.behavior, f.request.modelVersion), true);
  deepStrictEqual(await availableBehaviors(f.model, provider), [f.behavior]);
  await provider.invoke(f.request);
  equal(f.dispatches.length, 1);
  available = false;
  equal(await provider.supports(f.behavior, f.request.modelVersion), false);
  deepStrictEqual(await availableBehaviors(f.model, provider), []);
  // The callback cannot expose a behavior absent from the admitted contract.
  available = true;
  f.model.behaviors = [];
  equal(await provider.supports(f.behavior, f.request.modelVersion), false);
  await rejects(() => provider.invoke(f.request), /modèle admis/);
  equal(f.dispatches.length, 1);
});

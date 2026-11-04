import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { operatorWorkFingerprint } from "../operators/journal.ts";
import type { ModelPort } from "../runtime/ports.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  BehaviorInvocationRequest,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { WorkArtifactObservationBehavior } from "./artifact-observation.ts";
async function fixture() {
  const model = executableFixture({
    projectId: "p",
    editingContextId: "e",
    rootId: "r",
    systemId: "s",
    catalogId: "c",
    builderId: "worker",
  });
  model.version.repositoryVersion = "pin";
  const owner = model.identity.builderId;
  const work: NativeBehaviorContract = {
    id: "work",
    name: "work",
    description: "",
    targetNativeId: "inbox",
    targetTypeId: "type",
    inputTypeId: "text",
    callerNativeId: "caller",
    inputSchema: {},
    sourceIds: [],
  };
  const behavior = {
    ...work,
    id: "read",
    targetNativeId: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workInvocationId: { type: "string" },
        workBehaviorId: { type: "string" },
        workInputDigest: { type: "string" },
        artifactName: { type: "string" },
      },
      required: [
        "workInvocationId",
        "workBehaviorId",
        "workInputDigest",
        "artifactName",
      ],
    },
  };
  const caller = structuredClone(model);
  caller.identity.builderId = "caller";
  caller.behaviors = [work, behavior];
  const version = { digest: caller.version.digest, repositoryVersion: "pin" };
  const fingerprint = operatorWorkFingerprint(owner, "objective", "inv", {
    callerId: "caller",
    invocationId: "inv",
    behavior: work,
    modelVersion: structuredClone(version),
  });
  const state = {
    revision: 7,
    model: model.identity,
    executionModel: model,
    messages: [{
      id: "m",
      role: "tool",
      text: "objective",
      at: "",
      work: {
        callerId: "caller",
        correlationId: "inv",
        invocationId: "inv",
        behaviorId: "work",
        targetNativeId: "inbox",
        modelVersion: structuredClone(version),
        fingerprint,
        priorCandidateIds: [],
      },
    }],
    events: [{
      id: "done",
      at: "",
      kind: "work",
      label: "",
      work: {
        callerId: "caller",
        correlationId: "inv",
        fingerprint,
        candidateIds: [],
        status: "completed",
      },
    }],
    candidates: [],
  } as unknown as SystemRuntimeState;
  let loads = 0;
  const adapter = new WorkArtifactObservationBehavior({
    targets: new Map([["read", owner]]),
    workTargets: new Map([["inbox", owner]]),
    resolveCallerModel: () => Promise.resolve(caller),
    target: () => ({
      store: {
        load: () => {
          loads++;
          return Promise.resolve(structuredClone(state));
        },
      },
      model: {
        ...unexpectedModelAuthoring,
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
      } as unknown as ModelPort,
    }),
  });
  const request: BehaviorInvocationRequest = {
    behavior,
    callerId: "caller",
    invocationId: "inv:observe",
    modelVersion: structuredClone(version),
    input: {
      workInvocationId: "inv",
      workBehaviorId: "work",
      workInputDigest: await executionDigest({ text: "objective" }),
      artifactName: "html-reader",
    },
  };
  return { adapter, request, state, model, loads: () => loads };
}
Deno.test("observation reads durable scoped state", async () => {
  const f = await fixture();
  const receipt = await f.adapter.invoke(f.request);
  const result = receipt.result as {
    available: boolean;
    values: Record<string, unknown>;
  };
  equal(f.loads(), 1);
  equal(result.available, true);
  equal(result.values.count, 0);
  equal("messages" in result, false);
  equal(receipt.invocationId, "inv:observe");
});
Deno.test("observation rejects invented verdict and caller", async () => {
  const f = await fixture();
  await rejects(() =>
    f.adapter.invoke({
      ...f.request,
      input: { ...f.request.input, available: true },
    })
  );
  await rejects(() => f.adapter.invoke({ ...f.request, callerId: "other" }));
});
for (const mismatch of ["input", "version", "correlation", "native"] as const) {
  Deno.test(`observation fails closed on ${mismatch}`, async () => {
    const f = await fixture();
    if (mismatch === "input") f.request.input.workInputDigest = "wrong";
    if (mismatch === "version") {
      f.state.messages[0]!.work!.modelVersion.digest = "wrong";
    }
    if (mismatch === "correlation") {
      f.state.messages[0]!.work!.correlationId = "other";
    }
    if (mismatch === "native") {
      f.state.executionModel = {
        ...f.model,
        version: { ...f.model.version, digest: "not-adopted" },
      };
    }
    const result = (await f.adapter.invoke(f.request)).result as {
      available: boolean;
      values: Record<string, unknown>;
    };
    equal(result.available, false);
    deepStrictEqual(result.values, {});
  });
}

Deno.test("reader returns raw facts without judging publication", async () => {
  const { publishedArtifact } = await import(
    "../../../../test/support/tool-artifact-fixture.ts"
  );
  for (
    const mode of [
      "valid",
      "unrelated",
      "bytes",
      "catalog",
      "binding",
      "tests",
      "ambiguous",
      "native-name",
      "native-kind",
      "native-duplicate",
      "contract-kind",
      "contract-duplicate",
    ] as const
  ) {
    const f = await fixture();
    const artifact = await publishedArtifact();
    f.model.catalog = artifact.model.catalog;
    f.model.contracts = artifact.model.contracts;
    const candidate = artifact.candidate;
    f.state.candidates.push(candidate);
    const ids =
      (f.state.events[0] as unknown as { work: { candidateIds: string[] } })
        .work.candidateIds;
    if (mode !== "unrelated") ids.push(candidate.id);
    if (mode === "bytes") candidate.code += " altered";
    if (mode === "catalog") f.model.catalog[0]!.digest = "wrong";
    if (mode === "binding") candidate.binding!.elementId = "other";
    if (mode === "tests") candidate.tests!.passed = false;
    if (mode === "native-name") f.model.catalog[0]!.name = "other-name";
    if (mode === "native-kind") {
      f.model.catalog[0]!.kind = "read_web_page_outline";
    }
    if (mode === "native-duplicate") {
      f.model.catalog.push({ ...f.model.catalog[0]! });
    }
    if (mode === "contract-kind") {
      f.model.contracts[0]!.kind = "read_web_page_outline";
    }
    if (mode === "contract-duplicate") {
      f.model.contracts.push({ ...f.model.contracts[0]! });
    }
    if (mode === "ambiguous") {
      f.state.candidates.push({ ...candidate, id: "second" });
      ids.push("second");
    }
    const result = (await f.adapter.invoke(f.request)).result as {
      available: boolean;
      values: Record<string, unknown>;
    };
    equal(result.available, true, mode);
    equal(
      result.values.count,
      mode === "unrelated" ? 0 : mode === "ambiguous" ? 2 : 1,
      mode,
    );
    if (mode === "unrelated" || mode === "ambiguous") {
      equal(result.values.name, "");
    }
    if (mode === "bytes") {
      equal(result.values.actualDigest === result.values.storedDigest, false);
    }
    if (mode === "catalog") equal(result.values.nativeDigest, "wrong");
    if (mode === "binding") equal(result.values.bindingId, "other");
    if (mode === "tests") equal(result.values.testsPassed, false);
    if (mode === "native-name") equal(result.values.nativeName, "other-name");
    if (mode === "native-kind") {
      equal(result.values.nativeKind, "read_web_page_outline");
    }
    if (mode === "native-duplicate") {
      equal(result.values.nativeCount, 2);
      equal(result.values.nativeName, "");
      equal(result.values.nativeContractCount, 0);
    }
    if (mode === "contract-kind") {
      equal(result.values.nativeContractKind, "read_web_page_outline");
    }
    if (mode === "contract-duplicate") {
      equal(result.values.nativeContractCount, 2);
      equal(result.values.nativeContractKind, "");
    }
    if (mode === "valid") {
      equal(result.values.nativeCount, 1);
      equal(result.values.nativeContractCount, 1);
      equal(result.values.nativeKind, candidate.kind);
      equal(result.values.nativeContractKind, candidate.kind);
    }
    equal("artifacts" in result, false);
    equal("activationConfirmed" in result.values, false);
  }
});

Deno.test("exact original padded input uses the new durable digest", async () => {
  const f = await fixture();
  const inputDigest = await executionDigest({ text: " objective " });
  const receipt = f.state.messages[0]!.work as unknown as {
    inputDigest?: string;
  };
  receipt.inputDigest = inputDigest;
  f.request.input.workInputDigest = inputDigest;
  const result = (await f.adapter.invoke(f.request)).result as {
    available: boolean;
  };
  equal(result.available, true);
  equal(f.state.messages[0]!.text, "objective");
});

Deno.test("tampered or malformed durable input digest fails closed", async () => {
  for (const digest of ["a".repeat(64), "invalid", "", null, 42]) {
    const f = await fixture();
    const receipt = f.state.messages[0]!.work as unknown as {
      inputDigest: unknown;
    };
    receipt.inputDigest = digest;
    const result = (await f.adapter.invoke(f.request)).result as {
      available: boolean;
      values: Record<string, unknown>;
    };
    equal(result.available, false);
    deepStrictEqual(result.values, {});
  }
});

Deno.test("legacy trimmed journals cannot recover an original padded input", async () => {
  const f = await fixture();
  f.request.input.workInputDigest = await executionDigest({
    text: " objective ",
  });
  const result = (await f.adapter.invoke(f.request)).result as {
    available: boolean;
  };
  equal(result.available, false);
});

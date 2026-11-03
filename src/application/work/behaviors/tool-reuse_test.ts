import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { PublishedToolsBehavior, ToolReuseBehavior } from "./tool-reuse.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  ToolReuseImport,
  ToolReuseReceipt,
} from "../artifacts/catalog.ts";
import {
  artifactModel,
  listBehavior,
  publishedArtifact,
  reuseBehavior,
} from "../../../../test/support/tool-artifact-fixture.ts";

async function setup() {
  const artifact = await publishedArtifact();
  const model = artifactModel("destination");
  const behavior = reuseBehavior();
  model.behaviors = [behavior, listBehavior()];
  const imports: ToolReuseImport[] = [];
  let lookups = 0;
  const receipt: ToolReuseReceipt = {
    source: {
      agentId: artifact.agentId,
      candidateId: artifact.candidate.id,
      digest: artifact.candidate.digest,
    },
    candidateId: "destination-candidate",
    candidateDigest: artifact.candidate.digest,
    correlationId: "import-one",
    stage: "awaiting-admission",
    active: false,
    testsPassed: true,
    replayed: false,
  };
  const provider = new ToolReuseBehavior({
    reuseTargetIds: new Set([behavior.targetNativeId]),
    reuseTargetOwners: new Map([[behavior.targetNativeId, "destination"]]),
    resolveCallerModel: (id) =>
      Promise.resolve(id === "destination" ? structuredClone(model) : null),
    findArtifact: () => {
      lookups++;
      return Promise.resolve(structuredClone(artifact));
    },
    importForCaller: (id, input) => {
      equal(id, "destination");
      imports.push(structuredClone(input));
      return Promise.resolve(structuredClone(receipt));
    },
  });
  const request: BehaviorInvocationRequest = {
    behavior: structuredClone(behavior),
    input: {
      sourceAgentId: artifact.agentId,
      candidateId: artifact.candidate.id,
      digest: artifact.candidate.digest,
    },
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: "commit:shared-source",
    },
    callerId: "destination",
    invocationId: "import-one",
  };
  return {
    provider,
    artifact,
    model,
    imports,
    receipt,
    request,
    get lookups() {
      return lookups;
    },
  };
}

Deno.test("tool reuse transports exact source bytes to ordinary local promotion and echoes the admitted invocation", async () => {
  const fixture = await setup();
  const result = await fixture.provider.invoke(fixture.request);
  equal(fixture.imports.length, 1);
  equal(
    fixture.imports[0]!.artifact.candidate.code,
    fixture.artifact.candidate.code,
  );
  deepStrictEqual(
    fixture.imports[0]!.artifact.candidate.sourceBinding,
    fixture.artifact.candidate.sourceBinding,
  );
  deepStrictEqual(result.modelVersion, fixture.request.modelVersion);
  equal(result.targetNativeId, fixture.request.behavior.targetNativeId);
  equal((result.result as ToolReuseReceipt).active, false);
  equal((result.result as ToolReuseReceipt).stage, "awaiting-admission");
});

Deno.test("another caller, target or semantic contract cannot import from an admitted artifact", async () => {
  for (
    const mutate of [
      (request: BehaviorInvocationRequest) => request.callerId = "source",
      (request: BehaviorInvocationRequest) =>
        request.behavior.targetNativeId = "foreign-target",
      (request: BehaviorInvocationRequest) =>
        request.modelVersion.digest = "unadmitted-digest",
      (request: BehaviorInvocationRequest) =>
        request.behavior.description = "different exposure",
    ]
  ) {
    const fixture = await setup();
    mutate(fixture.request);
    await rejects(() => fixture.provider.invoke(fixture.request));
    equal(fixture.lookups, 0);
    equal(fixture.imports.length, 0);
  }
});

Deno.test("an explicitly exposed peer import target cannot be misreported as a local import", async () => {
  const artifact = await publishedArtifact();
  const model = artifactModel("destination");
  const behavior = { ...reuseBehavior(), targetNativeId: "peer-owned-reuse" };
  model.behaviors = [behavior];
  let imports = 0, reads = 0;
  const provider = new ToolReuseBehavior({
    reuseTargetIds: new Set([behavior.targetNativeId]),
    reuseTargetOwners: new Map([[behavior.targetNativeId, "another-operator"]]),
    resolveCallerModel: () => Promise.resolve(model),
    findArtifact: () => {
      reads++;
      return Promise.resolve(artifact);
    },
    importForCaller: () => {
      imports++;
      throw new Error("A foreign native target must never execute locally");
    },
  });
  const request: BehaviorInvocationRequest = {
    behavior,
    callerId: model.identity.builderId,
    invocationId: "cross-target",
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion!,
    },
    input: {
      sourceAgentId: artifact.agentId,
      candidateId: artifact.candidate.id,
      digest: artifact.candidate.digest,
    },
  };
  equal(await provider.supports(behavior, request.modelVersion), false);
  await rejects(() => provider.invoke(request));
  equal(reads, 0);
  equal(imports, 0);
});

Deno.test("supports propagates a caller-model infrastructure failure with its code and answers false only for non-support", async () => {
  const model = artifactModel("destination");
  const behavior = listBehavior();
  model.behaviors = [behavior];
  const version = {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  };
  const failure = Object.assign(new Error("toolkit exploded"), {
    code: "TOOLKIT_TIMEOUT",
  });
  const failing = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.reject(failure),
    listArtifacts: () => Promise.resolve([]),
  });
  await rejects(
    () => failing.supports(behavior, version),
    (error: unknown) =>
      error === failure &&
      (error as { code?: unknown }).code === "TOOLKIT_TIMEOUT",
  );
  const absent = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.resolve(null),
    listArtifacts: () => Promise.resolve([]),
  });
  equal(await absent.supports(behavior, version), false);
  const supported = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.resolve(structuredClone(model)),
    listArtifacts: () => Promise.resolve([]),
  });
  equal(await supported.supports(behavior, version), true);
});

Deno.test("native input validation rejects coercion and extra authority-shaped fields before lookup", async () => {
  for (
    const input of [
      { sourceAgentId: 42, candidateId: "source-candidate", digest: "digest" },
      {
        sourceAgentId: "source",
        candidateId: "source-candidate",
        digest: "digest",
        admissionAuthority: "builder",
      },
      { sourceAgentId: "source", candidateId: "source-candidate" },
      { sourceAgentId: "", candidateId: "source-candidate", digest: "digest" },
    ]
  ) {
    const fixture = await setup();
    fixture.request.input = input;
    await rejects(() => fixture.provider.invoke(fixture.request));
    equal(fixture.lookups, 0);
  }
});

Deno.test("mismatched catalog identity or mutated bytes cannot reach local promotion", async () => {
  for (
    const mutate of [
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.artifact.agentId = "another-agent",
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.artifact.candidate.id = "another-candidate",
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.artifact.candidate.code += "\n// changed",
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.artifact.model.catalog[0]!.status = "refused",
    ]
  ) {
    const fixture = await setup();
    mutate(fixture);
    await rejects(() => fixture.provider.invoke(fixture.request));
    equal(fixture.imports.length, 0);
  }
});

Deno.test("a local refusal is returned honestly and a forged local receipt is rejected", async () => {
  const fixture = await setup();
  fixture.receipt.stage = "refused";
  fixture.receipt.testsPassed = false;
  const result = await fixture.provider.invoke(fixture.request);
  equal((result.result as ToolReuseReceipt).stage, "refused");
  fixture.receipt.active = true;
  await rejects(() => fixture.provider.invoke(fixture.request), /reçu local/);
});

Deno.test("a receipt needs a distinct local candidate and real local tests before claiming active", async () => {
  for (
    const mutate of [
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.receipt.candidateId = "",
      (fixture: Awaited<ReturnType<typeof setup>>) =>
        fixture.receipt.candidateId = fixture.artifact.candidate.id,
      (fixture: Awaited<ReturnType<typeof setup>>) => {
        fixture.receipt.stage = "active";
        fixture.receipt.active = true;
        fixture.receipt.testsPassed = null;
      },
    ]
  ) {
    const fixture = await setup();
    mutate(fixture);
    await rejects(() => fixture.provider.invoke(fixture.request), /reçu local/);
  }
});

Deno.test("a scope-equivalent global source commit does not transfer or remove local authority", async () => {
  const fixture = await setup();
  fixture.request.modelVersion.repositoryVersion =
    "commit:peer-operational-update";
  const result = await fixture.provider.invoke(fixture.request);
  equal(
    result.modelVersion.repositoryVersion,
    "commit:peer-operational-update",
  );
  equal(fixture.imports.length, 1);
});

Deno.test("published catalog lists only admitted artifact metadata without code or peer conversations", async () => {
  const fixture = await setup();
  const behavior = listBehavior();
  let reads = 0;
  const provider = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.resolve(fixture.model),
    listArtifacts: () => {
      reads++;
      return Promise.resolve([structuredClone(fixture.artifact)]);
    },
  });
  const result = await provider.invoke({
    ...fixture.request,
    behavior,
    input: {},
  });
  const artifacts =
    (result.result as { artifacts: Record<string, unknown>[] }).artifacts;
  equal(reads, 1);
  equal(artifacts.length, 1);
  deepStrictEqual(Object.keys(artifacts[0]!).sort(), [
    "candidateId",
    "description",
    "digest",
    "kind",
    "name",
    "sourceAgentId",
  ]);
  equal("code" in artifacts[0]!, false);
  equal("messages" in artifacts[0]!, false);
  equal(fixture.imports.length, 0);
});

Deno.test("published catalog consult requires its own source exposure and rejects supplied filters", async () => {
  const fixture = await setup();
  const behavior = listBehavior();
  let reads = 0;
  const provider = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.resolve(fixture.model),
    listArtifacts: () => {
      reads++;
      return Promise.resolve([fixture.artifact]);
    },
  });
  await rejects(() =>
    provider.invoke({
      ...fixture.request,
      behavior,
      input: { sourceAgentId: "source" },
    })
  );
  fixture.model.behaviors = [];
  await rejects(() =>
    provider.invoke({ ...fixture.request, behavior, input: {} })
  );
  equal(reads, 0);
});

Deno.test("published catalog refuses an invalid active record instead of exposing unverifiable metadata", async () => {
  const fixture = await setup();
  const behavior = listBehavior();
  fixture.artifact.candidate.code = "changed";
  const provider = new PublishedToolsBehavior({
    listTargetIds: new Set([behavior.targetNativeId]),
    resolveCallerModel: () => Promise.resolve(fixture.model),
    listArtifacts: () => Promise.resolve([fixture.artifact]),
  });
  await rejects(
    () => provider.invoke({ ...fixture.request, behavior, input: {} }),
    /octets/,
  );
});

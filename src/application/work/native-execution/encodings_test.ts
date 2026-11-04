import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type {
  NativeExecutionIdentity,
  NativeExecutionRequest,
} from "./contract.ts";
import {
  immutablePin,
  modelSourceReference,
  postgresExecutionThreadId,
} from "./encodings.ts";

function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  const identity: NativeExecutionIdentity = {
    operatorId: "builder",
    invocationKey: "invocation",
    scope: { kind: "request", scopeId: "space", rootRequestId: "request" },
    purpose: "conversation",
  };
  const scope = {
    projectId: "project",
    systemId: "system",
    executionSpaceId: "space",
  };
  const request: NativeExecutionRequest = {
    identity,
    model,
    flow: structuredClone(model.flows.conversation),
    maxSteps: 128,
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: "system",
        operatorId: "builder",
        revision: 3,
        modelDigest: "source-0",
      },
    },
    contribution: { id: "input:1", kind: "input", inputMessageId: "message:1" },
  };
  return { scope, identity, request };
}

// Literal witnesses captured from the ledger implementation before extraction.
Deno.test("execution thread bytes retain actual enumerable runtime scope fields", async () => {
  const { scope, identity } = fixture();
  assert.equal(
    await postgresExecutionThreadId(scope, identity),
    "execution:a98fba5485b2d54b6d075f657fb9a35db6bfd0eda67105892cb74b7371c839c6",
  );
  const runtimeScope = { ...scope, operatorId: "builder" };
  assert.equal(
    await postgresExecutionThreadId(runtimeScope, identity),
    "execution:606c71c775c6b46d2bc135cf79831ae67613f88e8dae3d2db1af2a6ea29101ac",
  );
});

Deno.test("immutable pin bytes preserve historical and explicit execution profiles", () => {
  const { request } = fixture();
  assert.equal(
    immutablePin(request),
    '{"flowOccurrenceId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","flowRootId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","identity":{"builderId":"builder","catalogId":"catalog","editingContextId":"context","projectId":"project","rootId":"root","systemId":"system"},"maxSteps":128,"profile":null,"version":{"configurationId":"test-source","configurationRevision":0,"digest":"source-0","rootId":"root","sourceIds":["native-configuration"]}}',
  );
  request.flow.executionProfile = "operator-command-v1";
  assert.equal(
    immutablePin(request),
    '{"flowOccurrenceId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","flowRootId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","identity":{"builderId":"builder","catalogId":"catalog","editingContextId":"context","projectId":"project","rootId":"root","systemId":"system"},"maxSteps":128,"profile":"operator-command-v1","version":{"configurationId":"test-source","configurationRevision":0,"digest":"source-0","rootId":"root","sourceIds":["native-configuration"]}}',
  );
  request.flow.executionProfile = "operator-command-immutable-group-v1";
  assert.equal(
    immutablePin(request),
    '{"flowOccurrenceId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","flowRootId":"4c04d8e9-804b-461e-bb9b-e93d835f9e43","identity":{"builderId":"builder","catalogId":"catalog","editingContextId":"context","projectId":"project","rootId":"root","systemId":"system"},"maxSteps":128,"profile":"operator-command-immutable-group-v1","version":{"configurationId":"test-source","configurationRevision":0,"digest":"source-0","rootId":"root","sourceIds":["native-configuration"]}}',
  );
});

Deno.test("source reference bytes preserve contribution and optional revision invocation", () => {
  const { request } = fixture();
  assert.equal(
    modelSourceReference(request),
    '{"businessRevision":{"__assemblyRuntimeRevision":{"modelDigest":"source-0","operatorId":"builder","revision":3,"systemId":"system"}},"contribution":{"id":"input:1","inputMessageId":"message:1","kind":"input"}}',
  );
  request.businessRevision.__assemblyRuntimeRevision.invocationKey =
    "invocation";
  request.contribution = { id: "resume:1", kind: "resume" };
  assert.equal(
    modelSourceReference(request),
    '{"businessRevision":{"__assemblyRuntimeRevision":{"invocationKey":"invocation","modelDigest":"source-0","operatorId":"builder","revision":3,"systemId":"system"}},"contribution":{"id":"resume:1","kind":"resume"}}',
  );
});

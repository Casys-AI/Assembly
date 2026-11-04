import { equal, ok } from "node:assert/strict";
import { AuthorityMatrixService } from "../authority-matrix.ts";
import { userSuppliedUrl } from "../tool-invocation-admission.ts";
import { ReadAuthorityMatrix } from "./authority-matrix-handler.ts";
import { AdmitBehaviorCall } from "./behavior-call-admission-handler.ts";
import { AdmitToolInvocation } from "./tool-invocation-admission-handler.ts";
import type { BehaviorInvocationPort } from "../../work/behaviors/invocation.ts";
import type { SchemaValidationPort } from "../../work/behaviors/schema-validation.ts";
import { draftDigest } from "../../work/runtime/values.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { NativeBehaviorContract } from "../../../domain/model/execution/native-contracts.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../../work/runtime/state.ts";
import {
  MATRIX_VERSION,
  matrixFixture,
} from "../../../../test/support/authority-matrix-fixtures.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";

function modelFixture(builderId = "builder"): ExecutableModel {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId,
  });
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = "commit:handler-check";
  return model;
}

Deno.test("ReadAuthorityMatrix exposes the cached matrix service", async () => {
  let computations = 0;
  const service = ReadAuthorityMatrix({
    read(version) {
      computations++;
      return Promise.resolve(matrixFixture(version));
    },
  });
  ok(service instanceof AuthorityMatrixService);
  const first = await service.read(MATRIX_VERSION);
  equal(first.version, MATRIX_VERSION);
  equal(await service.read(MATRIX_VERSION), first);
  equal(computations, 1);
});

Deno.test("AdmitBehaviorCall admits the exact modeled call and refuses unknown targets", async () => {
  const contract: NativeBehaviorContract = {
    id: "echo",
    name: "Echo",
    description: "Return input",
    callerNativeId: "builder",
    targetNativeId: "echo-flow",
    targetTypeId: "echo-type",
    inputTypeId: "echo-input",
    inputSchema: { type: "object" },
    sourceIds: ["echo"],
  };
  const model = modelFixture();
  model.behaviors = [structuredClone(contract)];
  const validator: SchemaValidationPort = {
    validate: () => ({ valid: true }),
  };
  const executor: BehaviorInvocationPort = {
    supports: () => Promise.resolve(true),
    invoke: () => Promise.reject(new Error("Admission must not invoke")),
  };
  const admitted = await AdmitBehaviorCall(
    { behaviorId: "echo", inputJson: '{"message":"Écho"}' },
    model,
    validator,
    executor,
    "handler-call",
  );
  equal(admitted.admitted, true);
  equal(admitted.behaviorId, "echo");
  equal(admitted.invocationId, "handler-call");
  const refused = await AdmitBehaviorCall(
    { behaviorId: "agent-invented-target", inputJson: "{}" },
    model,
    validator,
    executor,
  );
  equal(refused.admitted, false);
  equal(refused.failure?.code, "BEHAVIOR_NOT_AUTHORIZED");
});

Deno.test("AdmitToolInvocation admits a user-supplied URL and refuses unknown tools", async () => {
  const model = modelFixture("owner");
  model.policy.urlSelectionMode = "user-provided";
  const tool: Candidate = {
    id: "reader",
    name: "reader",
    description: "Read",
    kind: "read_web_page",
    code: "export default () => ({title:'',text:''})",
    digest: "",
    stage: "active",
    createdAt: "2026-10-24T00:00:00.000Z",
    baseCatalogRevision: 0,
  };
  tool.digest = await draftDigest(tool);
  // Active runtime candidates must match an admitted native catalog entry and
  // its unique tool contract; a local stage alone is not invocation authority.
  model.catalog.push({
    nativeId: "native-reader",
    candidateId: tool.id,
    name: tool.name,
    digest: tool.digest,
    kind: tool.kind,
    status: "active",
    contractId: model.contracts.find((contract) =>
      contract.kind === tool.kind
    )!.nativeId,
  });
  const url = "https://example.org/admitted";
  const state = {
    messages: [{
      id: "human-a",
      role: "user",
      text: `Read ${url}`,
      at: tool.createdAt,
      caseId: "a",
    }],
    candidates: [tool],
    caseInvocation: { kind: "local", caseId: "a" },
    cases: [{ id: "a", type: "request", status: "open" }],
    executionModel: model,
  } as SystemRuntimeState;
  const host = {
    state,
    nativeCandidate: () => true,
    userSuppliedUrl: (value: string) => userSuppliedUrl.call({ state }, value),
    update: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
  };
  const admitted = await AdmitToolInvocation(host, {
    kind: "invoke_tool",
    text: "Read",
    toolId: tool.id,
    input: { url },
  }, model);
  equal(admitted.admitted, true);
  equal(admitted.toolId, tool.id);
  const refused = await AdmitToolInvocation(host, {
    kind: "invoke_tool",
    text: "Read",
    toolId: "unknown-tool",
    input: { url },
  }, model);
  equal(refused.admitted, false);
  equal(refused.failure?.code, "TOOL_UNAVAILABLE");
  model.catalog = [];
  const noCatalog = await AdmitToolInvocation(host, {
    kind: "invoke_tool",
    text: "Read",
    toolId: tool.id,
    input: { url },
  }, model);
  equal(noCatalog.admitted, false);
  equal(noCatalog.failure?.code, "TOOL_UNAVAILABLE");
});

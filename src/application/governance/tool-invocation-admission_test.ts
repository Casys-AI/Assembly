import assert from "node:assert/strict";
import { executableFixture } from "../../../test/support/execution-fixture.ts";
import type { Candidate } from "../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import { draftDigest } from "../work/runtime/values.ts";
import {
  invocationAdmission,
  userSuppliedUrl,
} from "./tool-invocation-admission.ts";

Deno.test("URL admission is scoped to the current Request or admitted scheduled declaration", async () => {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "owner",
  });
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
    cases: [{ id: "a", type: "request", status: "open" }, {
      id: "b",
      type: "request",
      status: "open",
    }, {
      id: "job",
      type: "job",
      owner: "owner",
      caseTypeId: "job-type",
      status: "open",
      objective: "Summary",
      scheduling: { behaviorId: model.flows.conversation.rootNativeId },
    }],
    executionModel: model,
  } as SystemRuntimeState;
  const host = {
    state,
    nativeCandidate: () => true,
    userSuppliedUrl: (value: string) => userSuppliedUrl.call({ state }, value),
    update: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
  };
  const admit = () =>
    invocationAdmission.call(host, {
      kind: "invoke_tool",
      text: "Read",
      toolId: tool.id,
      input: { url },
    }, model);
  assert.equal((await admit()).admitted, true);
  state.caseInvocation = { kind: "local", caseId: "b" };
  assert.equal(
    (await admit()).failure?.code,
    "URL_NOT_USER_SUPPLIED",
    "Request A cannot authorize Request B",
  );
  state.caseInvocation = { kind: "local", caseId: "job" };
  state.scheduledExecution = {
    caseId: "job",
    id: "run",
    startedAt: tool.createdAt,
    previous: {},
  };
  assert.equal(
    (await admit()).failure?.code,
    "URL_NOT_USER_SUPPLIED",
    "Request A cannot authorize a scheduled execution",
  );
  state.cases![2].objective = `Changed runtime objective ${url}`;
  assert.equal(
    (await admit()).admitted,
    false,
    "A runtime objective alone is not an admitted declaration",
  );
  model.caseTypes = [{
    id: "job-type",
    name: `Read ${url}`,
    type: "job",
    envelope: "deterministic",
    ownerId: "owner",
    behaviorId: model.flows.conversation.rootNativeId,
    sourceIds: ["job-type"],
  }];
  assert.equal(
    (await admit()).admitted,
    true,
    "The admitted CaseType objective authorizes its exact URL",
  );
  model.caseTypes[0].ownerId = "other";
  assert.equal(
    (await admit()).admitted,
    false,
    "A foreign declaration grants no authority",
  );
});

Deno.test("4.8d D3: a URL in the Main Operator's opening text is never the person's selection", async () => {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "owner",
  });
  model.policy.urlSelectionMode = "user-provided";
  model.configuration.network = { allowedHosts: ["example.org"] };
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
  const url = "https://example.org/page";
  // As the BO's runtime records the MO's opening input: an operator's
  // message (origin delegation → role tool), in the Request's Case.
  const state = {
    messages: [{
      id: "initial-contribution",
      role: "tool",
      text: `Summarize ${url} for the person.`,
      at: tool.createdAt,
      caseId: "request",
    }],
    candidates: [tool],
    caseInvocation: { kind: "local", caseId: "request" },
    cases: [{ id: "request", type: "request", status: "open" }],
    executionModel: model,
  } as SystemRuntimeState;
  const host = {
    state,
    nativeCandidate: () => true,
    userSuppliedUrl: (value: string) => userSuppliedUrl.call({ state }, value),
    update: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
  };
  const admit = () =>
    invocationAdmission.call(host as never, {
      kind: "invoke_tool",
      text: "Read",
      toolId: tool.id,
      input: { url },
    }, model);
  assert.equal((await admit()).failure?.code, "URL_NOT_USER_SUPPLIED");
  // The person naming the same URL in the Case selects it.
  state.messages.push({
    id: "person",
    role: "user",
    text: `Yes, read ${url}`,
    at: tool.createdAt,
    caseId: "request",
  });
  assert.equal((await admit()).admitted, true);
});

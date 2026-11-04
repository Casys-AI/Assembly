import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { openCase } from "../../../domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  invocationAdmission,
  userSuppliedUrl,
} from "../../governance/tool-invocation-admission.ts";
import { draftDigest } from "../runtime/values.ts";
import { caseExecutionContext } from "./runtime.ts";
import { verifyTaskSourceInputContext } from "./task-source-input.ts";
async function fixture() {
  const at = "2026-10-27T00:00:00.000Z";
  function state(id: string): SystemRuntimeState {
    const model = executableFixture({
      projectId: "project",
      editingContextId: "editing",
      rootId: "root",
      systemId: id,
      catalogId: "catalog",
      builderId: id,
    });
    model.version.repositoryVersion = "admitted";
    model.policy.urlSelectionMode = "user-provided";
    return {
      id: `${id}-conversation`,
      executionModel: model,
      designer: { scopeId: `${id}-design` },
      caseInvocation: { kind: "designer", scopeId: `${id}-design` },
      cases: [],
      messages: [],
      candidates: [],
      revision: 0,
      catalogRevision: 0,
      events: [],
      busy: false,
      phase: "Ready",
      provider: "fixture",
    };
  }
  const primary = state("main"), owner = state("owner");
  const url = "https://docs.deno.com/runtime/security/";
  const text = `Read ${url}`;
  primary.messages.push({
    id: "human",
    designerScopeId: "main-design",
    role: "user",
    text,
    at,
  });
  const source = {
    kind: "human-selected-urls" as const,
    rootRequestId: "request",
    source: {
      operatorId: "main",
      conversationId: primary.id,
      designerScopeId: "main-design",
      messageId: "human",
      messageDigest: await sha256(text),
    },
    urls: [url],
  };
  const record = openCase({
    id: "request",
    number: 1,
    type: "request",
    objective: "Use the first URL",
    owner: "owner",
    openedBy: "main",
    openedFrom: {
      conversationId: primary.id,
      designerScopeId: "main-design",
      messageId: "human",
      openingId: "opening",
    },
    taskSourceInputs: [source],
    modelPin: {
      digest: owner.executionModel!.version.digest,
      repositoryVersion: "admitted",
    },
    createdAt: at,
  });
  owner.cases!.push(record);
  owner.caseInvocation = { kind: "local", caseId: record.id };
  const tool = {
    id: "reader",
    name: "reader",
    description: "Read",
    kind: "read_web_page" as const,
    code: "export default () => ({title:'',text:''})",
    digest: "",
    stage: "active" as const,
    createdAt: at,
    baseCatalogRevision: 0,
  };
  tool.digest = await draftDigest(tool);
  owner.candidates.push(tool);
  const model = owner.executionModel!;
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
  const sourceInput = record.taskSourceInputs![0];
  const verify = () =>
    verifyTaskSourceInputContext(owner, [primary, owner], primary, {
      context: caseExecutionContext(owner)!,
      inputs: record.taskSourceInputs!,
    });
  const host = {
    state: owner,
    verifyTaskSourceInputs: verify,
    userSuppliedUrl: (value: string) => userSuppliedUrl.call(host, value),
    nativeCandidate: () => true,
    update: () => Promise.resolve(),
    feedback: () => Promise.resolve(),
  };
  const admit = (value = url) =>
    invocationAdmission.call(host, {
      kind: "invoke_tool",
      text: "Read",
      toolId: tool.id,
      input: { url: value },
    }, owner.executionModel!);
  return {
    primary,
    owner,
    record,
    source: sourceInput,
    url,
    verify,
    host,
    admit,
    state,
  };
}
Deno.test("exact host source admits abbreviated Requests, preserves capture, and rechecks mandate", async () => {
  const f = await fixture();
  assert.equal((await f.admit()).admitted, true);
  const catalog = f.owner.executionModel!.catalog;
  f.owner.executionModel!.catalog = [];
  assert.equal((await f.admit()).failure?.code, "TOOL_UNAVAILABLE");
  f.owner.executionModel!.catalog = catalog;
  assert.equal(
    (await f.admit(f.url + "other")).failure?.code,
    "URL_NOT_USER_SUPPLIED",
  );
  f.primary.messages.push({
    id: "later",
    role: "user",
    text: "Later unrelated https://elsewhere.org/",
    at: "2026-10-27T00:00:01.000Z",
    designerScopeId: "main-design",
  });
  assert.equal((await f.admit()).admitted, true);
  f.owner.executionModel!.mandate.mayInvoke = false;
  assert.equal((await f.admit()).failure?.code, "TOOL_UNAVAILABLE");
});
Deno.test("source input refuses missing host proof and source/root/designer/principal forgery", async () => {
  const f = await fixture();
  assert.equal(await userSuppliedUrl.call({ state: f.owner }, f.url), false);
  const original = structuredClone(f.source);
  for (
    const mutate of [
      () => f.source.source.messageDigest = "0".repeat(64),
      () => f.source.source.designerScopeId = "other-design",
      () => f.source.source.operatorId = "other",
      () => f.source.rootRequestId = "other-request",
      () => f.source.urls = ["https://elsewhere.org/"],
    ]
  ) {
    mutate();
    assert.equal(await f.verify(), false);
    Object.assign(f.source, structuredClone(original));
  }
  f.primary.messages[0].text += " changed";
  assert.equal((await f.admit()).failure?.code, "URL_NOT_USER_SUPPLIED");
});
Deno.test("delegated contributor requires the same root and an actual journal receipt", async () => {
  const f = await fixture();
  const contributor = f.state("contributor");
  const work = {
    caseId: f.record.id,
    caseContext: caseExecutionContext(f.owner)!,
    callerId: "owner",
    correlationId: "work",
    invocationId: "invoke",
    behaviorId: "inbox",
    targetNativeId: "contributor-inbox",
    modelVersion: { digest: "model", repositoryVersion: "admitted" },
    fingerprint: "fingerprint",
    priorCandidateIds: [],
  };
  contributor.caseInvocation = { kind: "delegated", work };
  const verify = () =>
    verifyTaskSourceInputContext(
      contributor,
      [f.primary, f.owner, contributor],
      f.primary,
      {
        context: caseExecutionContext(contributor)!,
        inputs: f.record.taskSourceInputs!,
      },
    );
  assert.equal(await verify(), false);
  contributor.messages.push({
    id: "receipt",
    role: "tool",
    text: "Use first URL",
    at: "2026-10-27T00:00:00.000Z",
    caseId: f.record.id,
    work,
  });
  assert.equal(await verify(), true);
  work.caseContext.record!.taskSourceInputs![0].rootRequestId = "other-request";
  assert.equal(await verify(), false);
  work.caseContext = caseExecutionContext(f.owner)!;
  f.record.status = "closed-abandoned";
  f.record.closedAt = "2026-10-27T00:00:01.000Z";
  assert.equal(await verify(), false);
});

Deno.test("resumed source inputs require their exact receipt and actual Main human message", async () => {
  const f = await fixture();
  const text = "Use https://docs.deno.com/runtime/";
  f.primary.messages.push({
    id: "clarification",
    role: "user",
    text,
    at: "2026-10-27T00:00:01.000Z",
    designerScopeId: "main-design",
  });
  const capture = {
    kind: "human-selected-urls" as const,
    source: {
      operatorId: "main",
      conversationId: f.primary.id,
      designerScopeId: "main-design",
      messageId: "clarification",
      messageDigest: await sha256(text),
      resumeId: "clarify",
    },
    urls: ["https://docs.deno.com/runtime/"],
  };
  f.record.taskSourceInputs = [{
    ...structuredClone(capture),
    rootRequestId: f.record.id,
  }];
  assert.equal(await f.verify(), false);
  f.owner.requestResumptions = [{
    caseId: f.record.id,
    resumeId: "clarify",
    instruction: "Use first URL",
    openedBy: "main",
    conversationId: f.primary.id,
    designerScopeId: "main-design",
    taskSourceInputs: [capture],
    previousTaskSourceInputs: [f.source],
    status: "started",
  }];
  assert.equal(
    await f.verify(),
    true,
    "input is available during its durable started turn",
  );
  f.primary.messages.push({
    id: "later",
    role: "user",
    text: "Continue",
    at: "2026-10-27T00:00:02.000Z",
    designerScopeId: "main-design",
  });
  assert.equal(await f.verify(), true);
  f.owner.requestResumptions[0].taskSourceInputs![0].source.messageDigest = "0"
    .repeat(64);
  assert.equal(await f.verify(), false);
});

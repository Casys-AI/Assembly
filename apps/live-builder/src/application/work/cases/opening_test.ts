import { openCase } from "../../../domain/work/entities/cases.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { IndependentRequestResume } from "./commands/inputs.ts";
import { requestOpeningHost } from "./opening.ts";

function fixture() {
  function runtime(id: string) {
    const model = executableFixture({
      projectId: "project",
      editingContextId: "editing",
      rootId: "root",
      systemId: id,
      catalogId: "catalog",
      builderId: id,
    });
    model.version.repositoryVersion = "admitted";
    const snapshot: SystemRuntimeState = {
      id: `${id}-conversation`,
      executionModel: model,
      designer: { scopeId: `${id}-design` },
      caseInvocation: { kind: "designer", scopeId: `${id}-design` },
      cases: [],
      messages: [],
      candidates: [],
      configuration: structuredClone(model.configuration),
      revision: 0,
      catalogRevision: 0,
      events: [],
      busy: false,
      phase: "Ready",
      provider: "fixture",
    };
    const resumptions: IndependentRequestResume[] = [];
    return {
      snapshot,
      resumptions,
      resumeRequest: (input: IndependentRequestResume) => {
        resumptions.push(input);
        return Promise.resolve({
          caseId: "request",
          operatorId: id,
          status: "open" as const,
        });
      },
      /** A main Request this Main conversation opened earlier. */
      seedRequest: () => {
        snapshot.cases!.push({
          ...openCase({
            id: "opened-request",
            number: 1,
            type: "request",
            caseTypeId: "owner:request",
            objective: "Compare the sources",
            owner: id,
            openedBy: "actual-main",
            openedFrom: {
              conversationId: "actual-main-conversation",
              designerScopeId: "actual-main-design",
              openingId: "ordinary-1",
            },
            modelPin: {
              digest: model.version.digest,
              repositoryVersion: model.version.repositoryVersion,
            },
            createdAt: "2026-10-27T00:00:00.000Z",
          }),
          status: "waiting",
          firstRequestDispatched: true,
        });
      },
    };
  }
  const primary = runtime("actual-main"), owner = runtime("owner");
  const host = requestOpeningHost({
    primary,
    caller: primary,
    runtimes: () => [primary, owner],
  });
  return { primary, owner, host };
}

Deno.test("4.8d D3: only Main's design conversation lists and resumes the main Requests it opened", async () => {
  const f = fixture();
  f.owner.seedRequest();
  const nonMain = requestOpeningHost({
    primary: f.primary,
    caller: f.owner,
    runtimes: () => [f.primary, f.owner],
  });
  equal(nonMain.mainRequests(), undefined);
  f.primary.snapshot.caseInvocation = { kind: "local", caseId: "root-request" };
  equal(f.host.mainRequests(), undefined);
  await rejects(
    () =>
      f.host.resumeRequest({
        kind: "resume_request",
        text: "Continue",
        operatorId: "owner",
        caseId: "opened-request",
        resumeId: "r1",
        instruction: "Collect",
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
});

Deno.test("only Requests opened in the exact Main scope are discoverable or resumable", async () => {
  const f = fixture();
  const record = openCase({
    id: "request",
    number: 1,
    type: "request",
    caseTypeId: "owner:request",
    objective: "Compare",
    owner: "owner",
    openedBy: "actual-main",
    openedFrom: {
      conversationId: "actual-main-conversation",
      designerScopeId: "actual-main-design",
      openingId: "open-1",
    },
    modelPin: { digest: "pin" },
    createdAt: "2026-10-27T00:00:00.000Z",
  });
  f.owner.snapshot.cases = [record, {
    ...record,
    id: "other",
    number: 2,
    openedFrom: { ...record.openedFrom, designerScopeId: "other-scope" },
  }];
  deepStrictEqual(f.host.mainRequests(), [{
    caseId: "request",
    operatorId: "owner",
    status: "open",
  }]);
  const command = {
    kind: "resume_request" as const,
    text: "Continue",
    operatorId: "owner",
    caseId: "request",
    resumeId: "r1",
    instruction: "Collect",
  };
  equal((await f.host.resumeRequest(command)).caseId, "request");
  await rejects(() => f.host.resumeRequest({ ...command, caseId: "other" }), {
    code: "AUTHORITY_OUT_OF_BOUNDS",
  });
  await rejects(
    () => f.host.resumeRequest({ ...command, operatorId: "another" }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
});

Deno.test("initial operator-created Requests retain the same exact Main resumption boundaries as independent openings", async () => {
  for (const origin of ["openingId", "changeId"] as const) {
    const f = fixture();
    const record = openCase({
      id: "request",
      number: 1,
      type: "request",
      caseTypeId: "owner:request",
      objective: "Compare",
      owner: "owner",
      openedBy: "actual-main",
      openedFrom: {
        conversationId: "actual-main-conversation",
        designerScopeId: "actual-main-design",
        [origin]: "attested-origin",
      },
      modelPin: { digest: "pin" },
      createdAt: "2026-10-27T00:00:00.000Z",
    });
    f.owner.snapshot.cases = [record];
    equal(f.host.mainRequests()!.length, 1);
    const command = {
      kind: "resume_request" as const,
      text: "Continue",
      operatorId: "owner",
      caseId: "request",
      resumeId: "resume",
      instruction: "Collect",
    };
    equal((await f.host.resumeRequest(command)).caseId, "request");
    for (
      const changed of [
        { ...record, openedBy: "another-actor" },
        { ...record, owner: "another-owner" },
        {
          ...record,
          openedFrom: {
            ...record.openedFrom,
            conversationId: "another-conversation",
          },
        },
        {
          ...record,
          openedFrom: {
            ...record.openedFrom,
            designerScopeId: "another-scope",
          },
        },
        {
          ...record,
          openedFrom: { ...record.openedFrom, caseId: "parent-case" },
        },
      ]
    ) {
      f.owner.snapshot.cases = [changed];
      deepStrictEqual(f.host.mainRequests(), []);
      await rejects(() => f.host.resumeRequest(command), {
        code: "AUTHORITY_OUT_OF_BOUNDS",
      });
    }
    equal(f.owner.resumptions.length, 1);
  }
});

Deno.test("new Main clarification captures current human URLs while exact resume retry keeps its own capture", async () => {
  const f = fixture();
  f.owner.seedRequest();
  equal(
    f.owner.snapshot.cases![0].taskSourceInputs,
    undefined,
    "legacy opening has no invented URL source",
  );
  f.primary.snapshot.messages.push({
    id: "clarification",
    role: "user",
    text: "Use https://docs.deno.com/runtime/security/",
    designerScopeId: "actual-main-design",
    at: "2026-10-27T00:00:01.000Z",
  });
  const command = {
    kind: "resume_request" as const,
    operatorId: "owner",
    caseId: "opened-request",
    resumeId: "clarify-1",
    instruction: "Use the supplied URL",
    text: "Continue",
  };
  await f.host.resumeRequest(command);
  const first = f.owner.resumptions[0];
  equal(first.taskSourceInputs![0].source.messageId, "clarification");
  equal(first.taskSourceInputs![0].source.resumeId, "clarify-1");
  f.owner.snapshot.requestResumptions = [{ ...first, status: "completed" }];
  f.primary.snapshot.messages.push({
    id: "later",
    role: "user",
    text: "https://elsewhere.org/",
    designerScopeId: "actual-main-design",
    at: "2026-10-27T00:00:02.000Z",
  });
  await f.host.resumeRequest(command);
  deepStrictEqual(
    f.owner.resumptions[1].taskSourceInputs,
    first.taskSourceInputs,
  );
  f.primary.snapshot.messages.push({
    id: "continue",
    role: "user",
    text: "Continue",
    designerScopeId: "actual-main-design",
    at: "2026-10-27T00:00:03.000Z",
  });
  await f.host.resumeRequest({ ...command, resumeId: "clarify-2" });
  equal(f.owner.resumptions[2].taskSourceInputs, undefined);
});

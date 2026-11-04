import { createRequestCase } from "../../src/application/work/cases/runtime.ts";
import { requestSpaceSeed } from "../../src/application/work/runtime/initialization.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import {
  requestControlModel,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
  spaceUuid,
} from "./request-space-fixture.ts";

/** Exact admitted source/state fixture; no source compile, runtime or service. */
export async function requestReleaseFixture() {
  const base = await requestOpeningBase();
  const model = requestControlModel();
  model.version.digest = base.manifest.operators[0].modelDigest;
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  model.caseTypes = [{
    id: "request-type",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: "operator",
    sourceIds: ["request-type"],
  }];
  const record: OpeningRecord = {
    scope: { ...requestSpaceScope },
    ownerId: "owner",
    id: "opening-a",
    caseId: "case-a",
    caseNumber: 1,
    executionSpaceId: "space-a",
    branchId: spaceUuid(1),
    initialContributionId: "initial-a",
    command: {
      openingKey: "open-a",
      text: "A owns its Request",
      source: { kind: "current-main" },
    },
    commandDigest: "",
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "dispatched",
    admissionId: "admission-a",
    revision: 5,
    issues: [],
    createdAt: "2026-10-30T00:00:00.000Z",
  };
  record.commandDigest = await requestSpaceDigest({
    scope: record.scope,
    ownerId: record.ownerId,
    command: record.command,
  });
  const seed = requestSpaceSeed(record);
  const state = requestControlState();
  state.id = seed.runtimeId;
  state.model = structuredClone(model.identity);
  state.executionModel = structuredClone(model);
  state.cases = [];
  createRequestCase(
    state,
    {
      id: seed.caseId,
      caseTypeId: seed.caseTypeId,
      objective: seed.text,
      openedBy: seed.openedBy,
      openedFrom: {
        conversationId: seed.runtimeId,
        openingId: seed.openingId,
        messageId: seed.initialContributionId,
      },
    },
    { now: () => seed.createdAt },
    seed.caseNumber,
  );
  const scope = { ...record.scope, executionSpaceId: record.executionSpaceId };
  const source = {
    ...structuredClone(base.manifest.source!),
    branch: { kind: "case" as const, caseId: record.caseId },
    branchRef: `refs/heads/requests/${record.branchId}`,
  };
  const manifest = { ...structuredClone(base.manifest), origin: scope, source };
  return { record, model, state, scope, source, manifest };
}

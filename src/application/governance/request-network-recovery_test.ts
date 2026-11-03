import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  requestControlModel,
  requestControlState,
} from "../../../test/support/request-space-fixture.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import { ChangePublicationError } from "../../domain/model/publication/change.ts";
import {
  decideChange,
  type MandateChangeHost,
  reconcileChangePublications,
  resumeChangeDecisions,
} from "./mandate-change-decisions.ts";

Deno.test("Request network startup/decision recovery never falls through to Main publication or generic adoption", async () => {
  const model = requestControlModel(), state = requestControlState();
  const change: PendingChange = {
    id: "change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: model.identity.builderId,
    caseId: "case-a",
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-10-30T00:00:00.000Z",
    reason: "Read host",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
  };
  state.configuration = { ...model.configuration, changes: [change] };
  state.changeDecisionContinuations = { [change.id]: "pending" };
  let reads = 0, adopts = 0, resumes = 0;
  const unused = (): Promise<never> =>
    Promise.reject(new Error("Unexpected generic side effect"));
  const host: MandateChangeHost = {
    state,
    ports: {
      model: {
        requestChangeScope: {
          caseId: "case-a",
          operatorId: model.identity.builderId,
          executionSpaceId: "space-a",
          branchTeamSize: 0,
        },
        readExecutableModel: () => Promise.resolve(model),
        previewApprovedChange: unused,
        applyApprovedChange: unused,
        findApprovedChange: () => {
          reads++;
          return Promise.resolve(null);
        },
      },
    },
    update(change) {
      change(state);
      return Promise.resolve();
    },
    feedback: unused,
    control: unused,
    currentModel: () => Promise.resolve(model),
    adopt: () => {
      adopts++;
      return unused();
    },
    runTurn: () => {
      resumes++;
      return unused();
    },
  };
  const before = structuredClone(state);
  await reconcileChangePublications.call(host);
  deepStrictEqual(state, before);
  change.status = "approved";
  change.authority = "human";
  change.decidedAt = "2026-10-30T00:01:00.000Z";
  change.publishedCommit = `commit:${"e".repeat(40)}`;
  const published = structuredClone(state);
  await resumeChangeDecisions.call(host);
  await reconcileChangePublications.call(host);
  deepStrictEqual(state, published);
  await rejects(
    () =>
      decideChange.call(host, {
        changeId: change.id,
        expectedRevision: change.baseRevision,
        verdict: "approve",
      }),
    (error) =>
      error instanceof ChangePublicationError &&
      error.code === "PUBLICATION_NOT_APPLICABLE",
  );
  equal(reads, 0);
  equal(adopts, 0);
  equal(resumes, 0);
});

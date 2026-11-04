import { equal, throws } from "node:assert/strict";
import {
  assertRequestCreationGrantAuthorityCurrent,
  buildRequestCreationGrantAuthority,
  parseRequestCreationGrantAuthority,
  parseRequestWriteAuthority,
  requestCreationGrantAuthorityDigest,
  requestWriteAuthorityDestination,
  requestWriteAuthorityPrior,
} from "./request-delegated-authority.ts";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";

async function granted(mode?: "autonomous" | "per-creation") {
  const f = await branchAuthorityFixture();
  const change = f.teamProposal(mode);
  const { opening, admission, request } = f.snapshot;
  const facts = {
    opening,
    admission,
    request,
    space: f.space,
    branchTeamSize: 0,
    change,
  };
  const envelope = buildRequestCreationGrantAuthority({
    ...facts,
    destination: f.destination,
    capturedAt: "2026-11-01T00:00:00.000Z",
  });
  return { f, facts, envelope };
}

Deno.test("4.8e E4: a creation grant is the creator's own verified receipt, branch-scoped", async () => {
  const { envelope, f } = await granted();
  equal(envelope.kind, "request-creation-grant");
  equal(envelope.requester.executionSpaceId, "branch");
  equal(envelope.destination.executionSpaceId, "branch");
  equal(envelope.branchTeamSize, 0);
  equal(envelope.exercise.creationDelegation?.policyId, "bo-create");
  equal(envelope.exercise.creationDelegation?.changeId, "team-change");
  equal(envelope.exercise.delegation, undefined);
  // The third write-authority kind round-trips through the one decoder.
  const parsed = parseRequestWriteAuthority(structuredClone(envelope));
  equal(parsed.kind, "request-creation-grant");
  equal(
    await requestCreationGrantAuthorityDigest(envelope),
    await requestCreationGrantAuthorityDigest(
      parseRequestCreationGrantAuthority(structuredClone(envelope)),
    ),
  );
  equal(requestWriteAuthorityDestination(parsed).caseId, "case");
  equal(
    requestWriteAuthorityPrior(parsed).version.digest,
    f.snapshot.request.executionModel!.version.digest,
  );
});

Deno.test("a retained member's admitted Request can exercise its autonomous creation grant", async () => {
  const f = await branchAuthorityFixture();
  const change = f.teamProposal("autonomous");
  const { opening, admission, request } = f.snapshot;
  const model = request.executionModel!;
  model.operatorTeam = {
    parentOperatorId: "branch-owner",
    requestOwnerId: "branch-owner",
    requestId: "origin-request",
  };
  change.teamOrigin = { operatorId: "branch-owner", requestId: opening.caseId };
  admission.permissions.operatorIds = [
    "branch-owner",
    model.identity.builderId,
  ];
  admission.permissions.modelDigests = ["d".repeat(64), model.version.digest];
  const envelope = buildRequestCreationGrantAuthority({
    opening,
    admission,
    request,
    space: f.space,
    branchTeamSize: 1,
    change,
    destination: f.destination,
    capturedAt: "2026-11-01T00:00:00.000Z",
  });
  equal(envelope.exercise.creationDelegation?.caseId, opening.caseId);
  equal(envelope.priorModel.operatorTeam?.requestId, "origin-request");
  assertRequestCreationGrantAuthorityCurrent(envelope, {
    opening,
    admission,
    request,
    space: f.space,
    branchTeamSize: 1,
    change,
  });
  change.caseId = "foreign-request";
  change.teamOrigin!.requestId = "foreign-request";
  throws(() =>
    buildRequestCreationGrantAuthority({
      opening,
      admission,
      request,
      space: f.space,
      branchTeamSize: 1,
      change,
      destination: f.destination,
      capturedAt: "2026-11-01T00:00:00.000Z",
    }), { code: "AUTHORITY_OUT_OF_BOUNDS" });
});

Deno.test("4.8e E4: a per-creation grant never self-approves into a creation grant", async () => {
  const f = await branchAuthorityFixture();
  const change = f.teamProposal("per-creation");
  const { opening, admission, request } = f.snapshot;
  throws(
    () =>
      buildRequestCreationGrantAuthority({
        opening,
        admission,
        request,
        space: f.space,
        branchTeamSize: 0,
        change,
        destination: f.destination,
        capturedAt: "2026-11-01T00:00:00.000Z",
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
});

Deno.test("4.8e E4: the branch bound counts the whole team, and revocation refuses before the record", async () => {
  const { envelope, facts, f } = await granted();
  // Three members already: maxChildren 5 cannot widen the branch bound.
  throws(
    () =>
      assertRequestCreationGrantAuthorityCurrent(envelope, {
        ...facts,
        branchTeamSize: 3,
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  f.snapshot.request.executionModel!.operatorCreationPolicies = [];
  throws(
    () => assertRequestCreationGrantAuthorityCurrent(envelope, facts),
    { code: "AUTHORITY_POLICY_STALE" },
  );
  // A receipt naming another change parses alone but never revalidates.
  const { envelope: other, facts: otherFacts } = await granted();
  const forged = structuredClone(other);
  forged.exercise.creationDelegation!.changeId = "another-change";
  throws(
    () => assertRequestCreationGrantAuthorityCurrent(forged, otherFacts),
    { code: "AUTHORITY_REQUEST_STALE" },
  );
});

Deno.test("4.8e E4: a forged creation grant never parses", async () => {
  const { envelope } = await granted();
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) =>
      (value.destination as { executionSpaceId: string }).executionSpaceId =
        "main",
    (value) =>
      (value.requester as { executionSpaceId: string }).executionSpaceId =
        "other-branch",
    (value) => (value.branchTeamSize = 9),
    (value) =>
      (value.exercise as { creationDelegation: unknown }).creationDelegation =
        undefined,
    (value) => delete value.space,
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(envelope) as unknown as Record<
      string,
      unknown
    >;
    mutate(forged);
    throws(() => parseRequestCreationGrantAuthority(forged));
  }
});

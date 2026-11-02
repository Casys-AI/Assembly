import { equal, notEqual, throws } from "node:assert/strict";
import {
  assertRequestDelegatedAuthorityCurrent,
  buildRequestDelegatedAuthority,
  parseRequestDelegatedAuthority,
  requestDelegatedAuthorityDigest,
} from "./request-delegated-authority.ts";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import { requestAuthorityRoute } from "../../governance/request-authority-routing.ts";
import { mainExecutionSpace } from "../../../domain/governance/operator-authority.ts";
import type { OperatorCommandOrigin } from "../../work/operators/command-delivery.ts";

const origin = {
  effectKey: "mo-effect",
  inputMessageId: "authority-escalation:change",
} as unknown as OperatorCommandOrigin;

async function covered() {
  const f = await branchAuthorityFixture();
  f.mandate("branch");
  const { opening, admission, request, main } = f.snapshot;
  const change = request.configuration!.changes[0];
  const facts = {
    opening,
    admission,
    request,
    space: f.space,
    main: main!,
    change,
  };
  const route = () =>
    requestAuthorityRoute({
      space: f.space,
      requester: request,
      change,
      states: [request],
      root: {
        kind: "verified-opening",
        openingId: opening.id,
        parent: {
          space: mainExecutionSpace(main!.executionModel!.identity),
          state: main!,
        },
      },
    });
  const envelope = buildRequestDelegatedAuthority({
    ...facts,
    route: route(),
    destination: f.destination,
    origin,
    capturedAt: "2026-10-31T00:00:00.000Z",
  });
  return { f, facts, envelope, route };
}

Deno.test("4.8c C9: the delegated envelope names MO@main deciding for BO@branch under main's policy", async () => {
  const { envelope, f } = await covered();
  equal(envelope.decider.executionSpaceId, "main");
  equal(envelope.requester.executionSpaceId, "branch");
  equal(envelope.requester.operatorId, envelope.decider.operatorId);
  equal(envelope.policy.id, "bo-network");
  equal(envelope.destination.executionSpaceId, "branch");
  equal(envelope.exercise.delegation?.actor?.executionSpaceId, "main");
  equal(envelope.exercise.delegation?.requester?.executionSpaceId, "branch");
  equal(
    await requestDelegatedAuthorityDigest(envelope),
    await requestDelegatedAuthorityDigest(parseRequestDelegatedAuthority(
      structuredClone(envelope),
    )),
  );
  equal(f.snapshot.request.configuration!.changes[0].status, "pending");
});

Deno.test("4.8c A8: a delegated envelope with a main destination is refused", async () => {
  const { envelope } = await covered();
  const forged = structuredClone(envelope) as unknown as {
    destination: { executionSpaceId: string };
  };
  forged.destination.executionSpaceId = "main";
  throws(() => parseRequestDelegatedAuthority(forged));
});

Deno.test("4.8c C9: a forged decider, requester or exercise never parses", async () => {
  const { envelope } = await covered();
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) =>
      (value.decider as { executionSpaceId: string }).executionSpaceId =
        "branch",
    (value) =>
      (value.requester as { executionSpaceId: string }).executionSpaceId =
        "other-branch",
    (value) => (value.policy as { revision: number }).revision = 2,
    (value) =>
      (value.exercise as { delegation: { policyId: string } }).delegation
        .policyId = "another-policy",
    (value) => (value.route as { status: string }).status = "human-decision",
    (value) => delete value.origin,
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(envelope) as unknown as Record<
      string,
      unknown
    >;
    mutate(forged);
    throws(() => parseRequestDelegatedAuthority(forged));
  }
});

Deno.test("4.8c A2: revocation, a superseded policy or a flipped route refuses before the record", async () => {
  {
    const { envelope, facts } = await covered();
    facts.main.executionModel!.operatorAuthorityPolicies = [];
    throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts), {
      code: "AUTHORITY_POLICY_STALE",
    });
  }
  {
    const { envelope, facts } = await covered();
    facts.main.executionModel!.operatorAuthorityPolicies![0].revision = 2;
    throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts), {
      code: "AUTHORITY_POLICY_STALE",
    });
  }
  {
    const { envelope, facts } = await covered();
    const policy = facts.main.executionModel!.operatorAuthorityPolicies![0];
    (policy as { recipientExecutionSpaceId?: string })
      .recipientExecutionSpaceId = "other-branch";
    throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts), {
      code: "AUTHORITY_REQUEST_STALE",
    });
  }
  {
    const { envelope, facts } = await covered();
    facts.admission.status = "revoked";
    throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts), {
      code: "AUTHORITY_REQUEST_STALE",
    });
  }
  {
    const { envelope, facts } = await covered();
    facts.change.status = "approved";
    throws(() => assertRequestDelegatedAuthorityCurrent(envelope, facts), {
      code: "AUTHORITY_REQUEST_STALE",
    });
  }
  const { envelope, facts, route } = await covered();
  assertRequestDelegatedAuthorityCurrent(envelope, facts);
  notEqual(route().status, "human-decision");
});

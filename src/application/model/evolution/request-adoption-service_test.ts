import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import {
  parseRequestDelegatedAuthority,
  requestDelegatedAuthorityDigest,
} from "../source-admission/request-delegated-authority.ts";
import { RequestRuntimeAdoptionService } from "./request-adoption-service.ts";
import type {
  RequestAdoptionContext,
  RequestAdoptionDecision,
  RequestAdoptionSession,
  RequestOwnerAdoptionDossier,
} from "./request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";

/** Spec 4.8c: the host adopts the approved host delta of the MO's recorded
 * delegated decision with no session; the person's API stays the only one
 * that takes a secret. */
async function fixture() {
  const f = await requestAdoptionFixture();
  const { previous, target, intent } = f;
  const opening = {
    id: target.openingId,
    caseId: target.caseId,
    executionSpaceId: target.executionSpaceId,
    branchId: target.branchId,
    scope: target.host,
    ownerId: intent.previous.admission.ownerId,
    baseDigest: intent.openingBaseDigest,
    phase: "dispatched",
    base: {
      manifest: { source: { repositoryId: target.repositoryId } },
      requestOwner: { operatorId: target.operatorId },
    },
  } as unknown as OpeningRecord;
  const decider = {
    projectId: previous.identity.projectId,
    systemId: previous.identity.systemId,
    executionSpaceId: "main",
    operatorId: target.operatorId,
  };
  const requester = { ...decider, executionSpaceId: target.executionSpaceId };
  const policy = { id: "bo-network", revision: 1, elementId: "bo-network-el" };
  const exercise = {
    ...exerciseOwnerAuthority(previous, "mandate-change"),
    delegation: {
      actorId: decider.operatorId,
      actor: decider,
      requester,
      policyId: policy.id,
      policyRevision: policy.revision,
      policyElementId: policy.elementId,
      policyIssuer: previous.ownerAuthority!,
      requestedBy: target.operatorId,
      changeId: "change",
      caseId: target.caseId,
      requestedRights: { addNetworkHosts: ["deno.com"] },
    },
  };
  const envelope = parseRequestDelegatedAuthority({
    v: 1,
    kind: "request-delegated-authority",
    destination: {
      v: 1,
      kind: "request",
      repositoryId: target.repositoryId,
      host: target.host,
      openingId: target.openingId,
      executionSpaceId: target.executionSpaceId,
      caseId: target.caseId,
      branchId: target.branchId,
      ref: target.ref,
      expectedAdmittedSource: {
        revision: 1,
        source: intent.previous.pin.source,
        sourceDigest: "5".repeat(64),
      },
    },
    priorModel: {
      identity: previous.identity,
      version: {
        digest: previous.version.digest,
        repositoryVersion: previous.version.repositoryVersion,
      },
    },
    decider,
    requester,
    policy: {
      ...policy,
      space: {
        projectId: decider.projectId,
        systemId: decider.systemId,
        executionSpaceId: "main",
      },
    },
    route: {
      version: 2,
      changeId: "change",
      caseId: target.caseId,
      requestedBy: target.operatorId,
      requester,
      openingId: target.openingId,
      targetOperatorId: target.operatorId,
      baseRevision: 0,
      modelDigest: previous.version.digest,
      status: "actor-decision",
      designatedDecider: {
        operatorId: decider.operatorId,
        executionSpaceId: "main",
        policyId: policy.id,
        policyRevision: policy.revision,
      },
      trace: [],
    },
    origin: { effectKey: "mo-effect", inputMessageId: "notice" },
    exercise,
    capturedAt: "2026-10-30T00:00:00.000Z",
  });
  const network = {
    kind: "request-network-host-adoption/v1" as const,
    changeId: "change",
    proposalIntentDigest: "a".repeat(64),
    approvedChangeDigest: "b".repeat(64),
    addedHosts: ["deno.com"],
    sourceAdmission: {
      ...intent.candidate.sourceAdmission,
      commandId: "change",
      publicationReceiptDigest: "c".repeat(64),
      resultVersion: intent.candidate.source.version,
    },
  };
  const context: RequestAdoptionContext = {
    opening,
    target,
    binding: {
      state: { executionModel: previous } as never,
      pin: intent.previous.pin,
      admission: intent.previous.admission,
    },
    candidate: intent.candidate,
    network,
  };
  const calls: string[] = [];
  const resolved: unknown[][] = [];
  const attempts: RequestAdoptionDecision[] = [];
  const settled: Array<RequestAdoptionSession | undefined> = [];
  const stored = new Map<string, RequestOwnerAdoptionDossier>();
  const service = new RequestRuntimeAdoptionService({
    context: {
      authenticate() {
        calls.push("authenticate");
        throw new Error("A delegated adoption never authenticates a person");
      },
      ownedOpening() {
        throw new Error("A delegated adoption never reads an owned opening");
      },
      resolve() {
        throw new Error("A delegated adoption never resolves a session");
      },
      revalidateRead() {
        throw new Error("A delegated adoption never revalidates a session");
      },
      hostOpening: () => Promise.resolve(structuredClone(opening)),
      resolveDelegated: (...args) => {
        resolved.push(args);
        return Promise.resolve(structuredClone(context));
      },
      resolveCreationGrant() {
        throw new Error("A delegated adoption never resolves a creation grant");
      },
    },
    store: {
      create: (_target: unknown, dossier: RequestOwnerAdoptionDossier) => {
        stored.set(dossier.id, dossier);
        return Promise.resolve(dossier);
      },
      get: (_target: unknown, id: string) =>
        Promise.resolve(stored.get(id) ?? null),
    } as never,
    transition: {
      settleObsolete: (_dossier, session) => {
        settled.push(session);
        return Promise.resolve(null);
      },
      attempt: (dossier, decision) => {
        attempts.push(decision);
        return Promise.resolve(dossier);
      },
    },
    now: () => "2026-10-30T00:02:00.000Z",
  });
  const prepare = {
    caseId: target.caseId,
    adoptionKey: "network-key",
    expectedAdmittedVersion: intent.candidate.source.version,
    expectedExecutingDigest: intent.previous.pin.modelDigest,
    changeId: "change",
  };
  return {
    service,
    envelope,
    prepare,
    opening,
    context,
    calls,
    resolved,
    attempts,
    settled,
    stored,
    digest: await requestDelegatedAuthorityDigest(envelope),
  };
}

Deno.test("4.8c: the host prepares and resumes a delegated network adoption without any session", async () => {
  const f = await fixture();
  const prepared = await f.service.prepareNetworkDelegated(
    f.envelope,
    f.prepare,
  );
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(f.calls, []);
  assert.equal(f.resolved.length, 1);
  assert.equal(f.resolved[0][1], "change");
  assert.equal(f.resolved[0][2], f.digest);
  const [dossier] = [...f.stored.values()];
  assert.equal(
    dossier.intent.decision.kind,
    "request-delegated-adoption-decision",
  );
  assert.equal(
    dossier.intent.decision.kind === "request-delegated-adoption-decision" &&
      dossier.intent.decision.authorityDigest,
    f.digest,
  );
  assert.equal(dossier.intent.network?.changeId, "change");
  assert.deepEqual(
    dossier.intent.decision.kind === "request-delegated-adoption-decision" &&
      dossier.intent.decision.route,
    f.envelope.route,
  );
  // 4.8d D1: the adoption exercises the model's owner authority for adoption,
  // through the MO's recorded delegation, as the native commit requires.
  assert.equal(dossier.intent.decision.exercise.action, "model-adoption");
  assert.equal(
    dossier.intent.decision.exercise.delegation?.policyId,
    f.envelope.exercise.delegation?.policyId,
  );
  assert.deepEqual(f.attempts, [dossier.intent.decision]);
  const lookup = { caseId: f.prepare.caseId, adoptionKey: "network-key" };
  assert.equal(
    (await f.service.statusDelegated(f.envelope, lookup))?.status,
    "prepared",
  );
  await f.service.resumeDelegated(f.envelope, lookup);
  assert.deepEqual(f.settled, [undefined], "settled without a session");
  assert.equal(f.attempts.length, 2);
  assert.equal(f.attempts[1].kind, "request-delegated-adoption-decision");
  assert.deepEqual(f.calls, []);
});

Deno.test("Main's network delegation never adopts a creation grant", async () => {
  const f = await fixture();
  const { kind: _kind, addedHosts: _hosts, ...proof } = f.context.network!;
  delete (f.context as { network?: unknown }).network;
  Object.assign(f.context, {
    creationPolicy: { kind: "request-creation-policy-adoption/v1", ...proof },
  });
  await assert.rejects(
    () => f.service.prepareNetworkDelegated(f.envelope, f.prepare),
    { code: "FORBIDDEN" },
  );
  assert.equal(f.stored.size, 0);
  assert.equal(f.attempts.length, 0);
});

Deno.test("4.8c: a delegated decision adopts only its own change in its own Request", async () => {
  const f = await fixture();
  await assert.rejects(
    () =>
      f.service.prepareNetworkDelegated(f.envelope, {
        ...f.prepare,
        changeId: "another-change",
      }),
    { code: "FORBIDDEN" },
  );
  const foreign = structuredClone(f.envelope) as unknown as {
    destination: { openingId: string };
  };
  foreign.destination.openingId = "opening_B";
  await assert.rejects(
    () => f.service.prepareNetworkDelegated(foreign as never, f.prepare),
    { code: "FORBIDDEN" },
  );
  assert.equal(f.resolved.length, 0);
  assert.equal(f.stored.size, 0);
  // A dossier the person authorized is never resumed by a delegated decision.
  const human = await requestAdoptionFixture();
  f.stored.set(human.dossier.id, human.dossier);
  await assert.rejects(
    () =>
      f.service.resumeDelegated(f.envelope, {
        caseId: f.prepare.caseId,
        adoptionKey: human.dossier.intent.adoptionKey,
      }),
    { code: "FORBIDDEN" },
  );
  assert.deepEqual(f.settled, []);
});

/** Spec 4.8b as run for real: the development host issues a new capability on
 * every page load, so the person who accepts, then resumes, holds credentials
 * other than the one that opened the Request and its admission. */
Deno.test("4.8b: the person adopts under the unchanged admission after page reloads", async () => {
  const f = await fixture();
  const { decision } = await requestAdoptionFixture();
  const opener = decision.controller;
  const reload = (
    name: string,
    patch: Partial<RequestAdoptionSession["controller"]> = {},
  ): RequestAdoptionSession => ({
    controller: {
      ...structuredClone(opener),
      capabilityId: `capability-${name}`,
      capabilityRevision: 0,
      sessionId: `session-${name}`,
      ...patch,
    },
    sessionRevision: 0,
  });
  const sessions = new Map<string, RequestAdoptionSession>([
    ["accept-after-reload", reload("accept")],
    ["resume-after-reload", reload("resume", { capabilityRevision: 3 })],
    [
      "changed-policy",
      reload("policy", {
        authority: { ...opener.authority, policyRevision: 2 },
      }),
    ],
  ]);
  const attempts: RequestAdoptionDecision[] = [];
  const settled: Array<RequestAdoptionSession | undefined> = [];
  const stored = new Map<string, RequestOwnerAdoptionDossier>();
  const refuse = () => {
    throw new Error("A person's adoption never takes the delegated path");
  };
  const service = new RequestRuntimeAdoptionService({
    context: {
      authenticate: (secret) =>
        Promise.resolve(structuredClone(sessions.get(secret)!)),
      ownedOpening: () => Promise.resolve(structuredClone(f.opening)),
      revalidateRead: () => Promise.resolve(),
      resolve: () => Promise.resolve(structuredClone(f.context)),
      hostOpening: refuse,
      resolveDelegated: refuse,
      resolveCreationGrant: refuse,
    },
    store: {
      create: (_target: unknown, dossier: RequestOwnerAdoptionDossier) => {
        stored.set(dossier.id, dossier);
        return Promise.resolve(dossier);
      },
      get: (_target: unknown, id: string) =>
        Promise.resolve(stored.get(id) ?? null),
    } as never,
    transition: {
      settleObsolete: (_dossier, session) => {
        settled.push(session);
        return Promise.resolve(null);
      },
      attempt: (dossier, completion) => {
        attempts.push(completion);
        return Promise.resolve(dossier);
      },
    },
    now: () => "2026-10-30T00:02:00.000Z",
  });
  const prepared = await service.prepareNetwork(
    "accept-after-reload",
    f.prepare,
  );
  assert.equal(prepared.status, "prepared");
  const [dossier] = [...stored.values()];
  assert(dossier.intent.decision.kind === "request-human-adoption-decision");
  assert.equal(
    dossier.intent.previous.admission.capabilityId,
    opener.capabilityId,
    "the admission keeps the capability that opened the Request",
  );
  assert.equal(
    dossier.intent.decision.controller.capabilityId,
    "capability-accept",
  );
  const lookup = { caseId: f.prepare.caseId, adoptionKey: "network-key" };
  await service.resume("resume-after-reload", lookup);
  assert.equal(settled.length, 1);
  assert.equal(attempts.length, 2);
  assert(attempts[1].kind === "request-human-adoption-decision");
  assert.equal(attempts[1].controller.capabilityId, "capability-resume");
  // A really changed authority never adopts under the original admission.
  await assert.rejects(
    () =>
      service.prepareNetwork("changed-policy", {
        ...f.prepare,
        adoptionKey: "another-network-key",
      }),
    /unchanged exact admission required/,
  );
  await assert.rejects(
    () => service.resume("changed-policy", lookup),
    /same original human intent/,
  );
  assert.equal(stored.size, 1);
  assert.equal(attempts.length, 2);
});

Deno.test("4.8e delegated member adoption targets the requester through preparation and replay", async () => {
  const f = await fixture();
  f.opening.base!.requestOwner.operatorId = "branch-owner";
  await f.service.prepareNetworkDelegated(f.envelope, f.prepare);
  const [dossier] = [...f.stored.values()];
  assert.equal(
    dossier.intent.target.operatorId,
    f.envelope.requester.operatorId,
  );
  assert.deepEqual(f.resolved[0][3], f.envelope.requester);
  await f.service.resumeDelegated(f.envelope, {
    caseId: f.opening.caseId,
    adoptionKey: f.prepare.adoptionKey,
  });
  assert.equal(f.attempts.length, 2);
});

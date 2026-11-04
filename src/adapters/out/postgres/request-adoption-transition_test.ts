/** Controlled boundary failure exercises the real uncertain-outcome catch.
 * This unit does not claim to qualify a PostgreSQL rollback or native effect. */
import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import {
  RequestAdoptionError,
  type RequestOwnerAdoptionDossier,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { PrismaClient } from "./client.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import {
  PostgresRequestAdoptionTransition,
  requestAdoptionPermissions,
} from "./request-adoption-transition.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { errorLogProperties } from "../../../infrastructure/logging.ts";

Deno.test("member adoption preserves the BO source pin and every bystander admission digest", async () => {
  const f = await requestAdoptionFixture();
  const intent = structuredClone(f.intent);
  intent.previous.admission.permissions.operatorIds = [
    "bo",
    f.target.operatorId,
    "peer",
  ];
  intent.previous.admission.permissions.modelDigests = [
    "b".repeat(64),
    f.previous.version.digest,
    "d".repeat(64),
  ];
  const opening = {
    base: { requestOwner: { operatorId: "bo" } },
  } as OpeningRecord;
  const before = structuredClone(intent.previous.admission.permissions);
  const permission = requestAdoptionPermissions(opening, intent);
  assert.deepEqual(permission.operatorIds, before.operatorIds);
  assert.deepEqual(permission.modelDigests, [
    before.modelDigests[0],
    f.model.version.digest,
    before.modelDigests[2],
  ]);
  assert.equal(permission.sourceVersion, before.sourceVersion);
  const team = {
    ...intent,
    team: {
      kind: "request-team-creation-adoption/v1",
      changeId: "member-child",
      proposalIntentDigest: "a".repeat(64),
      approvedChangeDigest: "b".repeat(64),
      childSystemId: "new-child-system",
      sourceAdmission: {
        ...intent.candidate.sourceAdmission,
        commandId: "member-child",
        publicationReceiptDigest: "c".repeat(64),
        resultVersion: intent.candidate.source.version,
      },
      team: [
        {
          operatorId: f.target.operatorId,
          modelDigest: f.model.version.digest,
        },
        { operatorId: "peer", modelDigest: before.modelDigests[2] },
        { operatorId: "new-child", modelDigest: "e".repeat(64) },
      ],
    },
  } satisfies typeof intent;
  const added = requestAdoptionPermissions(opening, team);
  assert.deepEqual(added.operatorIds, [
    "bo",
    f.target.operatorId,
    "peer",
    "new-child",
  ]);
  assert.deepEqual(added.modelDigests, [
    before.modelDigests[0],
    f.model.version.digest,
    before.modelDigests[2],
    "e".repeat(64),
  ]);
  assert.equal(added.sourceVersion, before.sourceVersion);
  assert.deepEqual(intent.previous.admission.permissions, before);
});

Deno.test("host member adoption reserves its scoped native runtime before any transition work", async () => {
  const f = await requestAdoptionFixture();
  const requester = {
    projectId: f.previous.identity.projectId,
    systemId: f.previous.identity.systemId,
    operatorId: f.target.operatorId,
    executionSpaceId: f.target.executionSpaceId,
  };
  const decision = {
    kind: "request-delegated-adoption-decision" as const,
    authorityDigest: "7".repeat(64),
    capturedAt: f.decision.capturedAt,
    exercise: {
      ...exerciseOwnerAuthority(f.previous, "model-adoption"),
      delegation: {
        actorId: "main",
        actor: { ...requester, executionSpaceId: "main", operatorId: "main" },
        requester,
        policyId: "network",
        policyRevision: 1,
        policyElementId: "network-native",
        policyIssuer: f.previous.ownerAuthority!,
        requestedBy: f.target.operatorId,
        changeId: "change",
        caseId: f.target.caseId,
        requestedRights: { addNetworkHosts: ["deno.com"] },
      },
    },
  };
  const {
    commandDigest: _command,
    accountingDigest: _accounting,
    ...immutable
  } = f.intent;
  const body = {
    ...immutable,
    decision,
    network: {
      kind: "request-network-host-adoption/v1" as const,
      changeId: "change",
      proposalIntentDigest: "a".repeat(64),
      approvedChangeDigest: "b".repeat(64),
      addedHosts: ["deno.com"],
      sourceAdmission: {
        ...f.intent.candidate.sourceAdmission,
        commandId: "change",
        publicationReceiptDigest: "c".repeat(64),
        resultVersion: f.intent.candidate.source.version,
      },
    },
  };
  const dossier = {
    ...f.dossier,
    status: "armed" as const,
    completion: decision,
    intent: {
      ...body,
      commandDigest: await sha256(canonical(body)),
      accountingDigest: f.intent.accountingDigest,
    },
  };
  type Options = ConstructorParameters<
    typeof PostgresRequestAdoptionTransition
  >[0];
  const client = {} as PrismaClient;
  const stopped = new Error("selected member reservation");
  let selected: unknown;
  const transition = new PostgresRequestAdoptionTransition({
    client,
    primary: new PostgresPrimarySpaceControlSource(client, {
      scope: f.target.host,
      sourceSystemNativeId: f.previous.identity.systemId,
      primaryOperatorId: "bo",
    }),
    runtime: {
      withInstructionAdoptionReservation(
        _opening: unknown,
        _id: string,
        _operation: unknown,
        target: unknown,
      ) {
        selected = target;
        return Promise.reject(stopped);
      },
    } as unknown as Options["runtime"],
    store: {
      requestAdoptions: { get: () => Promise.resolve(dossier) },
    } as unknown as Options["store"],
    native: {} as Options["native"],
    binding: {} as Options["binding"],
    journal: {} as Options["journal"],
    opening: () => Promise.resolve({ id: f.target.openingId } as OpeningRecord),
    dependencies: () => {
      throw new Error("No source/native work before reservation");
    },
    now: () => f.dossier.updatedAt,
  });
  await assert.rejects(
    () => transition.attempt(dossier, decision),
    (error) => error instanceof RequestAdoptionError && error.cause === stopped,
  );
  assert.deepEqual(selected, requester);
});

Deno.test("armed adoption failure preserves the PostgreSQL code and original constraint without changing the dossier", async () => {
  const f = await requestAdoptionFixture();
  const armed: RequestOwnerAdoptionDossier = {
    ...f.dossier,
    revision: 1,
    status: "armed",
    completion: f.decision,
  };
  const before = structuredClone(armed);
  const original = Object.assign(
    new Error('new row violates check constraint "retained_constraint"'),
    {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
    },
  );
  const client = {} as PrismaClient;
  const primary = new PostgresPrimarySpaceControlSource(client, {
    scope: f.target.host,
    sourceSystemNativeId: f.previous.identity.systemId,
    primaryOperatorId: f.target.operatorId,
  });
  type Options = ConstructorParameters<
    typeof PostgresRequestAdoptionTransition
  >[0];
  let rereads = 0;
  const transition = new PostgresRequestAdoptionTransition({
    client,
    primary,
    runtime: {
      withInstructionAdoptionReservation() {
        return Promise.reject(original);
      },
    } as unknown as Options["runtime"],
    store: {
      requestAdoptions: {
        get(target: unknown, id: string) {
          rereads++;
          assert.deepEqual(target, f.target);
          assert.equal(id, armed.id);
          return Promise.resolve(armed);
        },
      },
    } as unknown as Options["store"],
    native: {} as Options["native"],
    binding: {} as Options["binding"],
    journal: {} as Options["journal"],
    opening: () => Promise.resolve({ id: f.target.openingId } as OpeningRecord),
    dependencies() {
      throw new Error("Unexpected native preparation");
    },
    now: () => armed.updatedAt,
  });
  await assert.rejects(() => transition.attempt(armed, f.decision), (error) => {
    assert(error instanceof RequestAdoptionError);
    assert.equal(error.code, "BLOCKED");
    assert.equal(
      error.message,
      "The original adoption remains armed or unknown. Inspect or resume the same key.",
    );
    assert.equal(error.cause, original);
    assert.equal(
      Object.getOwnPropertyDescriptor(error, "cause")?.enumerable,
      false,
    );
    assert.deepEqual(error.context, {
      dossierId: armed.id,
      adoptionKey: armed.intent.adoptionKey,
      cause: { code: "23514" },
    });
    assert.deepEqual(errorLogProperties(error).context, error.context);
    assert(String(errorLogProperties(error).stack).includes(original.message));
    return true;
  });
  assert.equal(rereads, 1);
  assert.deepEqual(armed, before);
});

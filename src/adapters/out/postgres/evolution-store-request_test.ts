// deno-lint-ignore-file require-await -- Recording doubles implement asynchronous Prisma ports.
import assert from "node:assert/strict";
import type { PrismaClient } from "./client.ts";
import { registerPostgresClientSchema } from "./client-schema.ts";
import { PostgresEvolutionStore } from "./evolution-store.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { requestOpeningBase } from "../../../../test/support/request-space-fixture.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { requestSpaceDigest } from "../../../domain/work/request-spaces/scope.ts";
import type { RequestAdoptionIntent } from "../../../application/model/evolution/request-adoption-ports.ts";

async function recordingStore(member = false) {
  const fixture = await requestAdoptionFixture(),
    queries: unknown[] = [],
    counts: unknown[] = [];
  const base = await requestOpeningBase();
  base.manifest.source!.repositoryId = fixture.target.repositoryId;
  if (!member) {
    base.requestOwner.operatorId = fixture.target.operatorId;
    base.manifest.operators[0].operatorId = fixture.target.operatorId;
  }
  const baseDigest = await requestSpaceDigest(base);
  const admission = structuredClone(fixture.intent.previous.admission);
  admission.baseDigest = baseDigest;
  if (member) {
    admission.permissions.operatorIds.unshift(base.requestOwner.operatorId);
    admission.permissions.modelDigests.unshift("d".repeat(64));
  }
  const intent: RequestAdoptionIntent = {
    ...fixture.intent,
    openingBaseDigest: baseDigest,
    previous: {
      ...fixture.intent.previous,
      admission: structuredClone(admission),
    },
    ...(member
      ? {
        decision: {
          kind: "request-creation-grant-adoption-decision" as const,
          authorityDigest: "e".repeat(64),
          capturedAt: fixture.decision.capturedAt,
          exercise: {
            ...fixture.decision.exercise,
            creationDelegation: {
              actorId: fixture.target.operatorId,
              requestedBy: fixture.target.operatorId,
              policyId: "creation",
              policyRevision: 1,
              policyElementId: "creation-native",
              policyIssuer: fixture.previous.ownerAuthority!,
              changeId: "create-child",
              caseId: fixture.target.caseId,
              teamOrigin: {
                operatorId: base.requestOwner.operatorId,
                requestId: fixture.target.caseId,
              },
              operator: {
                kind: "request-team-member" as const,
                instruction: "Extract a passage",
                provision: {
                  budget: {
                    maxAgentDecisions: 3,
                    maxToolProposals: 1,
                    maxFlowSteps: 20,
                  },
                  networkHosts: [],
                  mayPropose: [],
                  mayInvokeActiveCatalog: false,
                },
              },
            },
          },
        },
        team: {
          kind: "request-team-creation-adoption/v1" as const,
          changeId: "create-child",
          childSystemId: "child-system",
          proposalIntentDigest: "e".repeat(64),
          approvedChangeDigest: "f".repeat(64),
          team: [{
            operatorId: fixture.target.operatorId,
            modelDigest: fixture.model.version.digest,
          }],
          sourceAdmission: {
            ...fixture.intent.candidate.sourceAdmission,
            commandId: "create-child",
            publicationReceiptDigest: "d".repeat(64),
            resultVersion: fixture.intent.candidate.source.version,
          },
        },
      }
      : {}),
  };
  const {
    commandDigest: _command,
    accountingDigest: _accounting,
    ...immutable
  } = intent;
  Object.assign(intent, { commandDigest: await sha256(canonical(immutable)) });
  Object.assign(fixture, { intent, dossier: { ...fixture.dossier, intent } });
  const opening = {
    ...fixture.target.host,
    id: fixture.target.openingId,
    caseId: fixture.target.caseId,
    branchId: fixture.target.branchId,
    executionSpaceId: fixture.target.executionSpaceId,
    ownerId: admission.ownerId,
    admissionId: admission.id,
    baseJson: canonical(base),
    baseDigest,
    phase: "admitted",
    caseNumber: 1n,
    commandJson: "{}",
    commandDigest: "command",
    initialContributionId: "initial",
    revision: 0,
    issuesJson: "[]",
    createdAt: new Date(fixture.dossier.createdAt),
  };
  let capacity = 0;
  const writes: unknown[] = [];
  const database = {
    evolutionDossier: {
      async findMany(input: unknown) {
        queries.push(structuredClone(input));
        return [];
      },
      async findUnique() {
        return null;
      },
      async count(input: unknown) {
        counts.push(structuredClone(input));
        return capacity;
      },
      async create(input: unknown) {
        writes.push(input);
      },
    },
    spaceOpening: {
      async findUnique() {
        return opening;
      },
    },
    spaceExecutionAdmission: {
      async findFirst() {
        return {
          ...admission,
          ...admission.scope,
          authorityJson: canonical(admission.authority),
          permissionsJson: canonical(admission.permissions),
          createdAt: new Date(admission.createdAt),
          expiresAt: new Date(admission.expiresAt),
        };
      },
    },
    executionSpace: {
      async findUnique() {
        return {
          caseId: fixture.target.caseId,
          parentExecutionSpaceId: "main",
        };
      },
    },
    async $queryRaw() {
      return [{ repositoryId: fixture.target.repositoryId }];
    },
    async $transaction<T>(operation: (tx: PrismaClient) => Promise<T>) {
      return await operation(client);
    },
  };
  const client = database as unknown as PrismaClient;
  registerPostgresClientSchema(client, "request_adoption_recording");
  const store = new PostgresEvolutionStore(client, fixture.target.host);
  return {
    ...fixture,
    client,
    store,
    queries,
    counts,
    admission,
    opening,
    writes,
    setCapacity(value: number) {
      capacity = value;
    },
  };
}

Deno.test("Request adoption store accepts its owner or an admitted member independently of its current model version", async () => {
  for (const member of [false, true]) {
    const { store, target, dossier, admission, writes } = await recordingStore(
      member,
    );
    if (member) admission.permissions.modelDigests[1] = "9".repeat(64);
    assert.deepEqual(
      await store.requestAdoptions.create(target, dossier),
      dossier,
    );
    assert.equal(writes.length, 1);
  }
});

Deno.test("Request adoption store refuses unknown or foreign admitted members and preserves corruption errors", async () => {
  for (
    const variant of ["unknown", "foreign", "unverified", "corrupt"] as const
  ) {
    const { store, target, dossier, admission, opening, writes } =
      await recordingStore(true);
    if (variant === "unknown") admission.permissions.operatorIds[1] = "other";
    if (variant === "foreign") admission.executionSpaceId = "other-space";
    if (variant === "unverified") admission.permissions.modelDigests.pop();
    if (variant === "corrupt") opening.baseDigest = "0".repeat(64);
    await assert.rejects(
      () => store.requestAdoptions.create(target, dossier),
      (error: unknown) => {
        const e = error as {
          code: string;
          context?: { operatorId: string; caseId: string };
          recovery?: string;
        };
        assert.equal(
          e.code,
          variant === "corrupt"
            ? "EVOLUTION_STORE_CORRUPT"
            : "EVOLUTION_TARGET_MISMATCH",
        );
        if (variant !== "corrupt") {
          assert.equal(e.context?.operatorId, target.operatorId);
          assert.equal(e.context?.caseId, target.caseId);
          assert(e.recovery);
        }
        return true;
      },
    );
    assert.equal(writes.length, 0);
  }
});

Deno.test("Main evolution history filters typed family and Main scope before take", async () => {
  const { store, target, queries } = await recordingStore();
  await store.listRecent(target.repositoryId, 7);
  assert.deepEqual(queries[0], {
    where: {
      ...target.host,
      repositoryId: target.repositoryId,
      kind: "software-evolution-v1",
      targetScopeKey: "main",
      executionSpaceId: null,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 7,
  });
  await store.listPending(target.repositoryId);
  const pending = queries[1] as { where: Record<string, unknown> };
  assert.equal(pending.where.kind, "software-evolution-v1");
  assert.equal(pending.where.targetScopeKey, "main");
  assert.equal(pending.where.executionSpaceId, null);
});

Deno.test("Request evolution history passes exact typed scope to SQL before pagination", async () => {
  const { store, target, queries } = await recordingStore();
  await store.requestAdoptions.listRecent(target, 3);
  assert.deepEqual(queries[0], {
    where: {
      ...target.host,
      repositoryId: target.repositoryId,
      kind: "request-owner-adoption-v2",
      targetScopeKey: `request:${target.executionSpaceId}`,
      executionSpaceId: target.executionSpaceId,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 3,
  });
  assert.throws(() =>
    store.requestAdoptions.listRecent({
      ...target,
      host: { ...target.host, systemId: "foreign" },
    }, 3)
  );
  assert.equal(queries.length, 1);
});

Deno.test("Request preparation shares repository pending256 cap across both families", async () => {
  const { store, target, dossier, counts, setCapacity } =
    await recordingStore();
  setCapacity(256);
  await assert.rejects(
    () => store.requestAdoptions.create(target, dossier),
    (error: unknown) =>
      !!error && typeof error === "object" && "code" in error &&
      error.code === "EVOLUTION_STORE_FULL",
  );
  assert.equal(counts.length, 1);
  const { where } = counts[0] as { where: Record<string, unknown> };
  assert.deepEqual(Object.keys(where).sort(), [
    "projectId",
    "repositoryId",
    "status",
    "systemId",
  ]);
  assert.equal(where.repositoryId, target.repositoryId);
  assert.deepEqual(where.status, {
    in: [
      "prepared",
      "accepted",
      "armed",
      "publishing",
      "published-awaiting-adoption",
    ],
  });
});

Deno.test("Request prepared swap exposes only an opaque adapter-owned packet", async () => {
  const { store, target, dossier, client } = await recordingStore();
  const next = {
    ...dossier,
    revision: 1,
    blockers: [{ code: "BUSY", detail: "Settle R0 first" }],
  };
  const packet = await store.prepareRequestSwap(target, dossier.id, 0, next);
  assert.deepEqual(Object.keys(packet), []);
  assert(Object.isFrozen(packet));
  next.blockers[0].detail = "Changed after capture";
  // Arbitrary structural lookalikes cannot become transaction lock packets.
  await assert.rejects(() =>
    store.lockRequestMutationInTransaction(client, {} as typeof packet)
  );
});

import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { requestControlState } from "../../../../test/support/request-space-fixture.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { createScopedSoftwareDossier } from "../../../application/model/evolution/scoped-software-dossier.ts";
import type { EvolutionDossier } from "../../../application/model/evolution/ports.ts";
import { parseScopedSoftwareContext } from "../../../application/model/evolution/scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
} from "../../../application/model/evolution/scoped-software-proposal.ts";
import { registerPostgresClientSchema } from "../../out/postgres/client-schema.ts";
import type { PrismaClient } from "../../out/postgres/client.ts";
import {
  type PreparedScopedSourceEvidence,
  ScopedSoftwareCurrentAuthority,
} from "./scoped-authority.ts";

async function dossierFixture(commandId = "native-command") {
  const { target, intent, previous } = await requestAdoptionFixture();
  const { operatorId, ...destination } = target;
  const actor = {
    ...target.host,
    executionSpaceId: target.executionSpaceId,
    operatorId,
  };
  const scope = parseScopedSoftwareContext({
    format: "software-evolution-scope/v2",
    destination: {
      ...destination,
      expectedAdmittedSource: {
        revision: 1,
        source: intent.previous.pin.source,
        sourceDigest: "1".repeat(64),
      },
    },
    openingBaseDigest: intent.openingBaseDigest,
    predecessorManifestDigest:
      intent.previous.pin.sourceAdmission.manifestDigest,
    actor,
    targets: [{ target: actor, previousPin: intent.previous.pin }],
  });
  const scoped = parseScopedSoftwareProposal({
    format: "software-evolution-scoped/v2",
    context: scope,
    sourceAssessmentDigest: "a".repeat(64),
    targets: [{
      target: actor,
      candidateDigest: intent.candidate.model.version.digest,
    }],
    categories: ["instructions"],
  });
  const digest = await scopedSoftwareProposalDigest(scoped);
  const id = `software-evolution-scoped:${await sha256(
    canonical({
      format: "software-evolution-id/v2",
      host: target.host,
      repositoryId: target.repositoryId,
      preparer: actor,
      callerCommandId: commandId,
    }),
  )}`;
  const at = "2026-10-30T00:00:00.000Z";
  const draft: EvolutionDossier = {
    v: 1,
    id,
    repositoryId: target.repositoryId,
    revision: 0,
    status: "prepared",
    origin: { operatorId },
    finalizerActorId: operatorId,
    accounting: {
      id: `evolution:${target.repositoryId}:${id}`,
      agentInvocations: 0,
    },
    createdAt: at,
    updatedAt: at,
    proposal: {
      id: `proposal-${id}`,
      version: intent.candidate.source.version,
      baseVersion: intent.previous.pin.source.version,
      sourceDigest: intent.candidate.sourceDigest,
      recipeDigest: intent.candidate.build.recipe.digest,
      digest,
      scoped,
      targets: [{
        operatorId,
        previousDigest: intent.previous.pin.modelDigest,
        candidateDigest: intent.candidate.model.version.digest,
      }],
      categories: ["instructions"],
    },
    preparation: {
      act: "prepare",
      operatorNativeId: operatorId,
      systemQualifiedName: "System",
      authorityDigest: "prior",
      policyId: "policy",
      policyRevision: 1,
      mandateNativeId: "mandate-native",
      mandateId: "mandate",
      mandateRevision: 1,
      targets: [operatorId],
      categories: ["instructions"],
      proposalDigest: digest,
    },
    adoptions: [],
    blockers: [],
  };
  return {
    dossier: await createScopedSoftwareDossier(draft, scoped, {
      callerCommandId: commandId,
      callerCommandDigest: "b".repeat(64),
    }),
    model: previous,
  };
}

Deno.test("prepared software authority binds dossier, transaction and full native membership before effects", async () => {
  const { dossier, model } = await dossierFixture();
  let inTransaction = false, membershipChanged = false, sourceCalls = 0;
  let passSentinel = false;
  const sentinel = new Error("controlled boundary after native membership");
  const state = { ...requestControlState(), executionModel: model };
  const opening = {
    id: dossier.scope.destination.openingId,
    projectId: dossier.scope.destination.host.projectId,
    systemId: dossier.scope.destination.host.systemId,
    baseDigest: dossier.scope.openingBaseDigest,
    phase: "admitted",
    ownerId: "owner",
    commandJson: "{}",
    commandDigest: "digest",
    caseId: dossier.scope.destination.caseId,
    caseNumber: 1n,
    executionSpaceId: dossier.scope.destination.executionSpaceId,
    branchId: dossier.scope.destination.branchId,
    initialContributionId: "contribution",
    baseJson: null,
    admissionId: "admission",
    revision: 0,
    issuesJson: "[]",
    createdAt: new Date("2026-10-30T00:00:00.000Z"),
  };
  const tx = {
    runtimeState: {
      findFirst: () =>
        Promise.resolve({ revision: 0n, payload: JSON.stringify(state) }),
    },
    runtimeRevision: {
      findFirst: () =>
        Promise.resolve({
          revision: 0n,
          payload: JSON.stringify(state),
          runtimeStateId: state.id,
          catalogRevision: 0n,
          eventCount: 0n,
          modelPayload: JSON.stringify(state.model),
          label: "Révision 0",
          agentCount: 1n,
          activeToolCount: 0n,
          origin: "commit",
        }),
    },
    executionRun: { findMany: () => Promise.resolve([]) },
    spaceOpening: { findUnique: () => Promise.resolve(opening) },
    $queryRaw: (query: { sql: string }) => {
      if (query.sql.includes('"OperatorRuntime"')) {
        if (!passSentinel) throw sentinel;
        return Promise.resolve([{
          operatorId: dossier.scope.actor.operatorId,
        }]);
      }
      if (query.sql.includes("WITH cutoff")) {
        return Promise.resolve([{ id: "admission" }]);
      }
      return Promise.resolve(
        membershipChanged && query.sql.includes('"ExecutionEffect"')
          ? [{ payload: '{"changed":true}' }]
          : [],
      );
    },
  };
  const client = {
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn(tx);
      } finally {
        inTransaction = false;
      }
    },
  } as unknown as PrismaClient;
  registerPostgresClientSchema(client, "public");
  type Options = ConstructorParameters<
    typeof ScopedSoftwareCurrentAuthority
  >[0];
  const options = {
    client,
    primaryControl: { readLocked: () => Promise.resolve() },
    journal: { readAdmittedSource: () => Promise.resolve({}) },
    bindings: {
      readInTransaction: () =>
        Promise.resolve({
          admission: {
            id: "admission",
            revision: 1,
            capabilityId: "capability",
            permissions: { operatorIds: [dossier.scope.actor.operatorId] },
          },
        }),
    },
    repository: {
      at: () => {
        assert.equal(inTransaction, false);
        throw new Error("unexpected Git call");
      },
    },
  } as unknown as Options;
  class DeterministicCompilerAuthority extends ScopedSoftwareCurrentAuthority {
    protected override prepareSourceEvidence(): Promise<
      PreparedScopedSourceEvidence
    > {
      assert.equal(
        inTransaction,
        false,
        "compiler boundary must be outside discovery transaction",
      );
      sourceCalls++;
      return Promise.resolve(
        {
          assessment: { digest: dossier.scopedProposal.sourceAssessmentDigest },
        } as unknown as PreparedScopedSourceEvidence,
      );
    }
  }
  const authority = new DeterministicCompilerAuthority(options);
  const token = await authority.prepareCurrent(dossier);
  assert.equal(sourceCalls, 1);
  type Transaction = Parameters<
    ScopedSoftwareCurrentAuthority["assertCurrentPreparedLocked"]
  >[0];
  const locked = (
    transaction: Transaction,
    value = dossier,
    proof: object = token,
  ) => authority.assertCurrentPreparedLocked(transaction, value, proof);
  const transaction = tx as unknown as Transaction;
  await assert.rejects(
    () => locked(transaction, dossier, {}),
    /Foreign or changed prepared software authority dossier/,
  );
  const other = (await dossierFixture("other-command")).dossier;
  await assert.rejects(
    () => locked(transaction, other),
    /Foreign or changed prepared software authority dossier/,
  );
  await assert.rejects(
    () => locked(transaction),
    (error: unknown) => error === sentinel,
  );
  await assert.rejects(
    () => locked(transaction),
    (error: unknown) => error === sentinel,
  );
  await assert.rejects(
    () => locked({} as Transaction),
    /belongs to another transaction/,
  );
  membershipChanged = true;
  await assert.rejects(
    () => locked(transaction),
    /Prepared native software membership changed/,
  );
  membershipChanged = false;
  passSentinel = true;
  state.executionModel = structuredClone(model);
  state.executionModel.operator!.instruction = "Changed after preparation";
  await assert.rejects(
    () => locked(transaction),
    /Prepared actual software executable changed/,
  );
  assert.equal(sourceCalls, 1, "locked rechecks must not compile or load Git");
});

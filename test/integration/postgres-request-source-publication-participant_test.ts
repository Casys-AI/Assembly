/** PostgreSQL locking/settlement fixture with synthetic Git evidence, not Git proof. */
import assert from "node:assert/strict";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { PostgresRequestSourcePublicationParticipant } from "../../src/adapters/out/postgres/request-source-publication-participant.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { PostgresSpaceCredentials } from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { PostgresPrimarySpaceControlSource } from "../../src/adapters/out/postgres/primary-space-control-source.ts";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import { requestSpaceSeed } from "../../src/application/work/runtime/initialization.ts";
import {
  captureRequestSourceOwnerPhase,
  requestSourceOwnerAuthorityDigest,
} from "../../src/application/model/source-admission/request-source-owner.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
} from "../../src/application/model/publication/write-command-v2.ts";
import { parseRequestSourceAdmission } from "../../src/application/model/source-admission/request-source-admission.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
  type SpaceController,
} from "../../src/domain/work/request-spaces.ts";
import {
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { admissionFixture } from "../support/request-source-admission-fixture.ts";
import {
  requestControlBinding,
  requestControlModel,
  requestControlState,
  requestOpeningBase,
  requestSpaceScope as scope,
  spaceControlAuthority,
  spaceUuid,
} from "../support/request-space-fixture.ts";
import type { AdmittedSourceHead } from "../../src/adapters/out/postgres/request-source-admission-store.ts";

Deno.test({
  name:
    "Request publication checks current control and open birth; historical settlement survives revocation and closure",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...scope,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      const primary = new PostgresPrimarySpaceControlSource(client, {
        ...requestControlBinding,
        primaryOperatorId: "operator",
      });
      const primaryState = await PostgresSystemStateStore.open(
        client,
        primary.runtimeScope,
        primary,
      );
      await primaryState.save(requestControlState(), null);
      const credentials = new PostgresSpaceCredentials(client, primary),
        authority = spaceControlAuthority();
      const cap = {
        id: spaceUuid(201),
        kind: "capability" as const,
        ownerId: "owner",
        parentCapabilityId: null,
        authority,
        secretHash: "a".repeat(64),
        revision: 0,
        status: "active" as const,
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: "2026-10-29T00:00:00Z",
      };
      await credentials.insert(cap, (await primary.capture()).adoptedState);
      const session = {
        ...cap,
        id: spaceUuid(202),
        kind: "session" as const,
        parentCapabilityId: cap.id,
        secretHash: "b".repeat(64),
      };
      await credentials.insert(session);
      const controller: SpaceController = {
        ownerId: "owner",
        capabilityId: cap.id,
        capabilityRevision: 0,
        sessionId: session.id,
        authority,
      };
      const openings = new PostgresRequestSpaceStore(client, scope);
      const command = {
        openingKey: "participant",
        text: "Change this Request",
        source: { kind: "current-main" as const },
      };
      const initial = await openings.begin({
        ownerId: "owner",
        command,
        commandDigest: await requestSpaceDigest({
          scope,
          ownerId: "owner",
          command,
        }),
      });
      const base = await requestOpeningBase("c");
      let opening = await openings.selectBase({
        id: initial.id,
        ownerId: "owner",
        expectedRevision: initial.revision,
        base,
        baseDigest: await requestSpaceDigest(base),
      });
      opening = await openings.advance({
        id: opening.id,
        ownerId: "owner",
        expectedRevision: opening.revision,
        from: "source-selected",
        to: "branch-ready",
      });
      opening = await openings.advance({
        id: opening.id,
        ownerId: "owner",
        expectedRevision: opening.revision,
        from: "branch-ready",
        to: "runtime-ready",
      });
      await client.operatorRuntime.create({
        data: {
          ...scope,
          executionSpaceId: opening.executionSpaceId,
          operatorId: "operator",
        },
      });
      const stateStore = await PostgresSystemStateStore.open(client, {
        ...scope,
        executionSpaceId: opening.executionSpaceId,
        operatorId: "operator",
      });
      const model = requestControlModel();
      model.identity.projectId = `git:${base.manifest.source!.repositoryId}`;
      model.version.authoritySchema = 2;
      model.identity.systemQualifiedName = "Fixture::system";
      const seed = requestSpaceSeed(opening), state = requestControlState();
      state.id = seed.runtimeId;
      state.model = structuredClone(model.identity);
      state.executionModel = structuredClone(model);
      state.cases = [{
        id: seed.caseId,
        number: seed.caseNumber,
        type: "request",
        caseTypeId: seed.caseTypeId,
        objective: "Change this Request",
        owner: "operator",
        openedBy: seed.openedBy,
        openedFrom: {
          conversationId: seed.runtimeId,
          openingId: seed.openingId,
          messageId: seed.initialContributionId,
        },
        modelPin: {
          digest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion,
        },
        status: "open",
        createdAt: seed.createdAt,
      }];
      await stateStore.save(state, null);
      const store = new PostgresRequestSourceAdmissionStore(client),
        participant = new PostgresRequestSourcePublicationParticipant(
          client,
          primary,
        );
      const read = () =>
        client.$transaction((tx) => store.readAdmittedSource(tx, opening));
      async function context(
        head: AdmittedSourceHead,
        id: string,
        next: string,
        priorDigest: string,
        supplied = controller,
        sessionRevision = 0,
      ) {
        const skeleton = await admissionFixture(
          opening as OpeningRecord,
          head,
          id,
          next,
          priorDigest,
        );
        const prior = structuredClone(model);
        prior.version.digest = priorDigest;
        prior.version.repositoryVersion = head.source
          .version as typeof prior.version.repositoryVersion;
        const sourceContext = {
          destination: skeleton.destination,
          openingOwnerId: supplied.ownerId,
          targetOperatorId: "operator",
          priorModel: prior,
        };
        const capture = <P extends "proposal" | "acceptance">(phase: P) =>
          captureRequestSourceOwnerPhase({
            phase,
            controller: supplied,
            sessionRevision,
            context: sourceContext,
            binding: requestControlBinding,
            capturedAt: "2026-10-30T00:00:00.000Z",
          });
        const auth = {
          v: 1 as const,
          kind: "request-source-owner-authority" as const,
          proposal: capture("proposal"),
          acceptance: capture("acceptance"),
        };
        const dossier = await buildModelWriteDossierV2({
          repositoryId: head.source.repositoryId,
          commandId: id,
          kind: "accept-proposal",
          destination: skeleton.destination,
          authority: auth,
          operations: {
            kind: "whole-files",
            files: {
              v: 1,
              base: skeleton.command.approvedBase,
              baseSourceDigest: head.sourceDigest,
              files: [{
                path: "models/configuration.sysml",
                baseDigest: "b".repeat(64),
                text: "package Changed;",
              }],
            },
          },
          decision: {
            kind: "accept-proposal",
            proposalId: id,
            expectedVersion: head.source.version,
            baseVersion: head.source.version,
            proposalSourceDigest: next.repeat(64),
            proposalVersion: "proposal:1",
            author: "owner",
            decisionAuthorityExercise: auth.acceptance.exercise,
          },
          recipeDigest: skeleton.result.build.recipe.digest,
        });
        const admission = await parseRequestSourceAdmission({
          ...skeleton,
          command: dossier.command,
          commandDigest: await modelWriteCommandDigestV2(dossier.command),
          dossierDigest: await modelWriteDossierDigestV2(dossier),
          decisionDigest: dossier.command.decisionRef.digest,
          authority: auth,
          authorityDigest: await requestSourceOwnerAuthorityDigest(auth),
          result: {
            ...skeleton.result,
            model: { ...skeleton.result.model, identity: prior.identity },
          },
        });
        return { dossier, admission };
      }
      const first = await context(
        (await read()).head,
        spaceUuid(301),
        "d",
        model.version.digest,
      );
      const checkNew = (input: typeof first) =>
        client.$transaction(async (tx) => {
          await participant.assertNewLocked(tx, input);
          await participant.assertExpiryLocked(tx, input);
        });
      await checkNew(first);
      const badRevision = await context(
        (await read()).head,
        spaceUuid(302),
        "e",
        model.version.digest,
        controller,
        1,
      );
      await assert.rejects(() => checkNew(badRevision));
      const expired = {
        ...session,
        id: spaceUuid(203),
        secretHash: "d".repeat(64),
        expiresAt: "2020-01-01T00:00:00Z",
      };
      await credentials.insert(expired);
      const expiredContext = await context(
        (await read()).head,
        spaceUuid(305),
        "e",
        model.version.digest,
        { ...controller, sessionId: expired.id },
      );
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            participant.assertExpiryLocked(tx, expiredContext)
          ),
        "database clock refuses expired credentials",
      );
      const wrongOwner = await context(
        (await read()).head,
        spaceUuid(303),
        "e",
        model.version.digest,
        { ...controller, ownerId: "foreign" },
      );
      await assert.rejects(() => checkNew(wrongOwner));
      await client.$transaction((tx) => participant.appendLocked(tx, first));
      await assert.rejects(
        () => checkNew(first),
        "stale A0 cannot authorize a new effect",
      );
      const chain = await read();
      const historical = await context(
        chain.head,
        spaceUuid(304),
        "f",
        first.admission.result.model.digest,
      );
      await checkNew(historical);
      const closed = structuredClone((await stateStore.load())!);
      closed.revision++;
      closed.cases![0].status = "closed-done";
      closed.cases![0].closedAt = new Date(Date.parse(seed.createdAt) + 1000)
        .toISOString();
      await stateStore.save(closed, state.revision);
      await assert.rejects(
        () => checkNew(historical),
        "closed Case cannot authorize a new effect",
      );
      await client.spaceControlCredential.update({
        where: { id: session.id },
        data: { status: "revoked", revision: { increment: 1 } },
      });
      await assert.rejects(
        () => checkNew(historical),
        "revoked session cannot authorize a new effect",
      );
      await assert.rejects(
        () =>
          client.$transaction((tx) =>
            participant.assertExpiryLocked(tx, historical)
          ),
        "final database-clock check refuses revoked sessions",
      );
      const frozen = await stateStore.load();
      // Simulates the D3 *already verified* Git-recovery boundary. The fixture does not prove Git.
      await client.$transaction((tx) =>
        participant.appendLocked(tx, historical)
      );
      assert.equal((await read()).head.revision, 3);
      assert.deepEqual(
        await stateStore.load(),
        frozen,
        "admission must not mutate R0 or Case state",
      );
      await client.$transaction((tx) =>
        participant.appendLocked(tx, historical)
      );
      await client.$transaction((tx) => participant.appendLocked(tx, first));
      assert.deepEqual(await stateStore.load(), frozen);
    });
  },
});

Deno.test({
  name:
    "network source adoption rereads its published exact dossier and refuses missing, foreign or forged queue evidence",
  ignore: !postgresTestEnabled,
  async fn() {
    const { requestNetworkSourceAdmissionFixture } = await import(
      "../support/request-network-source-admission-fixture.ts"
    );
    const { readRequestNetworkSourceAdmissionProof } = await import(
      "../../src/adapters/out/postgres/request-source-publication-participant.ts"
    );
    const { dossier, receipt } = await requestNetworkSourceAdmissionFixture();
    const host = receipt.payload.destination.host;
    await withPostgresDatabase(async ({ client }) => {
      await seedPostgresRuntime(client, {
        ...host,
        executionSpaceId: "main",
        operatorId: "operator",
      });
      await seedPostgresRuntime(client, {
        ...host,
        executionSpaceId: receipt.payload.destination.executionSpaceId,
        operatorId: "operator",
      });
      await client.sourceRepository.create({
        data: {
          ...host,
          repositoryId: dossier.command.repositoryId,
          sourceScopeId: host.systemId,
        },
      });
      const readProof = (value = receipt) =>
        client.$transaction((tx) =>
          readRequestNetworkSourceAdmissionProof(tx, value, client)
        );
      await client.spaceManifest.create({
        data: {
          ...host,
          executionSpaceId: receipt.payload.destination.executionSpaceId,
          revision: BigInt(receipt.revision),
          kind: "source-admission",
          digest: receipt.manifestDigest,
          payload: canonical(receipt.payload),
        },
      });
      await assert.rejects(
        () => readProof(),
        "a receipt cannot invent a missing durable queue dossier",
      );
      await client.modelWriteCommand.create({
        data: {
          ...host,
          repositoryId: dossier.command.repositoryId,
          commandId: dossier.command.commandId,
          seq: 1n,
          commandDigest: receipt.payload.commandDigest,
          dossierDigest: receipt.payload.dossierDigest,
          commandJson: canonical(dossier.command),
          dossierJson: canonical(dossier),
          state: "published",
          publishedVersion: receipt.payload.result.source.version,
          enqueuedAt: new Date("2026-10-30T00:00:00.000Z"),
          updatedAt: new Date("2026-10-30T00:01:00.000Z"),
        },
      });
      const proof = await readProof();
      assert.equal(proof.changeId, dossier.command.commandId);
      assert.deepEqual(proof.addedHosts, ["docs.example.org"]);
      assert.equal(
        proof.sourceAdmission.manifestDigest,
        receipt.manifestDigest,
      );
      assert.equal(
        proof.sourceAdmission.publicationReceiptDigest,
        receipt.payload.publication.receiptDigest,
      );
      await assert.rejects(() =>
        readProof({ ...receipt, manifestDigest: "0".repeat(64) })
      );
      await assert.rejects(() => readProof({ ...receipt, revision: 1 }));
      await assert.rejects(
        () => readProof({ ...receipt, revision: 3 }),
        "a real queue dossier cannot invent another source journal ordinal",
      );
      // A coherently scoped receipt from another fixture cannot use this host's
      // row merely because its command ID/native operator matches.
      const copied = structuredClone(receipt);
      const other = {
        ...copied,
        payload: {
          ...copied.payload,
          destination: {
            ...copied.payload.destination,
            host: {
              ...copied.payload.destination.host,
              systemId: "foreign-host",
            },
          },
        },
      };
      await assert.rejects(() => readProof(other));
      assert.equal(await client.modelWriteCommand.count(), 1);
    });
  },
});

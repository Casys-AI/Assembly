import { createRequestRuntimeReaders } from "../../src/adapters/out/postgres/request-runtime-readers.ts";
/** Owned normal Toolkit/PostgreSQL witness. Controlled provider; no live server,
 * deployment, external provider or user database participates. */
import assert from "node:assert/strict";
import { requestReleaseSourceEvidence } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
} from "../support/request-source-admission-normal-host.ts";
import {
  failSourceAdmissionInTestSchema,
  normalInstructionChange,
} from "../support/request-source-admission-qualification.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { RequestSpaceRuntime } from "../../src/application/work/request-spaces/runtime.ts";
import { RequestCaseConversations } from "../../src/application/work/request-spaces/conversations.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { ModelWriteQueueEntry } from "../../src/application/model/publication/ports/out/model-write-queue.port.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import { requestSourceCommandRef } from "../../src/domain/model/editing/request-source-publication.ts";
import {
  actualRequestWorkPending,
  completeActualAdoption,
  expectActualAdoptionPrecommitFault,
  observeAdoptionNativeBoundary,
  observeAdoptionRuntimeReservation,
  observeAdoptionTransactions,
  readOwnedAdoptionRef,
} from "../support/request-adoption-diagnostics.ts";
import {
  observeSourcePublication,
  sourcePublicationError,
} from "../support/request-source-publication-diagnostics.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "Normal Request adoption atomically rolls back, recovers one receipt, and continues exact warm/cold R1 with source bytes intact",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const host = await openNormalAdmissionWitnessHost(database, {
        enableRuntimeAdoption: true,
      });
      const initial = await openInitialNormalRequest(host),
        { record, session, controller } = initial;
      const diagnostics = observeAdoptionTransactions(host.storage.client);
      database.registerCleanup(() => diagnostics.restore());
      database.registerCleanup(
        observeAdoptionNativeBoundary(initial.view.ledger, diagnostics),
      );
      database.registerCleanup(
        observeAdoptionRuntimeReservation(host.stage.runtime, diagnostics),
      );
      const transientBoundary = async () =>
        await actualRequestWorkPending(
          host.storage.client,
          {
            ...record.scope,
            executionSpaceId: record.executionSpaceId,
            operatorId: host.primaryOperatorId,
          },
          initial.view.ledger.options,
          (await host.stage.executionBindings.read(record)).state.busy,
        );
      let adoption = host.stage.adoption!;
      assert(adoption && host.stage.executedModels);
      const sibling = await openInitialNormalRequest(host);
      const main = await host.storage.client.runtimeState.findMany({
        where: { ...host.storage.scope, executionSpaceId: "main" },
      });
      const siblingBefore = await host.stage.executionBindings.read(
        sibling.record,
      );
      const b0 = record.base!.manifest.source!.sourceVersion;
      const releaseSource = {
        branch: { kind: "case" as const, caseId: record.caseId },
        sourceVersion: b0,
      };
      const releaseTagName = `adoption-b0-${crypto.randomUUID()}`;
      await host.releases.releases.createTag(session.secret, {
        source: releaseSource,
        name: releaseTagName,
      });
      const retained = await host.releases.releases.save(session.secret, {
        saveKey: `adoption-b0-${crypto.randomUUID()}`,
        tag: { mode: "existing", name: releaseTagName },
        name: "Retained B0 before instruction adoption",
        purpose: "Historical reuse witness",
        source: releaseSource,
      });
      const change = normalInstructionChange(host.source.sources);
      const proposal = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: b0,
        changes: [change],
        reason: "Admit the exact instruction for its runtime adoption witness",
      });
      const accepted = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: proposal.id,
      });
      await eventually(async () => {
        const q = await host.backend.queue.get(
          host.backend.project.id,
          accepted.commandId,
        );
        return q?.state === "published" ? q : undefined;
      });
      const admitted = await host.sourceAdmission.admittedSource(record),
        a1 = admitted.head.source.version;
      assert.equal(admitted.head.revision, 2);
      assert.equal(
        (await host.stage.executionBindings.read(record)).pin.source.version,
        b0,
      );
      const a1Digest = admitted.receipts[0].payload.result.model.digest;
      const sourceTwo = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: a1,
        changes: [{
          path: change.path,
          text: change.text.replace(
            "Request qualification witness.",
            "Request qualification witness. A later source remains separate.",
          ),
        }],
        reason:
          "Accept before adoption and append afterward with the original source predecessor",
      });
      const removeSourceFault = await failSourceAdmissionInTestSchema(
        host.storage.client,
      );
      database.registerCleanup(removeSourceFault);
      const acceptedTwo = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: sourceTwo.id,
      });
      await eventually(async () => {
        const q = await host.backend.queue.get(
          host.backend.project.id,
          acceptedTwo.commandId,
        );
        return q?.state === "retryable" ? q : undefined;
      });
      const originalSourceDossier = canonical(
        await host.backend.queue.getDossier(
          host.backend.project.id,
          acceptedTwo.commandId,
        ),
      );
      const physicalA2 = await readOwnedAdoptionRef(
          host.backend.project.projectDir,
          `refs/heads/requests/${record.branchId}`,
        ),
        commandA2 = await readOwnedAdoptionRef(
          host.backend.project.projectDir,
          requestSourceCommandRef(acceptedTwo.commandId),
        ),
        stillAdmitted = await host.sourceAdmission.admittedSource(record);
      assert.equal(physicalA2, commandA2);
      assert.notEqual(physicalA2, a1);
      assert.equal(stillAdmitted.head.source.version, a1);
      console.info(
        "Owned pending source boundary",
        JSON.stringify({
          physicalA2,
          commandA2,
          admitted: stillAdmitted.head.source.version,
          execution:
            (await host.stage.executionBindings.read(record)).pin.source
              .version,
          commandId: acceptedTwo.commandId,
        }),
      );
      const where = {
        ...record.scope,
        executionSpaceId: record.executionSpaceId,
      };
      const sqlFacts = async () => ({
        states: await host.storage.client.runtimeState.findMany({ where }),
        revisions: await host.storage.client.runtimeRevision.findMany({
          where,
          orderBy: { revision: "asc" },
        }),
        admission: await host.storage.client.spaceExecutionAdmission.findMany({
          where,
        }),
        bindings: await host.storage.client.executionThreadBinding.findMany({
          where,
          orderBy: { identityDigest: "asc" },
        }),
        threads: await host.storage.client.operatorExecution.findMany({
          where,
          orderBy: { threadId: "asc" },
        }),
        manifests: await host.storage.client.spaceManifest.findMany({
          where,
          orderBy: { revision: "asc" },
        }),
      });
      const resources = async () => ({
        skills: await host.storage.client.skillCatalog.findMany({ where }),
        selections: await host.storage.client.contextSelection.findMany({
          where,
          orderBy: { selectionId: "asc" },
        }),
        memory: await host.storage.client.governedMemory.findMany({
          where,
          orderBy: { id: "asc" },
        }),
        plans: await host.storage.client.workPlan.findMany({ where }),
        budgets: await host.storage.client.workBudget.findMany({ where }),
      });
      const before = await sqlFacts(), resourceBefore = await resources();
      const finalDossierTable = postgresQualifiedTable(
          host.storage.client,
          "EvolutionDossier",
        ),
        faultFunction = postgresQualifiedTable(
          host.storage.client,
          "qualification_fail_runtime_adoption",
        );
      await host.storage.client.$executeRaw(
        Prisma
          .sql`CREATE FUNCTION ${faultFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned adoption precommit fault' USING ERRCODE='40001'; END $$`,
      );
      await host.storage.client.$executeRaw(
        Prisma
          .sql`CREATE TRIGGER "qualification_fail_runtime_adoption" BEFORE UPDATE ON ${finalDossierTable} FOR EACH ROW WHEN (NEW."kind"='request-owner-adoption-v2' AND NEW."status"='adopted') EXECUTE FUNCTION ${faultFunction}()`,
      );
      let removed = false;
      const removeFault = async () => {
        if (removed) return;
        await host.storage.client.$executeRaw(
          Prisma
            .sql`DROP TRIGGER IF EXISTS "qualification_fail_runtime_adoption" ON ${finalDossierTable}`,
        );
        await host.storage.client.$executeRaw(
          Prisma.sql`DROP FUNCTION IF EXISTS ${faultFunction}()`,
        );
        removed = true;
      };
      database.registerCleanup(removeFault);
      const key = `adoption-${crypto.randomUUID()}`;
      await expectActualAdoptionPrecommitFault({
        prepare: () =>
          adoption.prepare(session.secret, {
            caseId: record.caseId,
            adoptionKey: key,
            expectedAdmittedVersion: a1,
            expectedExecutingDigest:
              initial.state.executionModel!.version.digest,
          }),
        resume: () =>
          adoption.resume(session.secret, {
            caseId: record.caseId,
            adoptionKey: key,
          }),
        transientBoundary,
        diagnostics,
        faultMessage: "owned adoption precommit fault",
        label: "Initial same-key adoption precommit injection",
      });
      const armed = await adoption.status(session.secret, {
        caseId: record.caseId,
        adoptionKey: key,
      });
      assert.equal(armed?.status, "armed");
      assert.equal(armed?.receipt, undefined);
      assert.deepEqual(
        await sqlFacts(),
        before,
        "all final SQL effects, including native successor and both business revisions, roll back together",
      );
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
            operatorId: host.primaryOperatorId,
          },
        }),
        1,
        "the failed final completion must retain its exact armed barrier",
      );
      console.info(
        "Adoption witness stage complete: initial final-transaction rollback retains armed barrier",
      );
      await removeFault();
      // The caller drops this ACK. Recovery must inspect/resume the same key.
      await completeActualAdoption({
        start: () =>
          adoption.resume(session.secret, {
            caseId: record.caseId,
            adoptionKey: key,
          }),
        resume: () =>
          adoption.resume(session.secret, {
            caseId: record.caseId,
            adoptionKey: key,
          }),
        transientBoundary,
        diagnostics,
        label: "Recover initial adoption after removing real fault",
      });
      const recovered = await adoption.status(session.secret, {
        caseId: record.caseId,
        adoptionKey: key,
      });
      assert.equal(recovered?.status, "adopted");
      assert(recovered.receipt);
      assert.deepEqual(
        await adoption.resume(session.secret, {
          caseId: record.caseId,
          adoptionKey: key,
        }),
        recovered,
      );
      console.info(
        `Adoption witness stage complete: exact R1 receipt and same-key recovery ${recovered.receipt.receiptDigest}`,
      );
      const binding = await host.stage.executionBindings.read(record);
      assert.equal(binding.pin.source.version, a1);
      assert.equal(binding.pin.modelDigest, a1Digest);
      const firstAdoption = (await host.sourceAdmission.admittedSource(record))
        .execution.adoptions.at(-1)!;
      const firstQueuedSuccessors = await host.storage.client.operatorExecution
        .findMany({
          where: {
            ...where,
            threadId: {
              in: [
                ...firstAdoption.manifest.nativeRetirement.successorThreadIds,
              ],
            },
          },
          orderBy: { threadId: "asc" },
        });
      assert(firstQueuedSuccessors.length > 0);
      const assertNeverStarted = async (threadId: string) => {
        const scope = { ...where, threadId };
        assert.deepEqual(
          await Promise.all([
            host.storage.client.executionRun.count({ where: scope }),
            host.storage.client.executionContribution.count({ where: scope }),
            host.storage.client.executionEffect.count({ where: scope }),
            host.storage.client.immutableConsultationGroup.count({
              where: scope,
            }),
          ]),
          [0, 0, 0, 0],
        );
      };
      for (const successor of firstQueuedSuccessors) {
        assert.equal(successor.status, "queued");
        assert.equal(successor.currentRunId, null);
        assert.equal(successor.currentJobId, null);
        assert.equal(successor.currentRetry, null);
        assert.equal(successor.currentCheckpointId, null);
        assert.equal(successor.checkpointNamespace, "");
        assert.equal(successor.epoch, 0n);
        assert.equal(successor.revision, 0n);
        await assertNeverStarted(successor.threadId);
      }
      assert.equal(binding.admission.id, initial.record.admissionId);
      assert.equal(
        binding.admission.revision,
        before.admission[0].revision + 1,
      );
      for (
        const field of [
          "capabilityId",
          "capabilityRevision",
          "expiresAt",
          "createdAt",
        ] as const
      ) {
        assert.deepEqual(
          binding.admission[field],
          before.admission[0][field] instanceof Date
            ? (before.admission[0][field] as Date).toISOString()
            : before.admission[0][field],
        );
      }
      assert.deepEqual(await resources(), resourceBefore);
      const adoptedState = binding.state;
      assert.deepEqual(adoptedState.messages, initial.state.messages);
      assert.deepEqual(
        adoptedState.conversationContext,
        initial.state.conversationContext,
      );
      assert.deepEqual(
        adoptedState.invocationContinuations,
        initial.state.invocationContinuations,
      );
      assert.deepEqual(
        adoptedState.cases!.find((entry) => entry.id === record.caseId)!
          .modelPin,
        initial.state.cases!.find((entry) => entry.id === record.caseId)!
          .modelPin,
      );
      assert.equal(
        adoptedState.events.filter((event) =>
          event.effectiveModelUpdate?.dossierId === recovered.receipt!.commandId
        ).length,
        1,
      );
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
          },
        }),
        0,
      );
      const continueRequest = async (
        conversations: Pick<
          RequestCaseConversations,
          "conversations" | "submitHuman"
        >,
        text: string,
        expected = { version: a1, digest: a1Digest },
      ) => {
        const view = await conversations.conversations(
            session.secret,
            record.caseId,
          ),
          owner = view.conversations.find((entry) =>
            entry.agentId === host.primaryOperatorId
          )!;
        const count = host.providerObservations.filter((entry) =>
          entry.caseId === record.caseId
        ).length;
        await conversations.submitHuman(session.secret, {
          caseId: record.caseId,
          agentId: host.primaryOperatorId,
          expectedRevision: owner.revision,
          text,
        });
        await eventually(() =>
          Promise.resolve(
            host.providerObservations.filter((entry) =>
                entry.caseId === record.caseId
              ).length > count
              ? true
              : undefined,
          )
        );
        const input = await eventually(async () => {
          const rows = await host.storage.client.executionContribution.findMany(
            { where },
          );
          const found = rows.find((row) =>
            (JSON.parse(row.payloadJson) as OperatorExecutionDelivery).payload
              ?.text === text
          );
          return found?.status === "completed" ? found : undefined;
        });
        const delivery = JSON.parse(
          input.payloadJson,
        ) as OperatorExecutionDelivery;
        assert.equal(delivery.modelPin.repositoryVersion, expected.version);
        assert.equal(delivery.modelPin.modelDigest, expected.digest);
        const observed = host.providerObservations.filter((entry) =>
          entry.caseId === record.caseId
        ).at(-1)!;
        assert.equal(observed.version, expected.version);
        assert.equal(observed.contextVersion, expected.version);
        assert.match(observed.instruction!, /Request qualification witness\./);
      };
      await continueRequest(
        host.stage.conversations,
        "Continue this same Request with the adopted warm instruction",
      );
      const cold = new RequestSpaceRuntime({
        ...createRequestRuntimeReaders(host.storage.client),
        onNoticeError: () => {},
        storage: host.storage,
        native: {
          scope: host.stage.nativeRuntime.ledger.options.scope,
          forCaseSpace: host.stage.nativeRuntime.forCaseSpace,
        },
        openings: new PostgresRequestSpaceStore(
          host.storage.client,
          record.scope,
        ),
        source: host.openingSources.source,
        branches: host.openingSources.branches,
        admissions: host.controls.admissions,
        dependencies: host.dependencies.create,
        executionBindings: host.stage.executionBindings,
        resolveExecutionModel: host.stage.executedModels.current,
      });
      database.registerCleanup(
        observeAdoptionRuntimeReservation(cold, diagnostics),
      );
      await cold.provision(record);
      host.useRuntimeForWitness(cold);
      adoption = host.adoptionForRuntime(cold);
      const coldConversations = new RequestCaseConversations({
        scope: record.scope,
        control: host.stage.controls,
        store: new PostgresRequestSpaceStore(host.storage.client, record.scope),
        admissions: host.controls.admissions,
        runtime: cold,
      });
      await continueRequest(
        coldConversations,
        "Continue this same Request after a cold factory restoration",
      );
      await removeSourceFault();
      const sourceResult = await host.revisions.resume(session.secret, {
        caseId: record.caseId,
        commandId: acceptedTwo.commandId,
      });
      assert(sourceResult);
      const chain = await host.sourceAdmission.admittedSource(record);
      assert.equal(chain.cursor.revision, 4);
      assert.equal(chain.head.revision, 4);
      assert.equal(chain.execution.pin.source.version, a1);
      assert.equal(chain.receipts[1].payload.predecessor.revision, 2);
      // Source ordinals are sparse in the verified mixed journal: adoption
      // occupies ordinal 3 and must never become a Release source receipt.
      const [source2, source4] = chain.receipts;
      assert.deepEqual(
        chain.receipts.map((entry) =>
          entry.revision
        ),
        [2, 4],
      );
      const sourceReference = (revision: number, manifestDigest: string) => ({
        format: "request-release-admission/v1" as const,
        openingId: record.id,
        openingBaseDigest: record.baseDigest!,
        revision,
        manifestDigest,
      });
      const projected4 = requestReleaseSourceEvidence(
        record,
        chain,
        sourceReference(4, source4.manifestDigest),
      );
      assert.deepEqual(projected4, {
        requestAdmission: sourceReference(4, source4.manifestDigest),
        source: source4.payload.result.source,
        sourceDigest: source4.payload.result.sourceDigest,
        build: source4.payload.result.build,
        model: source4.payload.result.model,
      });
      assert.equal(projected4.source.version, chain.head.source.version);
      const projected2 = requestReleaseSourceEvidence(
        record,
        chain,
        sourceReference(2, source2.manifestDigest),
      );
      assert.deepEqual(projected2, {
        requestAdmission: sourceReference(2, source2.manifestDigest),
        source: source2.payload.result.source,
        sourceDigest: source2.payload.result.sourceDigest,
        build: source2.payload.result.build,
        model: source2.payload.result.model,
      });
      assert.equal(projected2.source.version, a1);
      assert.equal(firstAdoption.receipt.journalRevision, 3);
      assert.throws(
        () =>
          requestReleaseSourceEvidence(
            record,
            chain,
            sourceReference(3, firstAdoption.receipt.journalDigest),
          ),
        /admitted Request source history is unavailable/,
      );
      assert.equal(
        canonical(
          await host.backend.queue.getDossier(
            host.backend.project.id,
            acceptedTwo.commandId,
          ),
        ),
        originalSourceDossier,
      );
      assert.deepEqual(
        await host.revisions.resume(session.secret, {
          caseId: record.caseId,
          commandId: acceptedTwo.commandId,
        }),
        sourceResult,
      );
      await assert.rejects(
        () =>
          host.releases.releases.createTag(session.secret, {
            name: `refused-a1-${crypto.randomUUID()}`,
            source: {
              branch: { kind: "case", caseId: record.caseId },
              sourceVersion: a1,
            },
          }),
        { code: "SOURCE_STALE" },
      );
      assert.equal(
        (await host.releases.releases.inspect(session.secret, retained.id))
          .digest,
        retained.digest,
      );
      const reused = await host.stage.openings.open({
        openingKey: `reuse-b0-${crypto.randomUUID()}`,
        text: "Reuse the retained historical B0 Release",
        source: {
          kind: "release",
          releaseId: retained.id,
          digest: retained.digest!,
        },
      }, session.secret);
      assert.equal(reused.phase, "dispatched");
      assert.equal(reused.sourceVersion, b0);
      assert.deepEqual(
        await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
        }),
        main,
      );
      assert.deepEqual(
        await host.stage.executionBindings.read(sibling.record),
        siblingBefore,
      );
      console.info(
        "Adoption witness stage complete: warm/cold R1, source replay and historical B0 isolation",
      );
      // Counter changes are tested against the real caller-transaction native
      // dependency guard. Preparation reads another transaction, so uncommitted
      // counter changes cannot truthfully qualify its initial zero-counter test.
      const inert = firstQueuedSuccessors[0];
      const counterView = await host.stage.nativeRuntime.forCaseSpace(
        record.executionSpaceId,
        record.caseId,
      );
      assert.equal(counterView.ledger, initial.view.ledger);
      const ledger = counterView.ledger;
      const originalPreparation = ledger.prepareRetirementBatch;
      const captureSentinel = new Error(
        "Owned counter witness captured authentic retirement packet before arm",
      );
      let counterPacket: object | undefined, captureObserved = false;
      const captureCheckpoint = diagnostics.checkpoint();
      ledger.prepareRetirementBatch = async (
        ...args: Parameters<typeof originalPreparation>
      ) => {
        counterPacket = await Reflect.apply(originalPreparation, ledger, args);
        captureObserved = true;
        throw captureSentinel;
      };
      try {
        const captured = await adoption.prepare(session.secret, {
          caseId: record.caseId,
          adoptionKey: `counter-packet-${crypto.randomUUID()}`,
          expectedAdmittedVersion: chain.head.source.version,
          expectedExecutingDigest: a1Digest,
        });
        assert.equal(captured.status, "prepared");
        assert.equal(captured.receipt, undefined);
        assert(captured.blockers.length > 0);
        assert(captureObserved && counterPacket);
        assert(
          diagnostics.since(captureCheckpoint).some((failure) =>
            failure.error.includes(captureSentinel.message)
          ),
          "the actual reservation must observe the capture sentinel, not an earlier refusal",
        );
      } finally {
        ledger.prepareRetirementBatch = originalPreparation;
      }
      assert(counterPacket);
      const inertWhere = { ...where, threadId: inert.threadId };
      const originalInert = await host.storage.client.operatorExecution
        .findFirstOrThrow({ where: inertWhere });
      assert.equal(originalInert.status, "queued");
      assert.equal(originalInert.epoch, 0n);
      assert.equal(originalInert.revision, 0n);
      await assertNeverStarted(inert.threadId);
      const counterBaseline = await sqlFacts();
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
          },
        }),
        0,
      );
      for (const field of ["epoch", "revision"] as const) {
        const rollbackSentinel = new Error(`Owned ${field} witness rollback`);
        await assert.rejects(() =>
          host.storage.client.$transaction(async (tx) => {
            const token = await ledger.lockRetirementInTransaction(
              tx,
              counterPacket!,
            );
            const changed = await tx.operatorExecution.updateMany({
              where: inertWhere,
              data: { [field]: originalInert[field] + 1n },
            });
            assert.equal(changed.count, 1);
            assert.deepEqual(
              await tx.operatorExecution.findFirstOrThrow({
                where: inertWhere,
              }),
              {
                ...originalInert,
                [field]: originalInert[field] + 1n,
              },
            );
            await assert.rejects(
              () =>
                ledger.assertRetirementPreparedLocked(
                  tx,
                  counterPacket!,
                  token,
                ),
              (error) =>
                error instanceof Error &&
                error.message ===
                  "Native retirement dependency changed after locking",
            );
            // Rollback, never an UPDATE decrement forbidden by the real schema.
            throw rollbackSentinel;
          }), (error) =>
          error === rollbackSentinel);
        assert.deepEqual(
          await host.storage.client.operatorExecution.findFirstOrThrow({
            where: inertWhere,
          }),
          originalInert,
        );
        assert.deepEqual(await sqlFacts(), counterBaseline);
      }
      console.info(
        "Adoption witness stage complete: same-transaction epoch/revision dependency refusal and exact rollback",
      );
      // Namespace corruption is reversible and visible to actual preparation.
      const namespaceCheckpoint = diagnostics.checkpoint();
      const corruptedNamespace = await host.storage.client.operatorExecution
        .updateMany({
          where: inertWhere,
          data: { checkpointNamespace: "unproved-native-checkpoint" },
        });
      assert.equal(corruptedNamespace.count, 1);
      try {
        assert.deepEqual(
          await host.storage.client.operatorExecution.findFirstOrThrow({
            where: inertWhere,
          }),
          {
            ...originalInert,
            checkpointNamespace: "unproved-native-checkpoint",
          },
        );
        const blocked = await adoption.prepare(session.secret, {
          caseId: record.caseId,
          adoptionKey: `unproved-namespace-${crypto.randomUUID()}`,
          expectedAdmittedVersion: chain.head.source.version,
          expectedExecutingDigest: a1Digest,
        });
        assert.equal(blocked.status, "prepared");
        assert(blocked.blockers.length > 0);
        assert.equal(blocked.receipt, undefined);
        assert(
          diagnostics.since(namespaceCheckpoint).some((failure) =>
            failure.error.includes(
              "Selected native successor is not an exact never-started current adoption",
            )
          ),
          "actual native preparation must reject the corrupted namespace",
        );
        assert.equal(
          await host.storage.client.evolutionTargetBarrier.count({
            where: {
              ...record.scope,
              targetScopeKey: `request:${record.executionSpaceId}`,
            },
          }),
          0,
        );
      } finally {
        const restored = await host.storage.client.operatorExecution.updateMany(
          {
            where: inertWhere,
            data: { checkpointNamespace: originalInert.checkpointNamespace },
          },
        );
        assert.equal(restored.count, 1);
      }
      assert.deepEqual(
        await host.storage.client.operatorExecution.findFirstOrThrow({
          where: inertWhere,
        }),
        originalInert,
      );
      assert.deepEqual(await sqlFacts(), counterBaseline);
      console.info(
        "Adoption witness stage complete: actual never-started namespace refusal and exact restoration",
      );
      // Arm a second exact instruction, then let a separately accepted source
      // win. Explicit same-key resume must prove no effect and release only this
      // obsolete barrier; a GET remains read-only throughout.
      removed = false;
      await host.storage.client.$executeRaw(
        Prisma
          .sql`CREATE FUNCTION ${faultFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned adoption precommit fault' USING ERRCODE='40001'; END $$`,
      );
      await host.storage.client.$executeRaw(
        Prisma
          .sql`CREATE TRIGGER "qualification_fail_runtime_adoption" BEFORE UPDATE ON ${finalDossierTable} FOR EACH ROW WHEN (NEW."kind"='request-owner-adoption-v2' AND NEW."status"='adopted') EXECUTE FUNCTION ${faultFunction}()`,
      );
      const obsoleteKey = `obsolete-${crypto.randomUUID()}`;
      const beforeRepeatedFault = await sqlFacts();
      await expectActualAdoptionPrecommitFault({
        prepare: () =>
          adoption.prepare(session.secret, {
            caseId: record.caseId,
            adoptionKey: obsoleteKey,
            expectedAdmittedVersion: chain.head.source.version,
            expectedExecutingDigest: a1Digest,
          }),
        resume: () =>
          adoption.resume(session.secret, {
            caseId: record.caseId,
            adoptionKey: obsoleteKey,
          }),
        transientBoundary,
        diagnostics,
        faultMessage: "owned adoption precommit fault",
        label: "Repeated same-key adoption precommit injection",
      });
      assert.equal(
        (await adoption.status(session.secret, {
          caseId: record.caseId,
          adoptionKey: obsoleteKey,
        }))?.status,
        "armed",
      );
      assert.deepEqual(
        await sqlFacts(),
        beforeRepeatedFault,
        "waiting and never-started native retirement roll back with the entire later transition",
      );
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
            operatorId: host.primaryOperatorId,
          },
        }),
        1,
      );
      console.info(
        "Adoption witness stage complete: later mixed waiting/inert transition rollback retains armed barrier",
      );
      const publicationProgress = observeSourcePublication(
        host.backend,
        host.sourceAdmission.resolver,
      );
      database.registerCleanup(() =>
        publicationProgress.restore()
      );

      const queueFacts = (entry: ModelWriteQueueEntry | null | undefined) =>
        entry && ({
          commandDigest: entry.commandDigest,
          state: entry.state,
          attempts: entry.attempts,
          owner: entry.owner,
          fence: entry.fence,
          leaseExpiresAt: entry.leaseExpiresAt,
          publishedVersion: entry.publishedVersion,
          lastError: entry.lastError && {
            code: entry.lastError.code,
            message: entry.lastError.message.slice(0, 1200),
          },
        });
      let commandId: string | undefined;
      let latest: ReturnType<typeof queueFacts>;
      try {
        const later = await host.revisions.propose(session.secret, {
          caseId: record.caseId,
          expectedVersion: chain.head.source.version,
          changes: [{
            path: change.path,
            text: change.text.replace(
              "Request qualification witness.",
              "Request qualification witness. A newer exact source supersedes the armed target.",
            ),
          }],
          reason: "Advance source while an inert adoption is armed",
        });
        const laterAccepted = await host.revisions.accept(session.secret, {
          caseId: record.caseId,
          proposalId: later.id,
        });
        commandId = laterAccepted.commandId;
        await eventually(async () => {
          const entry = await host.backend.queue.get(
            host.backend.project.id,
            laterAccepted.commandId,
          );
          try {
            latest = queueFacts(entry);
          } catch { /* A failed observation must not affect the poll. */ }
          if (entry && ["refused", "needs-decision"].includes(entry.state)) {
            throw new Error(
              `Later source publication stopped: ${
                JSON.stringify(queueFacts(entry))
              }`,
            );
          }
          return entry?.state === "published" ? true : undefined;
        });
      } catch (error) {
        // Report only observations already available, before cleanup or more I/O.
        try {
          console.error(
            "Owned later source publication boundary",
            JSON.stringify({
              commandId: commandId ?? null,
              progressAtFailure: publicationProgress.snapshot(),
              latest,
              workerErrors: host.workerErrors.slice(0, 3).map(
                sourcePublicationError,
              ),
            }),
          );
        } catch { /* Preserve the original failure even if reporting fails. */ }
        throw error;
      }
      const cancelled = await adoption.resume(session.secret, {
        caseId: record.caseId,
        adoptionKey: obsoleteKey,
      });
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.receipt, undefined);
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
          },
        }),
        0,
      );
      assert.equal(
        (await host.stage.executionBindings.read(record)).pin.source.version,
        a1,
      );
      console.info(
        "Adoption witness stage complete: obsolete armed target cancels without adopting newer source",
      );
      await removeFault();
      // R0/R1 are relative versions: another legitimate instruction can govern
      // this same Request after its earlier successor remained truly unstarted.
      const repeatedSource = await host.sourceAdmission.admittedSource(record),
        repeatedDigest = repeatedSource.receipts.at(-1)!.payload.result.model
          .digest;
      assert.notEqual(
        repeatedSource.head.source.version,
        chain.head.source.version,
      );
      const retainedRuns = await host.storage.client.executionRun.findMany({
        where,
        orderBy: [{ threadId: "asc" }, { runId: "asc" }],
      });
      const beforeRepeatedResources = await resources(),
        beforeRepeatedState = await host.stage.executionBindings.read(record);
      const repeatedKey = `next-${crypto.randomUUID()}`;
      const repeated = await completeActualAdoption({
        start: () =>
          adoption.prepare(session.secret, {
            caseId: record.caseId,
            adoptionKey: repeatedKey,
            expectedAdmittedVersion: repeatedSource.head.source.version,
            expectedExecutingDigest: a1Digest,
          }),
        resume: () =>
          adoption.resume(session.secret, {
            caseId: record.caseId,
            adoptionKey: repeatedKey,
          }),
        transientBoundary,
        diagnostics,
        label: "Complete the later exact instruction on the same Request",
      });
      assert.equal(repeated.status, "adopted");
      assert(repeated.receipt);
      const repeatedBinding = await host.stage.executionBindings.read(record),
        repeatedChain = await host.sourceAdmission.admittedSource(record),
        repeatedManifest = repeatedChain.execution.adoptions.at(-1)!.manifest;
      assert.equal(repeatedChain.execution.adoptions.length, 2);
      assert.equal(
        repeatedBinding.pin.source.version,
        repeatedSource.head.source.version,
      );
      assert.equal(repeatedBinding.pin.modelDigest, repeatedDigest);
      assert.equal(
        repeatedBinding.admission.revision,
        beforeRepeatedState.admission.revision + 1,
      );
      for (
        const field of [
          "capabilityId",
          "capabilityRevision",
          "createdAt",
          "expiresAt",
        ] as const
      ) {
        assert.equal(
          repeatedBinding.admission[field],
          binding.admission[field],
        );
      }
      assert.deepEqual(
        repeatedBinding.state.messages,
        beforeRepeatedState.state.messages,
      );
      assert.deepEqual(
        repeatedBinding.state.conversationContext,
        beforeRepeatedState.state.conversationContext,
      );
      assert.deepEqual(await resources(), beforeRepeatedResources);
      assert.deepEqual(
        repeatedBinding.state.cases!.find((entry) =>
          entry.id === record.caseId
        )!.modelPin,
        initial.state.cases!.find((entry) => entry.id === record.caseId)!
          .modelPin,
      );
      assert.deepEqual(
        await host.storage.client.executionRun.findMany({
          where,
          orderBy: [{ threadId: "asc" }, { runId: "asc" }],
        }),
        retainedRuns,
        "retiring a never-started selection does not synthesize or rewrite execution history",
      );
      for (const original of firstQueuedSuccessors) {
        const retired = await host.storage.client.operatorExecution.findFirst({
          where: { ...where, threadId: original.threadId },
        });
        assert(retired?.retiredAt);
        assert.equal(retired.status, "queued");
        assert.equal(retired.authorizedPinJson, original.authorizedPinJson);
        assert.equal(
          retired.advanceAuthorizationJson,
          original.advanceAuthorizationJson,
        );
        assert.equal(retired.identityJson, original.identityJson);
        assert.equal(retired.currentRunId, null);
        assert.equal(retired.currentJobId, null);
        assert.equal(retired.currentCheckpointId, null);
        assert.equal(retired.epoch, 0n);
        await assertNeverStarted(original.threadId);
        const paired = repeatedManifest.nativeRetirement.predecessorThreadIds
          .indexOf(original.threadId);
        assert(paired >= 0);
        const selected = await host.storage.client.operatorExecution.findFirst({
          where: {
            ...where,
            threadId:
              repeatedManifest.nativeRetirement.successorThreadIds[paired],
          },
        });
        assert(selected && !selected.retiredAt);
        assert.equal(selected.predecessorThreadId, original.threadId);
        assert.equal(selected.identityJson, original.identityJson);
        assert.equal(selected.status, "queued");
        assert.equal(
          JSON.parse(selected.advanceAuthorizationJson!).source.kind,
          "never-started-adoption-successor",
        );
        assert.deepEqual(JSON.parse(selected.authorizedPinJson!), {
          modelDigest: repeatedDigest,
          repositoryVersion: repeatedSource.head.source.version,
        });
        await assertNeverStarted(selected.threadId);
      }
      assert.deepEqual(
        repeatedChain.execution.adoptions[0].receipt,
        firstAdoption.receipt,
      );
      await continueRequest(
        coldConversations,
        "Continue the same Request after its next instruction adoption",
        { version: repeatedSource.head.source.version, digest: repeatedDigest },
      );
      assert.deepEqual(
        await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
        }),
        main,
      );
      assert.deepEqual(
        await host.stage.executionBindings.read(sibling.record),
        siblingBefore,
      );
      console.info(
        `Adoption witness stage complete: later exact receipt, native history retention and R2 effect ${repeated.receipt.receiptDigest}`,
      );
      await host.controls.sqlAdmissions.revoke(
        binding.admission.id,
        controller,
      );
      assert.deepEqual(
        await adoption.resume(session.secret, {
          caseId: record.caseId,
          adoptionKey: key,
        }),
        recovered,
        "committed recovery precedes fresh-effect checks after admission revocation",
      );
      assert.deepEqual(host.workerErrors, []);
      console.info(
        "Adoption witness stage complete: committed receipt replay survives admission revocation, no worker errors",
      );
    });
  },
});

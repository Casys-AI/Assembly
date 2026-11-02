/** Real normal Toolkit + PG + Request source admission/recovery + R0 continuation.
 * Controlled provider, isolated database/schema, no live service or external API. */
import type { RequestSourceOwnerAuthorityEnvelope } from "../../src/application/model/source-admission/request-source-owner.ts";
import assert from "node:assert/strict";
import { isScopedSoftwareWriteDossier } from "../../src/application/model/publication/write-command-v2.ts";
import { resolveRepositoryLayout } from "../../src/adapters/out/filesystem/layout.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
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
  assertGitPendingAdmission,
  assertRequestSourceGitAnchors,
  assertSourceSettled,
  failSourceAdmissionInTestSchema,
  immutableRequestEvidence,
  normalInstructionChange,
  revokeCapturedSourceSession,
} from "../support/request-source-admission-qualification.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "Normal Request source A0→A1 rolls back SQL after Git, recovers exact proof, and continues native R0",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    const started = performance.now();
    const mark = (phase: string) =>
      console.log("Request source witness", {
        phase,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      });
    await withPostgresDatabase(async (database) => {
      const host = await openNormalAdmissionWitnessHost(database);
      mark("normal host ready");
      const initial = await openInitialNormalRequest(host);
      mark("initial Request completed");
      const { record, session, capability, state } = initial;
      const repoId = host.backend.project.id;
      const b0 = record.base!.manifest.source!.sourceVersion;
      const initialHead = await host.sourceAdmission.admittedSource(record);
      assert.equal(initialHead.head.revision, 1);
      assert.equal(initialHead.head.source.version, b0);
      assert.equal(state.executionModel!.version.repositoryVersion, b0);
      const originalMain = (await host.backend.repository.current()).version;
      const mainBefore = await host.storage.client.runtimeState.findMany({
        where: { ...host.storage.scope, executionSpaceId: "main" },
        orderBy: { operatorId: "asc" },
      });
      const releaseSource = {
        branch: { kind: "case" as const, caseId: record.caseId },
        sourceVersion: b0,
      };
      const releaseTagName = `qualification-release-${crypto.randomUUID()}`;
      await host.releases.releases.createTag(session.secret, {
        source: releaseSource,
        name: releaseTagName,
      });
      const retained = await host.releases.releases.save(session.secret, {
        saveKey: `qualification-release-${crypto.randomUUID()}`,
        tag: {
          mode: "existing",
          name: releaseTagName,
        },
        name: "Request B0 witness",
        purpose: "Retained before source evolution",
        source: releaseSource,
      });
      assert(retained.digest);
      const before = await immutableRequestEvidence(
        host.storage.client,
        record,
      );
      const command = normalInstructionChange(host.source.sources);
      const proposal = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: b0,
        changes: [command],
        reason: "Normal source qualification",
      });
      assert.equal(proposal.caseId, record.caseId);
      assert.equal(proposal.baseVersion, b0);
      assert(proposal.proposalVersion);
      mark("source proposal compiled");
      assert.match(proposal.id, /^[a-f0-9-]{36}$/);
      const removeFault = await failSourceAdmissionInTestSchema(
        host.storage.client,
      );
      database.registerCleanup(removeFault);
      const queued = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: proposal.id,
      });
      assert.equal(queued.caseId, record.caseId);
      assert.equal(queued.commandId, proposal.id);
      mark("acceptance queued");
      const dossier = await host.backend.queue.getDossier(
        repoId,
        queued.commandId,
      );
      assert(
        dossier && dossier.v === 2 && !isScopedSoftwareWriteDossier(dossier) &&
          dossier.command.kind === "accept-proposal",
      );
      assert.equal(
        (dossier.authority as RequestSourceOwnerAuthorityEnvelope).proposal
          .principal.controller.sessionId,
        initial.controller.sessionId,
      );
      assert.equal(
        (dossier.authority as RequestSourceOwnerAuthorityEnvelope).acceptance
          .principal.controller.sessionId,
        initial.controller.sessionId,
      );
      const pending = await eventually(async () => {
        const row = await host.backend.queue.get(repoId, queued.commandId);
        if (row?.state === "needs-decision" || row?.state === "refused") {
          throw new Error(
            `Unexpected terminal source queue state ${row.state}`,
          );
        }
        return row?.state === "retryable" ? row : undefined;
      });
      const gitRef = async (ref: string): Promise<string> => {
        const process = await new Deno.Command("git", {
          args: [
            "--git-dir",
            `${host.backend.project.projectDir}/.git`,
            "rev-parse",
            "--verify",
            ref,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert.equal(process.success, true, `missing exact witness ref ${ref}`);
        return `commit:${new TextDecoder().decode(process.stdout).trim()}`;
      };
      const physical = await gitRef(`refs/heads/requests/${record.branchId}`);
      const commandAnchor = await gitRef(
        requestSourceCommandRef(queued.commandId),
      );
      const admissionAnchor = await gitRef(
        requestSourceAdmissionRef(queued.commandId, physical),
      );
      const interrupted = await host.sourceAdmission.admittedSource(record);
      mark("checking Git effect and SQL rollback");
      assertGitPendingAdmission({
        initialVersion: b0,
        initialManifestDigest: initialHead.head.manifestDigest,
        physicalVersion: physical,
        commandAnchorVersion: commandAnchor,
        admissionAnchorVersion: admissionAnchor,
        head: interrupted.head,
        queue: {
          state: pending.state,
          publishedVersion: pending.publishedVersion ?? null,
        },
        before,
        after: await immutableRequestEvidence(host.storage.client, record),
      });
      // A physically published but unadmitted A1 must not hide admitted B0.
      const b0Selection = {
        branch: { kind: "case" as const, caseId: record.caseId },
        sourceVersion: b0,
      };
      const b0Scope = {
        ...record.scope,
        executionSpaceId: record.executionSpaceId,
      };
      const b0Capture = await host.releases.savedSystems.assets.resolveSource(
        b0Selection,
        b0Scope,
      );
      assert.equal(b0Capture.source?.sourceVersion, b0);
      assert.equal(b0Capture.source?.requestAdmission, undefined);
      assert.equal(
        (await host.stage.caseBranchReader.resolve(
          record.caseId,
          initial.controller,
          b0,
        )).branchVersion,
        b0,
      );
      await assert.rejects(() =>
        host.releases.savedSystems.assets.resolveSource({
          ...b0Selection,
          sourceVersion: physical,
        }, b0Scope)
      );
      await assert.rejects(() =>
        host.stage.caseBranchReader.resolve(
          record.caseId,
          initial.controller,
          physical,
        )
      );
      assert.equal(
        (await host.backend.repository.current()).version,
        originalMain,
      );
      // Exact immutable Git/dossier is authoritative, not the mutable journal.
      const layout = await resolveRepositoryLayout(
        host.backend.project.projectDir,
      );
      await Deno.remove(`${layout.stateDir}/proposals/${proposal.id}.json`);
      await revokeCapturedSourceSession(
        host.storage.client,
        (dossier.authority as RequestSourceOwnerAuthorityEnvelope).acceptance
          .principal.controller,
        host.storage.scope,
        (dossier.authority as RequestSourceOwnerAuthorityEnvelope).acceptance
          .principal.sessionRevision,
      );
      await removeFault();
      const freshSession = await host.stage.controls.exchange(
        capability.secret,
      );
      const recovered = await host.revisions.resume(freshSession.secret, {
        caseId: record.caseId,
        commandId: queued.commandId,
      });
      assert(recovered);
      assert.equal(recovered.version, physical);
      mark("historical admission recovered");
      const queue = await host.backend.queue.get(repoId, queued.commandId);
      assert(queue);
      const chain = await host.sourceAdmission.admittedSource(record);
      const freshController = await host.stage.controls.authenticateSession(
        freshSession.secret,
      );
      const current = await host.stage.caseBranchReader.resolve(
        record.caseId,
        freshController,
      );
      const inspected = await host.stage.caseBranchReader.resolve(
        record.caseId,
        freshController,
        physical,
      );
      const versions = (scope: typeof current) => ({
        branchVersion: scope.branchVersion,
        executionVersion: scope.executionVersion,
        version: scope.version,
      });
      assertSourceSettled({
        commandId: queued.commandId,
        initialVersion: b0,
        resultVersion: physical,
        chain,
        queue: {
          state: queue.state,
          publishedVersion: queue.publishedVersion ?? null,
        },
        defaultScope: versions(current),
        explicitScope: versions(inspected),
      });
      assert.deepEqual(
        await immutableRequestEvidence(host.storage.client, record),
        before,
      );
      assert.equal(
        (await host.backend.repository.current()).version,
        originalMain,
      );
      assert.deepEqual(
        await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
          orderBy: { operatorId: "asc" },
        }),
        mainBefore,
      );
      const reader = await GitModelRepository.openReadOnly({
        projectDir: host.backend.project.projectDir,
        repositoryId: repoId,
        buildService: host.backend.buildService,
      });
      const admittedReceipt = chain.receipts.find((entry) =>
        entry.payload.result.source.version === physical
      );
      assert(admittedReceipt);
      await assertRequestSourceGitAnchors({
        projectDir: host.backend.project.projectDir,
        reader,
        admission: admittedReceipt.payload,
        wrongVersion: b0,
        requestRef: `refs/heads/requests/${record.branchId}`,
        expectedRequestVersion: physical,
        expectedMainVersion: originalMain,
      });
      assert.equal(
        await gitRef(`refs/heads/requests/${record.branchId}`),
        physical,
      );
      assert.equal(
        (await host.backend.repository.current()).version,
        originalMain,
      );
      assert.equal(
        (await reader.at(physical)).sources[command.path],
        command.text,
      );
      assert.equal(
        (await host.releases.releases.inspect(freshSession.secret, retained.id))
          .digest,
        retained.digest,
      );
      const selected = await host.stage.conversations.conversations(
        freshSession.secret,
        record.caseId,
      );
      const owner = selected.conversations.find((conversation) =>
        conversation.agentId === host.primaryOperatorId
      );
      assert(owner);
      const continuationText = "Continue after the Request source admission";
      await host.stage.conversations.submitHuman(freshSession.secret, {
        caseId: record.caseId,
        agentId: host.primaryOperatorId,
        expectedRevision: owner.revision,
        text: continuationText,
      });
      await eventually(() =>
        Promise.resolve(
          host.providerObservations.filter((item) =>
              item.caseId === record.caseId
            ).length === 2
            ? true
            : undefined,
        )
      );
      const continuation = host.providerObservations.filter((item) =>
        item.caseId === record.caseId
      ).at(-1)!;
      assert.equal(continuation.version, b0);
      assert.equal(continuation.digest, state.executionModel!.version.digest);
      const runtime = await initial.stores.state.load();
      assert.equal(runtime!.executionModel!.version.repositoryVersion, b0);
      assert.equal(
        runtime!.executionModel!.version.digest,
        state.executionModel!.version.digest,
      );
      const contributions = await host.storage.client.executionContribution
        .findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: record.executionSpaceId,
            operatorId: host.primaryOperatorId,
          },
        });
      const continued = contributions.map((item) =>
        JSON.parse(item.payloadJson) as OperatorExecutionDelivery
      ).find((delivery) => delivery.payload?.text === continuationText);
      assert(continued);
      assert.equal(continued.modelPin.repositoryVersion, b0);
      assert.equal(
        continued.modelPin.modelDigest,
        state.executionModel!.version.digest,
      );
      await eventually(async () =>
        (await initial.view.dispatch.inspectAccepted(
            host.primaryOperatorId,
            continued.id,
          ))?.receipt.status === "completed"
          ? true
          : undefined
      );
      const runs = await host.storage.client.executionRun.findMany({
        where: {
          ...host.storage.scope,
          executionSpaceId: record.executionSpaceId,
          contributionId: continued.id,
        },
      });
      assert(
        runs.length > 0 &&
          runs.every((run) =>
            run.errorJson === null && run.snapshotJson &&
            JSON.parse(run.snapshotJson).status !== "refused"
          ),
      );
      assert.deepEqual(host.workerErrors, []);
      mark("native R0 continuation completed");
      assert.equal(
        (await host.backend.repository.current()).version,
        originalMain,
      );
      assert.deepEqual(
        await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
          orderBy: { operatorId: "asc" },
        }),
        mainBefore,
      );
    });
  },
});

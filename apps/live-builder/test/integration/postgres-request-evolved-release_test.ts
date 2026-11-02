/** Joined 4.11b witness: actual normal Toolkit/Git/D2/PG/tag/native composition.
 * Controlled provider, isolated schema; no live server or external API. */
import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  discoverConversationUnits,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  type SavedOperatorManifest,
  savedSystemDigest,
} from "../../src/domain/work/saved-systems.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
  readCompletedNormalRequest,
} from "../support/request-source-admission-normal-host.ts";
import {
  assertRequestSourceGitAnchors,
  failSourceAdmissionInTestSchema,
  immutableRequestEvidence,
  normalInstructionChange,
} from "../support/request-source-admission-qualification.ts";
import { retainedToolDraft } from "../support/saved-system-retention-sources.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "Normal admitted A1 while R0 produces an exact tagged Release, survives A2 and executes in a fresh independently authorized Request",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    const started = performance.now();
    const mark = (phase: string) =>
      console.log("Evolved Request Release witness", {
        phase,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      });
    await withPostgresDatabase(async (database) => {
      const host = await openNormalAdmissionWitnessHost(database, {
        wholeSystemClosure: true,
      });
      assert(host.retainedTool?.sourceBinding && host.retainedTool.admission);
      assert.equal(host.retainedTool.stage, "active");
      assert.equal(host.toolTests, 1);
      const origin = await openInitialNormalRequest(host);
      const sibling = await openInitialNormalRequest(host);
      const { record, session } = origin;
      const repositoryId = host.backend.project.id;
      const b0 = record.base!.manifest.source!.sourceVersion;
      const originalBase = canonical(record.base);
      const originalMain = (await host.backend.repository.current()).version;
      const originBefore = await immutableRequestEvidence(
        host.storage.client,
        record,
      );
      const siblingBefore = await immutableRequestEvidence(
        host.storage.client,
        sibling.record,
      );
      const mainBefore = await host.storage.client.runtimeState.findMany({
        where: { ...host.storage.scope, executionSpaceId: "main" },
        orderBy: { operatorId: "asc" },
      });
      const assertUnchanged = async () => {
        assert.deepEqual(
          await immutableRequestEvidence(host.storage.client, record),
          originBefore,
        );
        assert.deepEqual(
          await immutableRequestEvidence(host.storage.client, sibling.record),
          siblingBefore,
        );
        assert.deepEqual(
          await host.storage.client.runtimeState.findMany({
            where: { ...host.storage.scope, executionSpaceId: "main" },
            orderBy: { operatorId: "asc" },
          }),
          mainBefore,
        );
        assert.equal(
          (await host.backend.repository.current()).version,
          originalMain,
        );
        assert.equal(
          canonical(
            (await new PostgresRequestSpaceStore(
              host.storage.client,
              host.storage.scope,
            ).get(record.id))!.base,
          ),
          originalBase,
        );
        assert.equal(
          (await origin.stores.state.load())!.executionModel!.version
            .repositoryVersion,
          b0,
        );
      };
      const readRef = async (ref: string) => {
        const result = await new Deno.Command("git", {
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
        assert.equal(result.success, true, `Missing witness ref ${ref}`);
        return `commit:${new TextDecoder().decode(result.stdout).trim()}`;
      };
      const change = normalInstructionChange(host.source.sources);
      const proposed = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: b0,
        changes: [change],
        reason: "Retain admitted source independently of origin execution",
      });
      const accepted = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: proposed.id,
      });
      await eventually(async () =>
        (await host.backend.queue.get(repositoryId, accepted.commandId))
            ?.state === "published"
          ? true
          : undefined
      );
      const chain1 = await host.sourceAdmission.admittedSource(record);
      const a1 = chain1.head.source.version;
      assert.notEqual(a1, b0);
      assert.equal(chain1.execution.pin.source.version, b0);
      assert.equal(
        await readRef(requestSourceCommandRef(accepted.commandId)),
        a1,
      );
      assert.equal(
        await readRef(requestSourceAdmissionRef(accepted.commandId, a1)),
        a1,
      );
      const reader = await GitModelRepository.openReadOnly({
        projectDir: host.backend.project.projectDir,
        repositoryId,
        buildService: host.backend.buildService,
      });
      const sourceReceipt = chain1.receipts.find((receipt) =>
        receipt.revision === chain1.head.revision
      );
      assert(sourceReceipt);
      await assertRequestSourceGitAnchors({
        projectDir: host.backend.project.projectDir,
        reader,
        admission: sourceReceipt.payload,
        wrongVersion: b0,
        requestRef: `refs/heads/requests/${record.branchId}`,
        expectedRequestVersion: a1,
        expectedMainVersion: originalMain,
      });
      await assertUnchanged();
      mark("real A1 admission; origin and sibling remain R0");

      const command = {
        saveKey: `evolved-a1-${crypto.randomUUID()}`,
        tag: {
          mode: "existing" as const,
          name: `evolved-a1-${crypto.randomUUID()}`,
        },
        name: "Admitted A1 independently of R0",
        purpose: "Fresh native Request from exact retained source",
        source: {
          branch: { kind: "case" as const, caseId: record.caseId },
          sourceVersion: a1,
        },
      };
      await host.releases.releases.createTag(session.secret, {
        source: command.source,
        name: command.tag.name,
      });
      const retained = await host.releases.releases.save(
        session.secret,
        command,
      );
      assert(
        retained.manifest && retained.digest &&
          retained.source?.requestAdmission,
      );
      assert.equal(retained.assetAvailability, "verified");
      assert.equal(retained.tagAvailability, "verified");
      assert.equal(retained.tag!.verified, true);
      assert.equal(retained.tag!.binding.commitOid, a1.slice(7));
      assert.equal(await readRef(`refs/tags/${command.tag.name}`), a1);
      assert.equal(retained.source.sourceVersion, a1);
      assert.equal(
        retained.source.requestAdmission.revision,
        chain1.head.revision,
      );
      assert.equal(
        retained.source.requestAdmission.manifestDigest,
        chain1.head.manifestDigest,
      );
      assert.equal(retained.source.requestAdmission.openingId, record.id);
      assert.equal(
        retained.source.requestAdmission.openingBaseDigest,
        record.baseDigest,
      );
      const revision1 = await reader.at(a1);
      const units = discoverConversationUnits(
        revision1,
        host.backend.projectId,
      );
      assert.equal(units.length, 2);
      assert.deepEqual(
        retained.manifest.registeredOperatorIds,
        units.map((unit) => unit.identity.builderId).sort(),
      );
      assert.equal(retained.manifest.operators.length, units.length);
      assert.equal(
        new Set(
          retained.manifest.operators.map((operator) =>
            operator.settingsDigest
          ),
        ).size,
        2,
      );
      assert.equal(
        retained.manifest.operators.flatMap((operator) => operator.tools)
          .length,
        1,
      );
      const toolOwner = retained.manifest.operators.find((operator) =>
        operator.tools.length > 0
      )!;
      const retainedTool = toolOwner.tools[0];
      assert.equal(toolOwner.operatorId, host.primaryOperatorId);
      assert.equal(retainedTool.candidateId, host.retainedTool.id);
      assert.equal(retainedTool.digest, host.retainedTool.digest);
      assert.deepEqual(
        retainedTool.sourceBinding,
        host.retainedTool.sourceBinding,
      );
      const assertToolBytes = async () => {
        const inspection = await host.releases.releases.readTool(
          session.secret,
          retained.id,
          toolOwner.operatorId,
          retainedTool.candidateId,
        );
        assert.deepEqual(inspection.sources, [{
          binding: retainedTool.sourceBinding,
          content: retainedToolDraft,
        }]);
      };
      await assertToolBytes();
      for (const unit of units) {
        const model = await validateSourceExecutable(
          revision1,
          host.backend.projectId,
          unit.systemQualifiedName,
        );
        const captured: SavedOperatorManifest | undefined = retained.manifest
          .operators.find((operator) =>
            operator.operatorId === unit.identity.builderId
          );
        assert(captured);
        assert.equal(captured.modelDigest, model.version.digest);
        assert.equal(
          captured.settingsDigest,
          await savedSystemDigest({
            configuration: model.configuration,
            flows: model.flows,
            caseFlows: model.caseFlows ?? null,
            policy: model.policy,
          }),
        );
        assert.equal(captured.repositoryVersion, a1);
        assert.equal(captured.sourceDigest, revision1.sourceDigest);
        assert.deepEqual(captured.build, await reader.descriptorAt(a1));
        assert.deepEqual(
          captured.tools.map(({ candidateId, digest }) => ({
            candidateId,
            digest,
          })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
          model.catalog.filter((tool) => tool.status === "active").map((
            { candidateId, digest },
          ) => ({ candidateId, digest })).sort((a, b) =>
            a.candidateId.localeCompare(b.candidateId)
          ),
        );
      }
      // The normal source has a supported local skill dependency. Retention
      // remains honestly incomplete; opening proves this host's concrete support.
      assert.equal(retained.status, "incomplete");
      assert.deepEqual(retained.issues, ["PREREQUISITES_REQUIRED"]);
      assert(
        retained.manifest.prerequisites.some((item) => item.kind === "skill"),
      );
      const originalRow = await host.storage.client.savedSystem
        .findUniqueOrThrow({ where: { id: retained.id } });
      await assertUnchanged();
      mark("tagged exact whole-source A1 retained with truthful prerequisites");

      const changedAgain = change.text.replace(
        "Request qualification witness.",
        "Later admitted Request source.",
      );
      assert.notEqual(changedAgain, change.text);
      const second = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: a1,
        changes: [{ path: change.path, text: changedAgain }],
        reason: "Advance source after immutable A1 retention",
      });
      const removeFault = await failSourceAdmissionInTestSchema(
        host.storage.client,
      );
      database.registerCleanup(removeFault);
      const secondAccepted = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: second.id,
      });
      await eventually(async () =>
        (await host.backend.queue.get(repositoryId, secondAccepted.commandId))
            ?.state === "retryable"
          ? true
          : undefined
      );
      const physical2 = await readRef(`refs/heads/requests/${record.branchId}`);
      assert.notEqual(physical2, a1);
      assert.equal(
        (await host.sourceAdmission.admittedSource(record)).head.source.version,
        a1,
      );
      const sourceScope = await host.stage.caseBranchReader.resolve(
        record.caseId,
        origin.controller,
        a1,
      );
      assert.equal(sourceScope.branchVersion, a1);
      assert.equal(sourceScope.executionVersion, b0);
      await host.releases.releases.listTags(session.secret, command.source);
      await assert.rejects(
        () =>
          host.releases.releases.createTag(session.secret, {
            name: `unadmitted-${crypto.randomUUID()}`,
            source: { ...command.source, sourceVersion: physical2 },
          }),
        { code: "UNAVAILABLE" },
      );
      await assertUnchanged();
      mark("physical A2 cannot replace admitted A1 eligibility");
      await removeFault();
      const resumed = await host.revisions.resume(session.secret, {
        caseId: record.caseId,
        commandId: secondAccepted.commandId,
      });
      assert.equal(resumed?.version, physical2);
      const chain2 = await host.sourceAdmission.admittedSource(record);
      assert.equal(chain2.head.source.version, physical2);
      assert.equal(chain2.execution.pin.source.version, b0);
      const retry = await host.releases.releases.save(session.secret, command);
      const inspected = await host.releases.releases.inspect(
        session.secret,
        retained.id,
      );
      for (const view of [retry, inspected]) {
        assert.equal(view.id, retained.id);
        assert.equal(view.digest, retained.digest);
        assert.deepEqual(view.manifest, retained.manifest);
        assert.deepEqual(view.tag, retained.tag);
        assert.equal(view.assetAvailability, "verified");
        assert.equal(view.tagAvailability, "verified");
      }
      const recoveredRow = await host.storage.client.savedSystem
        .findUniqueOrThrow({ where: { id: retained.id } });
      assert.equal(recoveredRow.capture, originalRow.capture);
      assert.equal(recoveredRow.manifest, originalRow.manifest);
      await assertToolBytes();
      await assertUnchanged();
      mark("same-key historical A1 recovery after admitted A2");

      const capability = await host.stage.controls.issueCapability(
        origin.controller.ownerId,
      );
      const freshSession = await host.stage.controls.exchange(
        capability.secret,
      );
      const freshController = await host.stage.controls.authenticateSession(
        freshSession.secret,
      );
      assert.notEqual(
        freshController.capabilityId,
        origin.controller.capabilityId,
      );
      const openingCommand = {
        openingKey: `fresh-c-${crypto.randomUUID()}`,
        text: "Execute this fresh Request from the retained A1 source",
        source: {
          kind: "release" as const,
          releaseId: retained.id,
          digest: retained.digest,
        },
      };
      const opened = await host.stage.openings.open(
        openingCommand,
        freshSession.secret,
      );
      assert.equal(
        opened.phase,
        "dispatched",
        JSON.stringify({ phase: opened.phase, issues: opened.issues }),
      );
      const fresh = await readCompletedNormalRequest(host, opened.id);
      const c = fresh.record;
      for (
        const field of [
          "caseId",
          "executionSpaceId",
          "branchId",
          "initialContributionId",
          "admissionId",
        ] as const
      ) {
        assert.notEqual(c[field], record[field]);
        assert.notEqual(c[field], sibling.record[field]);
      }
      assert.deepEqual(c.base!.release, {
        id: retained.id,
        digest: retained.digest,
      });
      assert.deepEqual(c.base!.manifest, retained.manifest);
      assert.equal(c.base!.manifest.operators.length, 2);
      assert.deepEqual(
        c.base!.manifest.operators.find((operator) =>
          operator.operatorId === toolOwner.operatorId
        )!.tools[0].sourceBinding,
        retainedTool.sourceBinding,
      );
      await assertToolBytes();
      assert.equal(fresh.state.executionModel!.version.repositoryVersion, a1);
      const observed = host.providerObservations.filter((item) =>
        item.caseId === c.caseId
      );
      assert.equal(observed.length, 1);
      assert.equal(observed[0].version, a1);
      assert.equal(
        observed[0].digest,
        chain1.receipts.find((receipt) =>
          receipt.revision === chain1.head.revision
        )!.payload.result.model.digest,
      );
      assert.equal(observed[0].contextVersion, a1);
      assert.match(observed[0].instruction!, /Request qualification witness\./);
      assert.doesNotMatch(
        observed[0].instruction!,
        /Later admitted Request source\./,
      );
      const admission = await host.storage.client.spaceExecutionAdmission
        .findUniqueOrThrow({ where: { id: c.admissionId! } });
      assert.equal(admission.capabilityId, freshController.capabilityId);
      assert.equal(admission.openingId, c.id);
      const effects = await host.storage.client.executionEffect.findMany({
        where: { ...host.storage.scope, executionSpaceId: c.executionSpaceId },
      });
      assert(
        effects.length > 0 &&
          effects.every((effect) => effect.authorizationJson),
      );
      for (const effect of effects) {
        assert(effect.authorizationJson);
        const proof: unknown = JSON.parse(effect.authorizationJson);
        assert(
          proof !== null && typeof proof === "object" && !Array.isArray(proof),
        );
        assert(
          "scope" in proof && "openingId" in proof &&
            "executionSpaceId" in proof &&
            "baseDigest" in proof && "admissionId" in proof &&
            "capabilityId" in proof &&
            "capabilityRevision" in proof && "admissionRevision" in proof,
        );
        assert.deepEqual(proof.scope, host.storage.scope);
        assert.equal(proof.openingId, c.id);
        assert.equal(proof.executionSpaceId, c.executionSpaceId);
        assert.equal(proof.baseDigest, c.baseDigest);
        assert.equal(proof.admissionId, c.admissionId);
        assert.equal(proof.capabilityId, freshController.capabilityId);
        assert.equal(
          proof.capabilityRevision,
          freshController.capabilityRevision,
        );
        assert.equal(proof.admissionRevision, admission.revision);
      }
      const runs = await host.storage.client.executionRun.findMany({
        where: {
          ...host.storage.scope,
          executionSpaceId: c.executionSpaceId,
          contributionId: c.initialContributionId,
        },
      });
      assert(
        runs.length > 0 &&
          runs.every((run) =>
            run.errorJson === null && run.snapshotJson &&
            JSON.parse(run.snapshotJson).status !== "refused"
          ),
      );
      assert.equal(
        host.providerObservations.filter((item) =>
          item.caseId === record.caseId
        ).length,
        1,
      );
      await assertUnchanged();
      mark("fresh C completed real native A1 under its new admission");

      await host.stage.controls.revokeCapability(freshController);
      await assert.rejects(() =>
        host.stage.conversations.submitHuman(freshSession.secret, {
          caseId: c.caseId,
          agentId: host.primaryOperatorId,
          expectedRevision: fresh.state.revision,
          text: "No fresh authority from a retained Release",
        })
      );
      // An active source-side control cannot revive C's revoked admission.
      await assert.rejects(() =>
        host.stage.openings.open(openingCommand, session.secret)
      );
      const replay = await fresh.view.dispatch.inspectAccepted(
        host.primaryOperatorId,
        c.initialContributionId,
      );
      assert.deepEqual(replay?.receipt, fresh.initialReceipt?.receipt);
      assert.equal(replay?.receipt.status, "completed");
      assert.deepEqual(
        await host.storage.client.executionEffect.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: c.executionSpaceId,
          },
        }),
        effects,
      );
      assert.equal(
        host.providerObservations.filter((item) => item.caseId === c.caseId)
          .length,
        1,
      );
      await assertUnchanged();
      assert.deepEqual(host.workerErrors, []);
      mark(
        "revocation refuses new work; completed native receipt read has no repeated effect",
      );
    });
  },
});

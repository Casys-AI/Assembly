import { createRequestRuntimeReaders } from "../../src/adapters/out/postgres/request-runtime-readers.ts";
import { Client } from "pg";
/** A+ joined A1/Release/Request witness. The provider and page fetch are
 * controlled; generated tool modules execute in the real Darwin sandbox. */
import assert from "node:assert/strict";
import type { Candidate, ToolDraft } from "../../src/domain/work/candidates.ts";
import {
  artifactSourcePublicationFromDossier,
  type ModelWriteDossier,
} from "../../src/domain/model/editing/write-command.ts";
import { RequestSpaceRuntime } from "../../src/application/work/request-spaces/runtime.ts";
import { RequestSpaceOpenings } from "../../src/application/work/request-spaces/opening.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
import {
  retainedWitnessAgent,
  retainedWitnessDrafts,
  retainedWitnessObservation,
  retainedWitnessRunner,
  retainedWitnessUrl,
  waitRetainedInitialCompleted,
} from "../support/request-retained-tool-witness.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
} from "../support/request-source-admission-normal-host.ts";
import { withTestCpuProfile } from "../support/cpu-profile.ts";
import { normalInstructionChange } from "../support/request-source-admission-qualification.ts";

/** Preserve only bounded queue metadata; never print proposal/source or secrets. */
async function waitPublished(
  host: Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>,
  commandId: string,
  connectionString: string,
): Promise<void> {
  const started = Date.now();
  // This explicit native qualification composes multiple bounded Toolkit calls.
  // Keep terminal failures immediate and measure the operation, not just polling.
  const deadline = started + 90_000;
  let last: {
    state: string;
    attempts: number;
    errorCode: string | null;
    workerErrors: number;
  } | undefined;
  while (Date.now() < deadline) {
    const entry = await host.backend.queue.get(
      host.backend.project.id,
      commandId,
    );
    const code = entry?.lastError?.code;
    last = {
      state: entry?.state ?? "missing",
      attempts: entry?.attempts ?? 0,
      errorCode: code && /^[A-Z0-9_]{1,100}$/.test(code) ? code : null,
      workerErrors: host.workerErrors.length,
    };
    if (entry?.state === "published") return;
    if (entry?.state === "refused" || entry?.state === "needs-decision") {
      throw new Error(`A+ publication terminal: ${JSON.stringify(last)}`);
    }
    if (host.workerErrors.length) {
      const errors = host.workerErrors.slice(0, 3).map((error) => {
        const value = error && typeof error === "object"
          ? error as { name?: unknown; message?: unknown; code?: unknown }
          : {};
        return {
          name: typeof value.name === "string" &&
              /^[A-Za-z0-9_]{1,80}$/.test(value.name)
            ? value.name
            : "WorkerError",
          code: typeof value.code === "string" &&
              /^[A-Z0-9_]{1,80}$/.test(value.code)
            ? value.code
            : null,
          classification: typeof value.message === "string" &&
              value.message.includes("timeout exceeded when trying to connect")
            ? "pool-acquisition-timeout"
            : "worker-error",
        };
      });
      throw new Error(
        `A+ worker error: ${JSON.stringify({ ...last, errors })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Isolated test database only: inspect aggregated wait categories, never SQL,
  // session identities, connection strings, or source contents.
  let waits: unknown = "unavailable";
  const diagnostic = new Client({
    connectionString,
    connectionTimeoutMillis: 1500,
    statement_timeout: 1500,
  });
  try {
    await diagnostic.connect();
    const result = await diagnostic.query(
      `SELECT state, wait_event_type, wait_event, count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid() GROUP BY state, wait_event_type, wait_event ORDER BY count DESC LIMIT 12`,
    );
    waits = result.rows;
  } catch {
    /* Keep the original failure when diagnostics are unavailable. */
  } finally {
    await diagnostic.end().catch(() => {});
  }
  const snapshot = { ...last, waitMs: Date.now() - started, waits };
  console.log(
    "A+ publication deadline observed before fixture cleanup",
    snapshot,
  );
  throw new Error(`A+ publication deadline: ${JSON.stringify(snapshot)}`);
}

Deno.test({
  name:
    "A+ exact A1 Release gives two fresh Requests separate retained-tool resources and bundled skills",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const { mark, progress, observe } = retainedWitnessObservation("A+");
      const controlled = retainedWitnessAgent(observe);
      const actualRunner = retainedWitnessRunner(observe);
      mark("host-opening");
      const host = await openNormalAdmissionWitnessHost(database, {
        wholeSystemClosure: true,
        tools: retainedWitnessDrafts.map((draft, index) => ({
          ...draft,
          id: `witness-${index}`,
        })),
        agent: controlled.agent,
        runner: actualRunner.runner,
        preparationRunner: actualRunner.runner,
        networkHost: "example.org",
      });
      mark("host-ready");
      assert(host.retainedTool?.sourceBinding);
      assert.equal(host.retainedTool.stage, "active");
      // Recover the actual published W4 dossier for this retained source after
      // the native preparation and its job have settled. No source or queue
      // receipt is constructed by the test.
      const sourceBinding = host.retainedTool.sourceBinding;
      const sourceRows = await host.storage.client.modelWriteCommand.findMany({
        where: {
          ...host.storage.scope,
          repositoryId: host.backend.project.id,
          state: "published",
        },
        select: { dossierJson: true },
      });
      const sourcePublications = sourceRows.map((row) =>
        JSON.parse(row.dossierJson) as ModelWriteDossier
      ).filter((dossier) =>
        dossier.v === 1 && dossier.operations.kind === "artifact-source" &&
        dossier.decision.kind === "retain-artifact-source"
      ).map(artifactSourcePublicationFromDossier).filter((publication) =>
        publication.target.invocationId === sourceBinding.invocationId &&
        publication.target.localArtifactId === sourceBinding.localArtifactId
      );
      assert.equal(sourcePublications.length, 1);
      const sourcePublication = sourcePublications[0];
      const sourceEffect = await host.storage.client.executionEffect.findMany({
        where: {
          ...host.storage.scope,
          executionSpaceId: sourcePublication.target.executionSpaceId,
          operatorId: sourcePublication.target.operatorId,
          effectKey: sourcePublication.target.invocationId,
        },
      });
      assert.equal(sourceEffect.length, 1);
      assert.equal(sourceEffect[0].status, "completed");
      const producerDeadline = Date.now() + 10_000;
      let producerJob = await host.stage.nativeRuntime.dispatch.boss.getJobById(
        host.stage.nativeRuntime.ledger.options.queueName,
        sourceEffect[0].jobId,
      );
      while (
        producerJob?.state !== "completed" && Date.now() < producerDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        producerJob = await host.stage.nativeRuntime.dispatch.boss.getJobById(
          host.stage.nativeRuntime.ledger.options.queueName,
          sourceEffect[0].jobId,
        );
      }
      assert.equal(producerJob?.state, "completed");
      const assertOrigin = host.stage.nativeRuntime.assertArtifactSourceOrigin;
      await assertOrigin(sourcePublication);
      const altered = structuredClone(sourcePublication);
      assert.equal(altered.source.kind, "tool-draft");
      if (altered.source.kind !== "tool-draft") {
        throw new Error("Expected tool draft");
      }
      altered.source.content.description += " changed";
      await assert.rejects(
        () => assertOrigin(altered),
        /Artifact source recovery differs from its immutable accepted W4 publication bytes or proof/,
      );
      const fresh = structuredClone(sourcePublication);
      fresh.publicationId += ":fresh";
      await assert.rejects(
        () => assertOrigin(fresh),
        /Expired or settled artifact producer has no exact preaccepted W4 intent/,
      );
      mark("origin-opening");
      const origin = await openInitialNormalRequest(host);
      const { record, session } = origin;
      mark("origin-dispatched");

      const b0 = record.base!.manifest.source!.sourceVersion;
      const b0Source = await host.backend.repository.at(b0);
      assert.equal(b0Source.version, b0);
      const proposal = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: b0,
        changes: [normalInstructionChange(b0Source.sources)],
        reason: "Retain exact A1 for isolated target admission",
      });
      const accepted = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: proposal.id,
      });
      mark("a1-accepted");
      if (Deno.env.get("ASSEMBLY_TEST_CPU_PROFILE") === "1") {
        const queued = await host.storage.client.modelWriteCommand
          .findUniqueOrThrow({
            where: {
              projectId_systemId_repositoryId_commandId: {
                ...host.storage.scope,
                repositoryId: host.backend.project.id,
                commandId: accepted.commandId,
              },
            },
            select: { commandJson: true, dossierJson: true },
          });
        const utf8 = new TextEncoder();
        console.log("A+ A1 publication queue payload UTF-8 bytes", {
          commandJsonBytes: utf8.encode(queued.commandJson).byteLength,
          dossierJsonBytes: utf8.encode(queued.dossierJson).byteLength,
        });
        await withTestCpuProfile(
          () =>
            waitPublished(host, accepted.commandId, database.connectionString),
          { enabled: true, phase: "A+ a1-publication" },
        );
      } else {
        await waitPublished(
          host,
          accepted.commandId,
          database.connectionString,
        );
      }
      mark("a1-published");
      const a1 = (await host.sourceAdmission.admittedSource(record)).head.source
        .version;
      assert.notEqual(a1, b0);
      const tag = `retained-a-plus-${crypto.randomUUID()}`;
      const source = {
        branch: { kind: "case" as const, caseId: record.caseId },
        sourceVersion: a1,
      };
      mark("release-tagging");
      await host.releases.releases.createTag(session.secret, {
        source,
        name: tag,
      });
      mark("release-saving");
      const release = await host.releases.releases.save(session.secret, {
        saveKey: crypto.randomUUID(),
        tag: { mode: "existing", name: tag },
        name: "A+ retained dependency witness",
        purpose: "Verify independent exact target admission",
        source,
      });
      mark("release-saved");
      assert(release.digest && release.manifest);
      const captured = release.manifest.operators.flatMap((operator) =>
        operator.tools
      );
      assert.equal(captured.length, 2);
      assert.equal(host.retainedTools?.length, 2);
      for (const selected of captured) {
        const sourceTool: Candidate | undefined = host.retainedTools!.find((
          tool,
        ) => tool.id === selected.candidateId);
        assert(sourceTool?.sourceBinding);
        assert.equal(selected.digest, sourceTool.digest);
        assert.deepEqual(selected.sourceBinding, sourceTool.sourceBinding);
        const retained = await host.releases.releases.readTool(
          session.secret,
          release.id,
          host.primaryOperatorId,
          selected.candidateId,
        );
        const expected: ToolDraft | undefined = retainedWitnessDrafts.find((
          draft,
        ) => draft.name === sourceTool.name);
        assert(expected);
        assert.deepEqual(retained.sources, [{
          binding: selected.sourceBinding,
          content: expected,
        }]);
      }
      assert(
        release.manifest.prerequisites.some((item) => item.kind === "skill"),
      );
      const a1Source = await host.backend.repository.at(a1);
      assert.equal(a1Source.version, a1);
      const firstChange = normalInstructionChange(b0Source.sources);
      const a1Text = a1Source.sources[firstChange.path];
      assert.equal(a1Text, firstChange.text);
      const laterText = a1Text.replace(
        "Request qualification witness.",
        "Later source must not replace the retained A1.",
      );
      assert.notEqual(laterText, a1Text);
      mark("release-tools-captured");
      mark("a2-proposing");
      const later = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: a1,
        changes: [{ path: firstChange.path, text: laterText }],
        reason: "Advance source after retaining A1",
      });
      const laterAccepted = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: later.id,
      });
      mark("a2-accepted");
      await withTestCpuProfile(
        () =>
          waitPublished(
            host,
            laterAccepted.commandId,
            database.connectionString,
          ),
        {
          enabled: Deno.env.get("ASSEMBLY_TEST_CPU_PROFILE") === "1",
          phase: "A+ a2-publication",
        },
      );
      mark("a2-published");
      assert.notEqual(
        (await host.sourceAdmission.admittedSource(record)).head.source.version,
        a1,
      );
      const mainBefore = await host.storage.client.runtimeState.findMany({
        where: { ...host.storage.scope, executionSpaceId: "main" },
        orderBy: { operatorId: "asc" },
      });
      const seed = host.initialModel.initialSkills![0];
      controlled.arm({
        digest: seed.digest,
        content: await bundledSkillReader()(
          seed.source,
          host.initialModel.skillPolicy!.maxSkillBytes,
        ),
      });
      const store = new PostgresRequestSpaceStore(
        host.storage.client,
        host.storage.scope,
      );
      const created = [];
      for (let i = 0; i < 2; i++) {
        const requestMark = (phase: string) =>
          mark(`request-${i + 1}-${phase}`);
        requestMark("capability-opening");
        const capability = await host.stage.controls.issueCapability(
          origin.controller.ownerId,
        );
        const freshSession = await host.stage.controls.exchange(
          capability.secret,
        );
        const command = {
          openingKey: crypto.randomUUID(),
          text:
            `Inspect ${retainedWitnessUrl} with this retained Request and its bundled skill`,
          source: {
            kind: "release" as const,
            releaseId: release.id,
            digest: release.digest,
          },
        };
        let committedAdmissionId: string | undefined;
        let committedResources: string[] | undefined;
        let injectLostAck = i === 0;
        const admissions = host.controls.admissions;
        const opening = new RequestSpaceOpenings({
          scope: host.storage.scope,
          source: host.openingSources.source,
          store,
          control: host.stage.controls,
          branches: host.openingSources.branches,
          runtime: host.stage.runtime,
          admissions: {
            async ensure(record, controller) {
              const admitted = await admissions.ensure(record, controller);
              if (injectLostAck) {
                injectLostAck = false;
                committedAdmissionId = admitted.id;
                committedResources = [...admitted.permissions.resourceIds];
                throw new Error("Controlled lost admission acknowledgement");
              }
              return admitted;
            },
            assertDispatch: (record, admission) =>
              admissions.assertDispatch(record, admission),
            revoke: (id, controller) => admissions.revoke(id, controller),
          },
        });
        if (i === 0) {
          requestMark("lost-ack-opening");
          const interrupted = await opening.open(command, freshSession.secret);
          requestMark("lost-ack-returned");
          assert.equal(interrupted.phase, "runtime-ready");
          assert(committedAdmissionId && committedResources);
        }
        requestMark("opening");
        const opened = await opening.open(command, freshSession.secret);
        requestMark("opening-returned");
        assert.equal(opened.phase, "dispatched", JSON.stringify(opened.issues));
        const initial = await store.get(opened.id);
        assert(initial?.base);
        requestMark("initial-receipt-waiting");
        await waitRetainedInitialCompleted(
          host,
          initial,
          progress,
          requestMark,
        );
        requestMark("initial-receipt-completed");
        const stores = await (await host.storage.caseSpace(
          initial.executionSpaceId,
          initial.caseId,
        )).operator(host.primaryOperatorId);
        const state = await stores.state.load();
        assert(state?.executionModel);
        const retry = await host.stage.openings.open(
          command,
          freshSession.secret,
        );
        assert.equal(retry.id, opened.id);
        const current = await store.get(opened.id);
        assert(current?.admissionId);
        assert.equal(current.admissionId, initial.admissionId);
        assert.equal(current.base!.manifest.source!.sourceVersion, a1);
        const admission = await host.storage.client.spaceExecutionAdmission
          .findUniqueOrThrow({
            where: { id: current.admissionId },
          });
        const permissions = JSON.parse(admission.permissionsJson) as {
          acts: string[];
          resourceIds: string[];
        };
        assert.deepEqual(permissions.acts, ["conversation"]);
        assert.equal(permissions.resourceIds.length, 2);
        if (committedAdmissionId) {
          assert.equal(current.admissionId, committedAdmissionId);
          assert.deepEqual(permissions.resourceIds, committedResources);
        }
        assert.match(permissions.resourceIds[0], /^retained-tool:v1:/);
        assert.equal(state.executionModel.version.repositoryVersion, a1);
        assert.deepEqual(
          state.candidates,
          [],
          "Retained tools are not local Candidates",
        );
        assert.equal(controlled.decisions.get(current.caseId), 3);
        const effects = await host.storage.client.executionEffect.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: current.executionSpaceId,
          },
        });
        const targets = effects.flatMap((effect) => {
          const proof = effect.authorizationJson
            ? JSON.parse(effect.authorizationJson)
            : {};
          return proof.retainedTool ? [proof.retainedTool] : [];
        });
        assert.equal(targets.length, 2);
        const toolEffects = effects.filter((effect) =>
          effect.authorizationJson &&
          JSON.parse(effect.authorizationJson).retainedTool
        );
        assert(
          toolEffects.every((effect) =>
            effect.status === "completed" &&
            effect.resultJson?.includes("TOOL_COMPLETED")
          ),
        );
        assert(
          toolEffects.every((effect) =>
            effect.resultJson?.includes("Retained witness")
          ),
        );
        assert(
          toolEffects.every((effect) =>
            effect.resultJson?.includes("Exact body")
          ),
        );
        assert.deepEqual(
          new Set(targets.map((target) => target.resourceId)),
          new Set(permissions.resourceIds),
        );
        for (const target of targets) {
          assert.equal(
            target.resourceId,
            `retained-tool:v1:${target.descriptorDigest}`,
          );
          assert(
            captured.some((tool) =>
              tool.candidateId === target.toolId &&
              tool.digest === target.toolDigest
            ),
          );
        }
        created.push({
          record: current,
          resources: permissions.resourceIds,
          session: freshSession,
          capability,
          stores,
          state,
          effects,
        });
      }
      assert.notEqual(created[0].record.caseId, created[1].record.caseId);
      assert.notEqual(
        created[0].record.executionSpaceId,
        created[1].record.executionSpaceId,
      );
      assert.notEqual(
        created[0].record.admissionId,
        created[1].record.admissionId,
      );
      assert.notDeepEqual(created[0].resources, created[1].resources);
      mark("two-targets-verified");
      const first = created[0];
      const skillBefore = await first.stores.skills.load(
        host.primaryOperatorId,
      );
      const siblingSkill = await created[1].stores.skills.load(
        host.primaryOperatorId,
      );
      assert(skillBefore && siblingSkill);
      assert.notEqual(
        first.stores.scope.executionSpaceId,
        created[1].stores.scope.executionSpaceId,
      );
      const beforeCalls = actualRunner.fetched.length;
      const beforeDecisions = controlled.decisions.get(first.record.caseId);
      const cold = new RequestSpaceRuntime({
        ...createRequestRuntimeReaders(host.storage.client),
        onNoticeError: () => {},
        storage: host.storage,
        native: {
          scope: host.stage.nativeRuntime.ledger.options.scope,
          forCaseSpace: host.stage.nativeRuntime.forCaseSpace,
        },
        openings: store,
        source: host.openingSources.source,
        branches: host.openingSources.branches,
        admissions: host.controls.admissions,
        dependencies: host.dependencies.create,
        executionBindings: host.stage.executionBindings,
      });
      mark("cold-restoration-started");
      await cold.provision(first.record);
      await cold.prepareInitialSkills(first.record);
      assert.deepEqual(
        await first.stores.skills.load(host.primaryOperatorId),
        skillBefore,
      );
      assert.equal(actualRunner.fetched.length, beforeCalls);
      assert.equal(
        controlled.decisions.get(first.record.caseId),
        beforeDecisions,
      );
      assert.deepEqual(
        await host.storage.client.executionEffect.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: first.record.executionSpaceId,
          },
        }),
        first.effects,
      );
      mark("cold-restoration-verified");
      const controller = await host.stage.controls.authenticateSession(
        first.session.secret,
      );
      const completedBeforeRevocation =
        await (await host.stage.nativeRuntime.forCaseSpace(
          first.record.executionSpaceId,
          first.record.caseId,
        )).dispatch.inspectAccepted(
          host.primaryOperatorId,
          first.record.initialContributionId,
        );
      assert.equal(completedBeforeRevocation?.receipt.status, "completed");
      await host.stage.controls.revokeCapability(controller);
      await assert.rejects(() =>
        host.stage.conversations.submitHuman(first.session.secret, {
          caseId: first.record.caseId,
          agentId: host.primaryOperatorId,
          expectedRevision: first.state.revision,
          text: "Attempt after revocation",
        })
      );
      const completedAfterRevocation =
        await (await host.stage.nativeRuntime.forCaseSpace(
          first.record.executionSpaceId,
          first.record.caseId,
        )).dispatch.inspectAccepted(
          host.primaryOperatorId,
          first.record.initialContributionId,
        );
      assert.deepEqual(
        completedAfterRevocation?.receipt,
        completedBeforeRevocation?.receipt,
      );
      assert.deepEqual(
        await host.storage.client.executionEffect.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: first.record.executionSpaceId,
          },
        }),
        first.effects,
      );
      assert.equal(actualRunner.fetched.length, 4);
      assert.deepEqual(
        await host.storage.client.runtimeState.findMany({
          where: { ...host.storage.scope, executionSpaceId: "main" },
          orderBy: { operatorId: "asc" },
        }),
        mainBefore,
      );
      assert.equal(host.workerErrors.length, 0);
      mark("witness-verified");
    });
  },
});

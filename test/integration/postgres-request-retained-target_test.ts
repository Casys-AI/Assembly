/** Smaller real PG/native target witness. The joined A1/A2 campaign remains the
 * final source-evolution qualification; this isolates Release-backed execution. */
import assert from "node:assert/strict";
import type { Candidate, ToolDraft } from "../../src/domain/work/candidates.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { openNormalAdmissionWitnessHost } from "../support/request-source-admission-normal-host.ts";
import { withTestCpuProfile } from "../support/cpu-profile.ts";
import {
  retainedWitnessAgent,
  retainedWitnessDrafts,
  retainedWitnessObservation,
  retainedWitnessRunner,
  retainedWitnessUrl,
  waitRetainedInitialCompleted,
} from "../support/request-retained-tool-witness.ts";

Deno.test({
  name:
    "B0 exact Release gives one fresh Request two real retained-tool invocations",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const { mark, observe, progress } = retainedWitnessObservation("B0");
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
      assert.equal(host.retainedTools?.length, 2);
      const ownerId = host.initialModel.ownerAuthority!.operatorId;
      const capability = await host.stage.controls.issueCapability(ownerId);
      const session = await host.stage.controls.exchange(capability.secret);
      const source = {
        branch: { kind: "main" as const },
        sourceVersion: host.source.version,
      };
      const tag = `retained-target-b0-${crypto.randomUUID()}`;
      mark("release-tagging");
      await host.releases.releases.createTag(session.secret, {
        source,
        name: tag,
      });
      mark("release-saving");
      const release = await host.releases.releases.save(session.secret, {
        saveKey: crypto.randomUUID(),
        tag: { mode: "existing", name: tag },
        name: "B0 retained target diagnostic",
        purpose: "Isolate exact target execution",
        source,
      });
      mark("release-saved");
      assert(release.digest && release.manifest);
      const releaseDigest = release.digest;
      assert(release.source);
      assert.equal(release.origin.executionSpaceId, "main");
      assert.equal(release.source.branch.kind, "main");
      assert.equal(release.source.sourceVersion, host.source.version);
      const captured = release.manifest.operators.flatMap((operator) =>
        operator.tools
      );
      assert.equal(captured.length, 2);
      assert(
        release.manifest.prerequisites.some((item) => item.kind === "skill"),
      );
      for (const tool of captured) {
        const candidate: Candidate | undefined = host.retainedTools!.find((
          candidate,
        ) =>
          candidate.id === tool.candidateId && candidate.digest === tool.digest
        );
        assert(candidate?.sourceBinding);
        assert.deepEqual(tool.sourceBinding, candidate.sourceBinding);
        // Main retains through its actual scoped service. RequestReleases.readTool
        // deliberately accepts Request-origin releases only; opening selection
        // separately accepts Main releases through inspectForOpening.
        const retained = await host.releases.savedSystems.service.readTool(
          release.id,
          host.primaryOperatorId,
          tool.candidateId,
        );
        const expected: ToolDraft | undefined = retainedWitnessDrafts.find((
          draft,
        ) => draft.name === candidate.name);
        assert(expected);
        assert.deepEqual(retained.sources, [{
          binding: tool.sourceBinding,
          content: expected,
        }]);
      }
      const seed = host.initialModel.initialSkills![0];
      controlled.arm({
        digest: seed.digest,
        content: await bundledSkillReader()(
          seed.source,
          host.initialModel.skillPolicy!.maxSkillBytes,
        ),
      });

      mark("request-opening");
      const opened = await withTestCpuProfile(
        () =>
          host.stage.openings.open({
            openingKey: crypto.randomUUID(),
            text:
              `Inspect ${retainedWitnessUrl} with the retained tools and bundled skill`,
            source: {
              kind: "release",
              releaseId: release.id,
              digest: releaseDigest,
            },
          }, session.secret),
        {
          enabled: Deno.env.get("ASSEMBLY_TEST_CPU_PROFILE") === "1",
          phase: "B0 request-opening",
        },
      );
      mark("request-opening-returned");
      assert.equal(opened.phase, "dispatched");
      const record = await new PostgresRequestSpaceStore(
        host.storage.client,
        host.storage.scope,
      ).get(opened.id);
      assert(record?.base && record.admissionId);
      await waitRetainedInitialCompleted(host, record, progress, mark, "B0");
      mark("initial-receipt-completed");
      const stores = await (await host.storage.caseSpace(
        record.executionSpaceId,
        record.caseId,
      )).operator(host.primaryOperatorId);
      const state = await stores.state.load();
      assert(state?.executionModel);
      assert.equal(
        state.executionModel.version.repositoryVersion,
        host.source.version,
      );
      assert.deepEqual(state.candidates, []);
      assert.equal(controlled.decisions.get(record.caseId), 3);
      const admission = await host.storage.client.spaceExecutionAdmission
        .findUniqueOrThrow({ where: { id: record.admissionId } });
      const permissions = JSON.parse(admission.permissionsJson) as {
        acts: string[];
        resourceIds: string[];
      };
      assert.deepEqual(permissions.acts, ["conversation"]);
      assert.equal(permissions.resourceIds.length, 2);
      const effects = await host.storage.client.executionEffect.findMany({
        where: {
          ...host.storage.scope,
          executionSpaceId: record.executionSpaceId,
        },
      });
      const invoked = effects.flatMap((effect) => {
        const target = effect.authorizationJson
          ? JSON.parse(effect.authorizationJson).retainedTool
          : undefined;
        return target ? [{ target, effect }] : [];
      });
      assert.equal(invoked.length, 2);
      assert.deepEqual(
        new Set(invoked.map(({ target }) => target.resourceId)),
        new Set(permissions.resourceIds),
      );
      for (const { target, effect } of invoked) {
        assert.equal(effect.status, "completed");
        assert(effect.resultJson?.includes("TOOL_COMPLETED"));
        assert(effect.resultJson?.includes("Retained witness"));
        assert(effect.resultJson?.includes("Exact body"));
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
      assert.equal(actualRunner.fetched.length, 2);
      assert.equal(host.workerErrors.length, 0);
      mark("target-verified");
    });
  },
});

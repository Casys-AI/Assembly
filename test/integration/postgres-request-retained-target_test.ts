/** Smaller real PG/native target witness. The joined A1/A2 campaign remains the
 * final source-evolution qualification; this isolates execution from a Release
 * retained in a Request with an adopted team. It does not qualify Main-origin
 * Release retention with tools. */
import assert from "node:assert/strict";
import type {
  Candidate,
  ToolDraft,
} from "../../src/domain/work/records/candidates.ts";
import { RequestSpaceError } from "../../src/domain/work/request-spaces/scope.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
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
import {
  branchTeamAgent,
  observingMain,
  PRIMARY_NAME,
} from "../support/request-branch-team-provider.ts";
import { eventually } from "../support/eventually.ts";
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
    "B0 exact Release gives one fresh Request two real retained-tool invocations and its retained teammate",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const { mark, observe, progress } = retainedWitnessObservation("B0");
      const controlled = retainedWitnessAgent(observe);
      const team = branchTeamAgent();
      let useRetainedTools = false;
      const actualRunner = retainedWitnessRunner(observe);
      mark("host-opening");
      const host = await openNormalAdmissionWitnessHost(database, {
        wholeSystemClosure: true,
        tools: retainedWitnessDrafts.map((draft, index) => ({
          ...draft,
          id: `witness-${index}`,
        })),
        agent: {
          ...team.agent,
          decide: (context) =>
            useRetainedTools && context.operator?.name === PRIMARY_NAME
              ? controlled.agent.decide(context)
              : team.agent.decide(context),
        },
        mainAgents: observingMain().agent,
        enableRuntimeAdoption: true,
        enableNetworkChangeWitness: true,
        observeSettledContributions: true,
        creationPolicy: { maxChildren: 1 },
        runner: actualRunner.runner,
        preparationRunner: actualRunner.runner,
        networkHost: "example.org",
      });
      mark("host-ready");
      assert.equal(host.retainedTools?.length, 2);
      const origin = await openInitialNormalRequest(host);
      team.armCreation(origin.record.caseId, "Retained reviewer");
      const conversations = host.networkConversationsForWitness();
      await conversations.submitHuman(origin.session.secret, {
        caseId: origin.record.caseId,
        agentId: host.primaryOperatorId,
        expectedRevision: origin.state.revision,
        text: "Create a teammate named Retained reviewer.",
      });
      const originState = await eventually(async () => {
        const current = await origin.stores.state.load();
        const outcome = current?.messages.findIndex((message) =>
          message.text.startsWith("Request team creation outcome") &&
          message.text.includes("Retained reviewer")
        ) ?? -1;
        return current && !current.busy && outcome >= 0 &&
            current.messages.slice(outcome + 1).some((message) =>
              message.role === "assistant"
            )
          ? current
          : undefined;
      }, {
        label: "origin Request adopts its reviewer before Release retention",
        timeoutMs: 120_000,
        diagnose: async () => ({
          state: await origin.stores.state.load(),
          workerErrors: host.workerErrors,
        }),
      });
      const originBinding = await host.stage.executionBindings.read(
        origin.record,
      );
      const memberId = originBinding.admission.permissions.operatorIds.find((
        id,
      ) => id !== host.primaryOperatorId);
      assert(memberId);
      const originMember = await host.storage.readCaseRuntimeState(
        origin.record.executionSpaceId,
        origin.record.caseId,
        memberId,
      );
      assert(originMember?.executionModel);
      const ownerId = host.initialModel.ownerAuthority!.operatorId;
      const capability = await host.stage.controls.issueCapability(ownerId);
      const session = await host.stage.controls.exchange(capability.secret);
      const source = {
        branch: { kind: "case" as const, caseId: origin.record.caseId },
        sourceVersion: originState.executionModel!.version.repositoryVersion!,
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
      assert.equal(
        release.origin.executionSpaceId,
        origin.record.executionSpaceId,
      );
      assert.deepEqual(release.source.branch, source.branch);
      assert.equal(release.source.sourceVersion, source.sourceVersion);
      const retainedMember = release.manifest.operators.find((operator) =>
        operator.operatorId === memberId
      );
      assert(retainedMember);
      assert.equal(
        retainedMember.modelDigest,
        originMember.executionModel.version.digest,
      );
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
        const retained = await host.releases.releases.readTool(
          session.secret,
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
      useRetainedTools = true;
      const openingCommand = {
        openingKey: crypto.randomUUID(),
        text:
          `Inspect ${retainedWitnessUrl} with the retained tools and bundled skill`,
        source: {
          kind: "release" as const,
          releaseId: release.id,
          digest: releaseDigest,
        },
      };
      const opened = await withTestCpuProfile(
        () => host.stage.openings.open(openingCommand, session.secret),
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
        source.sourceVersion,
      );
      assert.deepEqual(state.candidates, []);
      assert.equal(controlled.decisions.get(record.caseId), 3);
      const admission = await host.storage.client.spaceExecutionAdmission
        .findUniqueOrThrow({ where: { id: record.admissionId } });
      // A lost ACK keeps the browser intention. Reloading issues a new
      // capability, but replay must preserve the original execution admission.
      const renewedCapability = await host.stage.controls.issueCapability(
        ownerId,
      );
      const renewedSession = await host.stage.controls.exchange(
        renewedCapability.secret,
      );
      assert.notEqual(renewedCapability.credentialId, admission.capabilityId);
      const replayed = await host.stage.openings.open(
        openingCommand,
        renewedSession.secret,
      );
      assert.deepEqual(replayed, opened);
      assert.deepEqual(
        await host.storage.client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id: record.admissionId },
        }),
        admission,
        "replay neither rebinds the capability nor renews or expands admission",
      );
      const permissions = JSON.parse(admission.permissionsJson) as {
        acts: string[];
        resourceIds: string[];
        operatorIds: string[];
        modelDigests: string[];
      };
      assert.deepEqual(
        permissions.operatorIds,
        [host.primaryOperatorId, memberId],
        "the retained member joins the fresh admission; unrelated source operators stay inert",
      );
      assert(permissions.modelDigests.includes(retainedMember.modelDigest));
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
      const listed = await conversations.conversations(
        session.secret,
        record.caseId,
      );
      const listedMember = listed.conversations.find((entry) =>
        entry.agentId === memberId
      );
      assert.equal(listedMember?.operatorTeam?.requestId, record.caseId);
      const member = await host.storage.readCaseRuntimeState(
        record.executionSpaceId,
        record.caseId,
        memberId,
      );
      assert(member?.executionModel);
      assert.equal(
        member.executionModel.version.digest,
        retainedMember.modelDigest,
      );
      assert.equal(
        member.executionModel.version.repositoryVersion,
        source.sourceVersion,
      );
      assert.deepEqual(
        member.executionModel.operatorTeam,
        originMember.executionModel.operatorTeam,
      );
      useRetainedTools = false;
      const instruction = "Ask the retained reviewer for a passage now.";
      team.armContribution(record.caseId, "Retained reviewer", instruction);
      await conversations.submitHuman(session.secret, {
        caseId: record.caseId,
        agentId: host.primaryOperatorId,
        expectedRevision: state.revision,
        text: instruction,
      });
      await eventually(async () => {
        const current = await stores.state.load();
        return current && !current.busy &&
            current.messages.some((message) =>
              message.role === "assistant" &&
              message.text ===
                "Reviewer response: Observed by Retained reviewer"
            )
          ? true
          : undefined;
      }, {
        label: "fresh BO uses its retained member's correlated reply",
        timeoutMs: 60_000,
      });
      const second = await host.stage.openings.open({
        ...openingCommand,
        openingKey: crypto.randomUUID(),
        text: "Start a separate Request from this same retained Release.",
      }, renewedSession.secret);
      assert.equal(second.phase, "dispatched");
      assert.notEqual(second.caseId, record.caseId);
      const secondMember = await host.storage.readCaseRuntimeState(
        second.executionSpaceId,
        second.caseId,
        memberId,
      );
      assert.equal(
        secondMember?.executionModel?.version.digest,
        retainedMember.modelDigest,
      );
      await eventually(async () => {
        const current = await host.storage.readCaseRuntimeState(
          second.executionSpaceId,
          second.caseId,
          host.primaryOperatorId,
        );
        return current && !current.busy &&
            current.messages.some((message) => message.role === "assistant")
          ? true
          : undefined;
      }, {
        label: "second Release opening completes its initial turn",
        timeoutMs: 60_000,
      });
      await host.stage.controls.revokeCapability(
        await host.stage.controls.authenticateSession(session.secret),
      );
      await assert.rejects(
        () => host.stage.openings.open(openingCommand, renewedSession.secret),
        (error: unknown) => {
          assert.ok(error instanceof RequestSpaceError);
          assert.equal(error.code, "ADMISSION_REFUSED");
          assert.equal(error.context?.check, "dispatch.admission.status");
          return true;
        },
        "a new capability never revives the original revoked admission",
      );
      assert.deepEqual(await origin.stores.state.load(), originState);
      assert.deepEqual(
        await host.storage.readCaseRuntimeState(
          origin.record.executionSpaceId,
          origin.record.caseId,
          memberId,
        ),
        originMember,
        "work in fresh Requests leaves the origin member unchanged",
      );
      assert.equal(host.workerErrors.length, 0);
      mark("target-verified");
    });
  },
});

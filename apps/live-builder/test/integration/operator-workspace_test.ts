import { ExplicitTooling } from "../support/explicit-tooling.ts";
/** Real three-operator composition: native sources, Git, and PostgreSQL.
 * The provider double returns decisions; all dispatch, pins, and receipts use
 * production mechanisms. No LLM, network read, or commercial effect is invoked. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { PostgresTestDatabase } from "../support/postgres.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type {
  AgentPort,
  ModelDiagnosticsPort,
} from "../../src/application/work/runtime/ports.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import type { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { SourceModelDiagnosticsReader } from "../../src/adapters/model/diagnostics/source.ts";
import { ModelDiagnosticsService } from "../../src/application/model/diagnostics/service.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import type { AgentConversation } from "../../src/domain/work/records/conversations.ts";
import type {
  NetworkImpactConsultationPage,
  NetworkImpactConsultationSummary,
} from "../../src/application/model/impact/consultation.ts";
import {
  mandateSources,
  nativeId,
  openMandateFixture,
} from "../fixtures/model-edit-mandate.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "workspace network consultation uses injected own history, preserves unavailable sources and exact live admission pins",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openMandateFixture(packageDir!);
    const postgres = f.postgres;
    const store = postgres.primary.state;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      const agents: AgentPort = {
        label: "workspace-network-scope",
        decide: () => Promise.resolve({ kind: "reply", text: "Ready" }),
        review() {
          throw new Error("No review expected");
        },
      };
      const executors: BehaviorInvocationPort[] = [];
      const service = new SystemRuntime({
        ...postgres.runtimePorts,
        agents,
        model: f.primary,
        store,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
      });
      await service.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const initial = await f.repository.current();
      const history = await GitModelRepository.openReadOnly({
        projectDir: f.projectDir,
        repositoryId: f.postgres.backend.project.id,
      });
      let primaryHistoryReads = 0;
      const injectedHistory = {
        readNetworkImpactEvidence: (
          input: Parameters<
            PostgresSystemStateStore["readNetworkImpactEvidence"]
          >[0],
        ) => {
          primaryHistoryReads++;
          return store!.readNetworkImpactEvidence(input);
        },
      };
      const options = {
        ...postgres.workspacePorts,
        createSourceModel: postgres.backend.createSourceModel,
        primary: service,
        primaryModel: f.primary,
        repository: f.repository,
        tooling: f.tooling,
        agents,
        directory: f.directory,
        executors,
        networkImpactRepository: history,
      };
      workspace = await openOperatorWorkspace({
        ...options,
        primaryHistory: injectedHistory,
      });
      await postgres.start(workspace);
      const admitted = service.snapshot.executionModel!;
      const peer = workspace.runtimeFor(f.peerIdentity.builderId)!.runtime
        .snapshot.executionModel!;
      const query = (model: typeof admitted) => ({
        operation: "network_impact",
        version: initial.version,
        action: "compare",
        operatorId: model.identity.builderId,
        host: "example.org",
        fromVersion: initial.version,
        toVersion: initial.version,
      });
      await workspace.information.read(admitted);
      const summary = (await workspace.information.consultModel!(
        admitted,
        query(admitted),
      ) as { result: NetworkImpactConsultationSummary }).result;
      assert.equal(primaryHistoryReads, 1);
      assert.deepEqual(
        summary.evidenceRead.sources?.map((source) => source.kind),
        ["state"],
      );
      assert.equal(summary.coverage.recordsReadComplete, false);
      const issues = (await workspace.information.consultModel!(admitted, {
        operation: "network_impact",
        version: initial.version,
        action: "details",
        analysisRef: summary.analysisRef,
        view: "issues",
      }) as { result: NetworkImpactConsultationPage }).result;
      assert(JSON.stringify(issues).includes("SKILL_EVIDENCE_NOT_CONFIGURED"));
      assert.equal(
        await postgres.primary.skills.load(f.primaryIdentity.builderId),
        null,
      );
      await assert.rejects(
        () =>
          workspace!.information.consultModel!(admitted, {
            ...query(admitted),
            operatorId: peer.identity.builderId,
          }),
        { code: "MODEL_CONTEXT_SCOPE" },
      );
      assert.equal(primaryHistoryReads, 1);
      await workspace.information.read(peer);
      const peerSummary =
        (await workspace.information.consultModel!(peer, query(peer)) as {
          result: NetworkImpactConsultationSummary;
        }).result;
      assert.deepEqual(
        peerSummary.evidenceRead.sources?.map((source) => source.kind),
        ["state"],
      );
      assert.notEqual(
        peerSummary.evidenceRead.sources?.[0]?.id,
        summary.evidenceRead.sources?.[0]?.id,
      );
      assert.equal(primaryHistoryReads, 1);
      await assert.rejects(
        () =>
          workspace!.information.consultModel!(peer, {
            ...query(peer),
            operatorId: admitted.identity.builderId,
          }),
        { code: "MODEL_CONTEXT_SCOPE" },
      );

      const commented = {
        ...initial.sources,
        "mission.sysml": `${
          initial.sources["mission.sysml"]
        }\n// Same executable contract, new immutable admission pin.\n`,
      };
      const published = await f.repository.publishSystemSources(
        commented,
        initial.version,
        "workspace-network-pin",
      );
      const next = await validateSourceExecutable(published, f.projectId);
      assert.equal(next.version.digest, admitted.version.digest);
      assert.equal(next.version.repositoryVersion, published.version);
      assert.equal(
        service.snapshot.executionModel!.version.repositoryVersion,
        initial.version,
      );
      // The source view may advance independently of the actual admitted pin.
      // It must retain this Request's consultation pin and cached analysis.
      const sourceView = await workspace.information.read(next);
      assert.equal(sourceView.modelContext!.version, initial.version);
      const sourceViewPage = (await workspace.information.consultModel!(next, {
        operation: "network_impact",
        version: initial.version,
        action: "details",
        analysisRef: summary.analysisRef,
        view: "evidence",
      }) as { result: NetworkImpactConsultationPage }).result;
      assert.equal(sourceViewPage.analysisRef, summary.analysisRef);
      assert.equal(primaryHistoryReads, 1);
      const sourceViewSummary =
        (await workspace.information.consultModel!(next, query(next)) as {
          result: NetworkImpactConsultationSummary;
        }).result;
      assert.equal(sourceViewSummary.version, initial.version);
      assert.equal(primaryHistoryReads, 2);
      const command = {
        agentId: admitted.identity.builderId,
        expectedDigest: next.version.digest,
        expectedVersion: published.version,
      };
      await workspace.adopt(command, () => service.adoptModelVersion(command));
      assert.equal(
        service.snapshot.executionModel!.version.repositoryVersion,
        published.version,
      );
      await assert.rejects(
        () =>
          workspace!.information.consultModel!(admitted, {
            operation: "network_impact",
            version: initial.version,
            action: "details",
            analysisRef: summary.analysisRef,
            view: "evidence",
          }),
        { code: "MODEL_CONTEXT_AUTHORITY" },
      );
      await assert.rejects(
        () =>
          workspace!.information.consultModel!(next, {
            operation: "network_impact",
            version: initial.version,
            action: "details",
            analysisRef: sourceViewSummary.analysisRef,
            view: "evidence",
          }),
        { code: "MODEL_CONTEXT_AUTHORITY" },
      );
      assert.equal(primaryHistoryReads, 2);
      const retainedPeerPage =
        (await workspace.information.consultModel!(peer, {
          operation: "network_impact",
          version: initial.version,
          action: "details",
          analysisRef: peerSummary.analysisRef,
          view: "evidence",
        }) as { result: NetworkImpactConsultationPage }).result;
      assert.equal(retainedPeerPage.analysisRef, peerSummary.analysisRef);
      assert.equal(primaryHistoryReads, 2);

      await workspace.close();
      workspace = undefined;
      workspace = await openOperatorWorkspace({ ...options, executors: [] });
      await postgres.start(workspace);
      assert.equal(
        workspace.information.modelTools!(service.snapshot.executionModel!)
          .some((tool) => tool.operation === "network_impact"),
        false,
      );
      const current = service.snapshot.executionModel!;
      await workspace.information.read(current);
      await assert.rejects(() =>
        workspace!.information.consultModel!(current, {
          ...query(current),
          version: published.version,
        }), { code: "MODEL_CONTEXT_INPUT" });
      assert.equal(primaryHistoryReads, 2);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "a registered secondary without endpoint metadata cannot read or address diagnostics",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-secondary-diagnostics-",
    });
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      const sources = await mandateSources({ raw: true });
      const endpointMetadata = `
 attribute operatorName : String = "Scoped peer";
 attribute operatorInstruction : String = "Edit only the delegated beta root.";
 attribute primaryContact : Boolean = false;
 attribute humanInputEnabled : Boolean = false;`;
      assert(sources["configuration.sysml"]!.includes(endpointMetadata));
      sources["configuration.sysml"] = sources["configuration.sysml"]!
        .replace(endpointMetadata, "");
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources,
      });
      const projectId = postgres.backend.projectId;
      const repository = postgres.repository;
      const tooling = postgres.backend.tooling;
      const primaryModel = postgres.backend.model;
      const store = postgres.primary.state;
      const initial = await repository.current();
      const peerModel = await validateSourceExecutable(
        initial,
        projectId,
        "AssemblyLiveBuilder::mandatePeer",
      );
      assert.equal(peerModel.operator, undefined);
      const diagnostics = new ModelDiagnosticsService(
        new SourceModelDiagnosticsReader(repository, projectId),
        { list: () => Promise.resolve([]), set: () => Promise.resolve() },
      );
      const finding = (await diagnostics.list(initial.version)).diagnostics
        .find((entry) =>
          entry.code === "LOOP_WITHOUT_BUDGET" &&
          entry.elementId === peerModel.identity.systemId
        );
      assert(finding?.elementId);
      const addresses = [{ code: finding.code, elementId: finding.elementId }];
      const targetId = nativeId(initial, "Work::beta::value");
      const reads: string[] = [];
      const modelDiagnostics: ModelDiagnosticsPort = {
        async read(model, version) {
          reads.push(model.identity.builderId);
          return (await diagnostics.list(
            version ?? model.version.repositoryVersion,
          )).diagnostics;
        },
      };
      const contexts: ChatContext[] = [];
      let proposal: "raw" | "targeted" | undefined;
      const agents: AgentPort = {
        label: "secondary-without-endpoint-metadata",
        decide(context) {
          contexts.push(structuredClone(context));
          if (!proposal) {
            return Promise.resolve({ kind: "reply", text: "Ready" });
          }
          assert(context.modelContext);
          const common = {
            text: "Propose a delegated correction",
            reason: "Address the existing diagnostic from a secondary",
            baseVersion: context.modelContext.version,
            addresses,
          };
          if (proposal === "targeted") {
            return Promise.resolve({
              ...common,
              kind: "propose_sysml_edit",
              sourceDigest: context.modelContext.sourceDigest,
              edits: [{
                kind: "set-value",
                elementId: targetId,
                expression: "12",
              }],
            });
          }
          const mission = context.modelSources?.sources["mission.sysml"];
          if (!mission) {
            return Promise.resolve({
              kind: "consult_model",
              text: "Read the delegated source before proposing its revision",
              inputJson: JSON.stringify({
                operation: "read_source",
                version: context.modelContext.version,
                path: "mission.sysml",
              }),
            });
          }
          return Promise.resolve({
            ...common,
            kind: "propose_sysml_revision",
            sources: {
              "mission.sysml": mission.replace(
                "attribute value : Integer = 2;",
                "attribute value : Integer = 12;",
              ),
            },
          });
        },
        review() {
          throw new Error("No candidate review is expected");
        },
      };
      const executors: BehaviorInvocationPort[] = [];
      const service = new SystemRuntime({
        ...postgres.runtimePorts,
        agents,
        model: primaryModel,
        modelDiagnostics,
        store,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
      });
      await service.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        createSourceModel: postgres.backend.createSourceModel,
        primaryHistory: store,
        primary: service,
        primaryModel,
        repository,
        tooling,
        agents,
        modelDiagnostics,
        directory,
        executors,
      });
      await postgres.start(workspace);
      const peer = workspace.runtimeFor(peerModel.identity.builderId)!.runtime;
      assert.equal(peer.snapshot.executionModel!.operator, undefined);
      const registered = workspace.conversations.snapshot.conversations.find(
        (entry) => entry.agentId === peerModel.identity.builderId,
      );
      assert(registered);
      assert.equal(registered.primary, false);

      await peer.submit("Read the current diagnostics");
      await postgres.idle(peer);
      assert.equal(peer.snapshot.error, undefined);
      assert.equal(contexts.at(-1)!.modelDiagnostics, undefined);
      assert.deepEqual(reads, []);

      for (const kind of ["raw", "targeted"] as const) {
        proposal = kind;
        const before = contexts.length;
        await peer.submit(`Propose a ${kind} correction`);
        await postgres.idle(peer);
        assert(contexts.length > before);
        assert.match(
          peer.snapshot.error ?? "",
          /Only the primary operator may address model diagnostics/,
        );
        assert(
          contexts.slice(before).every((context) =>
            context.modelDiagnostics === undefined
          ),
        );
        assert.deepEqual(reads, []);
        assert.deepEqual(await repository.listProposals(), []);
      }
      assert.equal((await repository.current()).version, initial.version);
    } finally {
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "the admitted primary retains diagnostics and addresses after a comment-only publication",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openMandateFixture(packageDir!, { raw: true });
    const postgres = f.postgres;
    const store = postgres.primary.state;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      const initial = await f.repository.current();
      const diagnostics = new ModelDiagnosticsService(
        new SourceModelDiagnosticsReader(f.repository, f.projectId),
        { list: () => Promise.resolve([]), set: () => Promise.resolve() },
      );
      const reads: Array<{ sourceVersion?: string; baseVersion?: string }> = [];
      const modelDiagnostics: ModelDiagnosticsPort = {
        async read(model, baseVersion) {
          reads.push({
            sourceVersion: model.version.repositoryVersion,
            baseVersion,
          });
          return (await diagnostics.list(
            baseVersion ?? model.version.repositoryVersion,
          )).diagnostics;
        },
      };
      const address = {
        code: "LOOP_WITHOUT_BUDGET",
        elementId: f.primaryIdentity.systemId,
      };
      const targetId = nativeId(initial, "Work::alpha::value");
      const contexts: ChatContext[] = [];
      let proposal: "raw" | "targeted" | undefined;
      const agents: AgentPort = {
        label: "comment-only-primary-diagnostics",
        decide(context) {
          contexts.push(structuredClone(context));
          if (!proposal) {
            return Promise.resolve({ kind: "reply", text: "Ready" });
          }
          assert(context.modelContext);
          const common = {
            text: "Propose a correction after a comment-only publication",
            reason:
              "Address a diagnostic under the unchanged admitted contract",
            baseVersion: context.modelContext.version,
            addresses: [address],
          };
          if (proposal === "targeted") {
            return Promise.resolve({
              ...common,
              kind: "propose_sysml_edit",
              sourceDigest: context.modelContext.sourceDigest,
              edits: [{
                kind: "set-value",
                elementId: targetId,
                expression: "12",
              }],
            });
          }
          const mission = context.modelSources?.sources["mission.sysml"];
          if (!mission) {
            return Promise.resolve({
              kind: "consult_model",
              text: "Read the source for the correction",
              inputJson: JSON.stringify({
                operation: "read_source",
                version: context.modelContext.version,
                path: "mission.sysml",
              }),
            });
          }
          return Promise.resolve({
            ...common,
            kind: "propose_sysml_revision",
            sources: {
              "mission.sysml": mission.replace(
                "attribute value : Integer = 1;",
                "attribute value : Integer = 12;",
              ),
            },
          });
        },
        review() {
          throw new Error("No candidate review is expected");
        },
      };
      const executors: BehaviorInvocationPort[] = [];
      const service = new SystemRuntime({
        ...postgres.runtimePorts,
        agents,
        model: f.primary,
        modelDiagnostics,
        store,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
        information: {
          read: (model, messages) =>
            workspace!.information.read(model, messages),
          consultModel: (model, input, messages) =>
            workspace!.information.consultModel!(model, input, messages),
          consultAdmittedModelSource: (model, input, messages, budget) =>
            workspace!.information.consultAdmittedModelSource!(
              model,
              input,
              messages,
              budget,
            ),
        },
      });
      await service.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        createSourceModel: postgres.backend.createSourceModel,
        primaryHistory: store,
        primary: service,
        primaryModel: f.primary,
        repository: f.repository,
        tooling: f.tooling,
        agents,
        modelDiagnostics,
        directory: f.directory,
        executors,
      });
      await postgres.start(workspace);
      const admitted = service.snapshot.executionModel!;
      const published = await f.repository.publishSystemSources(
        {
          ...initial.sources,
          "configuration.sysml":
            "// A source comment leaves the contract intact.\n" +
            initial.sources["configuration.sysml"],
        },
        initial.version,
        "comment-only-diagnostics-qualification",
      );
      assert.notEqual(published.version, initial.version);
      const current = await f.primary.readExecutableModel(f.primaryIdentity);
      assert.equal(current.version.digest, admitted.version.digest);
      assert.equal(current.version.repositoryVersion, published.version);
      for (const kind of [undefined, "raw", "targeted"] as const) {
        proposal = kind;
        const conversation: AgentConversation = workspace.conversations.snapshot
          .conversations
          .find((entry) => entry.agentId === f.primaryIdentity.builderId)!;
        assert.equal(conversation.primary, true);
        assert.equal(conversation.repositoryVersion, initial.version);
        assert.equal(conversation.modelDigest, admitted.version.digest);
        const before = contexts.length;
        await workspace.conversations.submitHuman({
          agentId: conversation.agentId,
          expectedRevision: conversation.revision,
          text: kind
            ? `Propose a ${kind} correction`
            : "Read current diagnostics",
        });
        await workspace.conversations.idle();
        await postgres.idle();
        assert.equal(service.snapshot.error, undefined);
        assert(contexts.length > before);
        for (const context of contexts.slice(before)) {
          assert(
            context.modelDiagnostics?.some((entry) =>
              entry.code === address.code &&
              entry.elementId === address.elementId
            ),
          );
          assert.equal(
            context.modelVersion!.repositoryVersion,
            published.version,
          );
          assert.equal(
            context.admittedModelVersion!.repositoryVersion,
            initial.version,
          );
        }
        assert.deepEqual(service.snapshot.executionModel, admitted);
        assert.equal(service.snapshot.availableExecutionModel, undefined);
      }
      const proposals = await f.repository.listProposals();
      assert.equal(proposals.length, 2);
      for (const proposed of proposals) {
        assert.equal(proposed.baseVersion, published.version);
        assert.deepEqual(proposed.addresses, [address]);
      }
      assert(reads.every((read) => read.sourceVersion === published.version));
      assert.equal(
        reads.filter((read) => read.baseVersion === published.version).length,
        2,
      );
      assert.equal((await f.repository.current()).version, published.version);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "diagnostics follow the current primary after the old primary adopts the transfer first",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openMandateFixture(packageDir!);
    const postgres = f.postgres;
    const store = postgres.primary.state;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      const diagnostics = new ModelDiagnosticsService(
        new SourceModelDiagnosticsReader(f.repository, f.projectId),
        { list: () => Promise.resolve([]), set: () => Promise.resolve() },
      );
      const reads: Array<{ operatorId: string; version?: string }> = [];
      const modelDiagnostics: ModelDiagnosticsPort = {
        async read(model, version) {
          reads.push({ operatorId: model.identity.builderId, version });
          return (await diagnostics.list(
            version ?? model.version.repositoryVersion,
          )).diagnostics;
        },
      };
      const contexts: ChatContext[] = [];
      let propose = false;
      const initial = await f.repository.current();
      const targetId = nativeId(initial, "Work::beta::value");
      const agents: AgentPort = {
        label: "primary-transfer-diagnostics",
        decide(context) {
          contexts.push(structuredClone(context));
          if (propose) {
            propose = false;
            const finding = context.modelDiagnostics?.find((entry) =>
              entry.code === "LOOP_WITHOUT_BUDGET" &&
              entry.qualifiedName === "AssemblyLiveBuilder::mandatePeer"
            );
            assert(finding?.elementId);
            assert(context.modelContext);
            return Promise.resolve({
              kind: "propose_sysml_edit",
              text: "Propose an invocation limit for the budget diagnostic",
              reason:
                "Record a proposed invocation limit in the delegated scope",
              baseVersion: context.modelContext.version,
              sourceDigest: context.modelContext.sourceDigest,
              addresses: [{ code: finding.code, elementId: finding.elementId }],
              edits: [{
                kind: "set-value",
                elementId: targetId,
                expression: "12",
              }],
            });
          }
          return Promise.resolve({
            kind: "reply",
            text: "Diagnostics observed",
          });
        },
        review() {
          throw new Error("No candidate review is expected");
        },
      };
      const executors: BehaviorInvocationPort[] = [];
      const service = new SystemRuntime({
        ...postgres.runtimePorts,
        agents,
        model: f.primary,
        modelDiagnostics,
        store,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
      });
      await service.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        createSourceModel: postgres.backend.createSourceModel,
        primaryHistory: store,
        primary: service,
        primaryModel: f.primary,
        repository: f.repository,
        tooling: f.tooling,
        agents,
        modelDiagnostics,
        directory: f.directory,
        executors,
      });
      const peer = workspace.runtimeFor(f.peerIdentity.builderId)!.runtime;
      assert.equal(peer.snapshot.executionModel!.operator!.primary, false);
      await service.submit("Read the current diagnostics");
      await postgres.idle(service);
      assert.equal(service.snapshot.error, undefined);
      assert(contexts.at(-1)!.modelDiagnostics?.length);

      const transfer = { ...initial.sources };
      // The initial Main Operator endpoint is already declared; transfer it in place.
      const beforeTransfer = transfer["configuration.sysml"]!;
      const renamedPrimary = beforeTransfer.replace(
        'attribute operatorName : String = "Main Operator";',
        'attribute operatorName : String = "Former primary";',
      );
      assert.notEqual(
        renamedPrimary,
        beforeTransfer,
        "the current primary name must actually change",
      );
      transfer["configuration.sysml"] = renamedPrimary.replace(
        'attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests.";',
        'attribute operatorInstruction : String = "Edit only the delegated alpha root.";',
      ).replace(
        "attribute primaryContact : Boolean = true;",
        "attribute primaryContact : Boolean = false;",
      ).replace(
        "primaryContact : Boolean = false;\n attribute humanInputEnabled : Boolean = false;",
        "primaryContact : Boolean = true;\n attribute humanInputEnabled : Boolean = true;",
      );
      const next = await f.repository.publishSystemSources(
        transfer,
        initial.version,
        "primary-transfer-qualification",
      );
      for (
        const [runtime, scope] of [
          [service, "AssemblyLiveBuilder::liveBuilder"],
          [peer, "AssemblyLiveBuilder::mandatePeer"],
        ] as const
      ) {
        const prospective = await validateSourceExecutable(
          next,
          f.projectId,
          scope,
        );
        const command = {
          agentId: prospective.identity.builderId,
          expectedDigest: prospective.version.digest,
          expectedVersion: next.version,
        };
        await workspace.adopt(
          command,
          () => runtime.adoptModelVersion(command),
        );
        if (runtime === service) {
          assert.equal(
            service.snapshot.executionModel!.operator!.primary,
            false,
          );
          assert.equal(peer.snapshot.executionModel!.operator!.primary, false);
          const readsBefore = reads.length;
          await service.submit("Read after relinquishing the primary role");
          await postgres.idle(service);
          assert.equal(service.snapshot.error, undefined);
          assert.equal(contexts.at(-1)!.modelDiagnostics, undefined);
          assert.equal(reads.length, readsBefore);
        }
      }
      assert.equal(peer.snapshot.executionModel!.operator!.primary, true);
      propose = true;
      const conversation = workspace.conversations.snapshot.conversations.find(
        (entry) => entry.agentId === f.peerIdentity.builderId,
      )!;
      await workspace.conversations.submitHuman({
        agentId: conversation.agentId,
        expectedRevision: conversation.revision,
        text: "Propose a correction for the budget diagnostic",
      });
      await workspace.conversations.idle();
      await postgres.idle();
      assert.equal(peer.snapshot.error, undefined);
      const proposals = await f.repository.listProposals();
      assert.equal(proposals.length, 1);
      assert.deepEqual(proposals[0]!.addresses, [{
        code: "LOOP_WITHOUT_BUDGET",
        elementId: peer.snapshot.executionModel!.identity.systemId,
      }]);
      assert(
        reads.some((read) =>
          read.operatorId === f.peerIdentity.builderId &&
          read.version === next.version
        ),
      );
      assert.equal((await f.repository.current()).version, next.version);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "normal three-operator workspace dispatches a native plan, adopts independent pins, and restarts after an unadopted removal",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-operator-workspace-",
    });
    let current:
      | {
        service: SystemRuntime;
        store: PostgresSystemStateStore;
        postgres: Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
        workspace: Awaited<ReturnType<typeof openOperatorWorkspace>>;
      }
      | undefined;
    let database: PostgresTestDatabase | undefined;
    try {
      let repository: Awaited<
        ReturnType<typeof openPostgresRuntimeFixture>
      >["repository"];
      const sources: Record<string, string> = JSON.parse(
        await Deno.readTextFile(
          new URL(
            "../fixtures/commercial-watch/sources.json",
            import.meta.url,
          ),
        ),
      );
      let planned = false;
      const calls = new Map<string, number>();
      const agents: AgentPort = {
        label: "three-operator-qualification",
        decide(context) {
          const id = context.operator!.nativeId;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          if (context.operator!.name === "Coordinateur veille" && !planned) {
            planned = true;
            const plan = context.modeledBehaviors!.find((entry) =>
              entry.name === "PlanifierTravail"
            )!;
            const targets = context.modeledBehaviors!.filter((entry) =>
              ["ConfierCollecte", "ConfierAnalyse"].includes(entry.name)
            );
            assert.equal(targets.length, 2);
            return Promise.resolve({
              kind: "invoke_behavior",
              behaviorId: plan.id,
              inputJson: JSON.stringify({
                tasksJson: JSON.stringify(targets.map((target, index) => ({
                  id: `task-${index}`,
                  behaviorId: target.id,
                  input: { text: `Dossier transmis ${index}` },
                  dependsOn: [],
                }))),
              }),
              text: "Répartir les deux dossiers par les entrées admises.",
            });
          }
          if (context.operator!.name !== "Coordinateur veille") {
            const received = context.messages.filter((message) => message.work);
            assert.equal(received.length, 1);
            assert.equal(received[0]!.role, "tool");
            assert(
              context.messages.every((message) => message.role !== "user"),
            );
          }
          return Promise.resolve({ kind: "reply", text: `Reçu par ${id}` });
        },
        review() {
          throw new Error("No candidate is built in this composition test");
        },
      };
      const open = async () => {
        const postgres = await openPostgresRuntimeFixture({
          dataDir: directory,
          database,
          ...(database ? {} : { sources }),
        });
        database = postgres.database;
        repository = postgres.repository;
        const model = postgres.backend.model;
        const store = postgres.primary.state;
        const executors: BehaviorInvocationPort[] = [];
        const service = new SystemRuntime({
          ...postgres.runtimePorts,
          ...postgres.runtimePorts,
          agents,
          model,
          store,
          runner: new DenoToolRunner(),
          behaviors: new BehaviorInvocationRegistry(executors),
        });
        try {
          await service.initialize(undefined, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          });
          const workspace = await openOperatorWorkspace({
            ...postgres.workspacePorts,
            createSourceModel: postgres.backend.createSourceModel,
            primaryHistory: store,
            tooling: new ExplicitTooling({ query: null, check: [] }),
            primary: service,
            primaryModel: model,
            repository,
            agents,
            directory,
            executors,
          });
          await postgres.start(workspace);
          return { service, store, workspace, postgres };
        } catch (error) {
          await postgres.close();
          throw error;
        }
      };
      const close = async () => {
        await current?.postgres.close({ retainDatabase: true });
        current = undefined;
      };
      current = await open();
      repository = current.postgres.repository;
      const projectId = current.postgres.backend.projectId;
      const initial = current.workspace.conversations.snapshot;
      assert.equal(initial.conversations.length, 3);
      assert.equal(
        initial.conversations.filter((entry) => entry.canSend).length,
        1,
      );
      const coordinator = initial.conversations.find((entry) =>
        entry.name === "Coordinateur veille"
      )!;
      const collector = initial.conversations.find((entry) =>
        entry.name === "Collecteur"
      )!;
      const analyst = initial.conversations.find((entry) =>
        entry.name === "Analyste"
      )!;
      const s0 = await repository.current();
      await assert.rejects(() =>
        current!.workspace.conversations.submitHuman({
          agentId: collector.agentId,
          text: "Contournement humain",
          expectedRevision: collector.revision,
        }), /n’autorise pas de consigne humaine/);
      await current.workspace.conversations.submitHuman({
        agentId: coordinator.agentId,
        text:
          "Distribue deux dossiers dans un plan fermé et retourne les reçus.",
        expectedRevision: coordinator.revision,
      });
      await current.postgres.idle(current.service);
      await current.workspace.conversations.idle();
      await current.postgres.idle();
      assert.equal(current.service.snapshot.error, undefined);
      assert.equal(calls.get(coordinator.agentId), 2);
      assert.equal(calls.get(collector.agentId), 1);
      assert.equal(calls.get(analyst.agentId), 1);
      for (const id of [collector.agentId, analyst.agentId]) {
        const state: SystemRuntimeState =
          current.workspace.runtimeFor(id)!.runtime.snapshot;
        assert.equal(state.events.at(-1)!.kind, "operator-work-completed");
      }

      // A semantic change in one worker does not adopt it in another session.
      const changed = { ...s0.sources };
      assert(changed["collect.sysml"]!.includes("Tu es Collecteur"));
      changed["collect.sysml"] = changed["collect.sysml"]!.replace(
        "Tu es Collecteur",
        "Tu es Collecteur qualifié",
      );
      const s1 = await repository.publishSystemSources(
        changed,
        s0.version,
        "qualification",
      );
      const prospective = await validateSourceExecutable(
        s1,
        projectId,
        "ASECollect::collector",
      );
      assert.notEqual(prospective.version.digest, collector.modelDigest);
      const worker = current.workspace.runtimeFor(collector.agentId)!.runtime;
      const command = {
        agentId: collector.agentId,
        expectedDigest: prospective.version.digest,
        expectedVersion: s1.version,
      };
      await current.workspace.adopt(
        command,
        () => worker.adoptModelVersion(command),
      );
      assert.equal(
        worker.snapshot.executionModel!.version.repositoryVersion,
        s1.version,
      );
      assert.equal(
        current.service.snapshot.executionModel!.version.repositoryVersion,
        s0.version,
      );
      assert.equal(
        current.workspace.runtimeFor(analyst.agentId)!.runtime.snapshot
          .executionModel!.version.repositoryVersion,
        s0.version,
      );
      const receivedBeforeRestart = current.workspace.conversations.snapshot
        .conversations.map((entry) => ({
          agentId: entry.agentId,
          messages: entry.messages,
        }));
      await close();
      current = await open();
      assert.equal(
        current.workspace.runtimeFor(collector.agentId)!.runtime.snapshot
          .executionModel!.version.repositoryVersion,
        s1.version,
      );
      assert.equal(
        current.service.snapshot.executionModel!.version.repositoryVersion,
        s0.version,
      );
      assert.deepEqual(
        current.workspace.conversations.snapshot.conversations.map((entry) => ({
          agentId: entry.agentId,
          messages: entry.messages,
        })),
        receivedBeforeRestart,
      );

      // A globally valid primary transfer may be incompatible with mixed local
      // pins. Refuse before the selected store is changed, not after adoption.
      const transfer = { ...s1.sources };
      transfer["configuration.sysml"] = transfer["configuration.sysml"]!
        .replace(
          "primaryContact : Boolean = true",
          "primaryContact : Boolean = false",
        );
      transfer["collect.sysml"] = transfer["collect.sysml"]!.replace(
        "primaryContact : Boolean = false",
        "primaryContact : Boolean = true",
      ).replace(
        "humanInputEnabled : Boolean = false",
        "humanInputEnabled : Boolean = true",
      );
      const s2 = await repository.publishSystemSources(
        transfer,
        s1.version,
        "qualification",
      );
      const nextWorker = await validateSourceExecutable(
        s2,
        projectId,
        "ASECollect::collector",
      );
      let adopted = false;
      await assert.rejects(() =>
        current!.workspace.adopt({
          agentId: collector.agentId,
          expectedDigest: nextWorker.version.digest,
          expectedVersion: s2.version,
        }, () => {
          adopted = true;
          return Promise.resolve();
        }), /registry|registre|primary|principal|compatible/);
      assert.equal(adopted, false);
      assert.equal(
        current.workspace.runtimeFor(collector.agentId)!.runtime.snapshot
          .executionModel!.version.repositoryVersion,
        s1.version,
      );

      // Accepted source removal is not executable adoption. The historical
      // operator stays inspectable, suspended, and starts no provider call.
      const removed = { ...s2.sources };
      delete removed["analysis.sysml"];
      removed["configuration.sysml"] = removed["configuration.sysml"]!.replace(
        / {8}part analystAccess : ASEInvocations::BehaviorAccess \{[\s\S]*? {8}bind analystAccess\.target = ASEAnalysis::analyst\.inbox;\n/,
        "",
      );
      assert(
        !removed["configuration.sysml"]!.includes("ASEAnalysis::analyst"),
      );
      await repository.publishSystemSources(
        removed,
        s2.version,
        "qualification",
      );
      const providerCalls = [...calls];
      await close();
      current = await open();
      assert.equal(
        current.workspace.conversations.snapshot.conversations.length,
        3,
      );
      assert.match(
        current.workspace.runtimeFor(analyst.agentId)!.runtime.snapshot.phase,
        /exécution suspendue/,
      );
      assert.deepEqual([...calls], providerCalls);
      await close();
    } finally {
      try {
        await current?.postgres.close();
      } finally {
        await database?.close();
      }
      await Deno.remove(directory, { recursive: true });
    }
  },
});

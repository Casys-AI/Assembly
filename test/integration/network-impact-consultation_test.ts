import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { storedBuildMaterializer } from "../../src/adapters/out/sysml-toolkit/compilation/stored-materializer.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceExecutablesCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import type { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import {
  openPostgresFixtureHost,
  openPostgresRuntimeFixture,
} from "../support/postgres-runtime-fixture.ts";
import type { PostgresContextSkillsStore } from "../../src/adapters/out/postgres/skill-store.ts";
import type { SkillCatalogRecord } from "../../src/domain/skills/records/catalog.ts";
import { skillContentDigest } from "../../src/domain/skills/context-skills.ts";
import { HttpsSkillDownloader } from "../../src/adapters/out/http-client/download.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { ModelContextInformation } from "../../src/application/model/consultation/context-information.ts";
import { CompiledNetworkImpactModelReader } from "../../src/application/model/impact/compiled-model-reader.ts";
import { LiveNetworkImpactEvidenceReader } from "../../src/application/model/impact/live-evidence-reader.ts";
import { NetworkImpactService } from "../../src/application/model/impact/analysis.ts";
import {
  NetworkImpactConsultation,
  type NetworkImpactConsultationPage,
  type NetworkImpactConsultationSummary,
  type NetworkImpactConsultationView,
} from "../../src/application/model/impact/consultation.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../src/domain/model/consultation/network-impact.ts";
import { sha256 } from "../../src/domain/model/value-objects/artifact.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import type { NetworkImpactEvidenceMatch } from "../../src/domain/model/consultation/network-impact.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const full = `${path}/${entry.name}`;
      if (entry.isDirectory) await walk(full);
      else {result[full.slice(directory.length)] = await sha256(
          await Deno.readFile(full),
        );}
    }
  };
  await walk(directory);
  return result;
}

Deno.test({
  name:
    "network impact consultation qualifies four native versions through open owner handles and stable bounded pages",
  ignore: !toolkitIntegrationEnabled ||
    !postgresTestEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-network-consultation-",
    });
    const projectDir = `${directory}/model-project`;
    await Deno.mkdir(projectDir);
    const repositoryId = crypto.randomUUID();
    const projectId = `git:${repositoryId}`;
    const host = "raw.githubusercontent.com";
    const url = `https://${host}/fixture/SKILL.md`;
    const buildStore = await KvModelBuildStore.open({ path: ":memory:" });
    const vault = new FileBuildVault({
      directory: `${projectDir}/.assembly/runtime/builds/vault`,
    });
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const builds = new ModelBuildService({
      repositoryId,
      store: buildStore,
      vault,
      compiler,
      materializer: storedBuildMaterializer,
    });
    let stateStore: PostgresSystemStateStore | undefined;
    let skillsStore: PostgresContextSkillsStore | undefined;
    const evidenceHost = await openPostgresFixtureHost();
    try {
      const repository = await GitModelRepository.open({
        projectDir,
        repositoryId,
        compiler,
        buildService: builds,
        buildVault: vault,
      });
      const sources = await loadInitialSources();
      const hostLiteral = JSON.stringify(JSON.stringify([host]));
      sources["configuration.sysml"] = sources["configuration.sysml"].replace(
        'attribute networkHosts : String = "[]";',
        `attribute networkHosts : String = ${hostLiteral};`,
      ).replace(
        'attribute :>> allowedHosts = "[]";',
        `attribute :>> allowedHosts = ${hostLiteral};`,
      ).replace(
        "part catalog : ToolCatalog {",
        `part catalog : ToolCatalog {
        part networkReader : AssemblyLiveBuilder::ToolCandidate {
          attribute candidateId : ScalarValues::String = "network-reader";
          attribute name : ScalarValues::String = "Network reader";
          attribute kind : ScalarValues::String = "read_web_page";
          attribute digest : ScalarValues::String = "${"a".repeat(64)}";
          attribute status : ScalarValues::String = "active";
          bind contract = AssemblyLiveBuilder::liveBuilder.catalog.readWebPageContract;
        }`,
      );
      const initial = await repository.initialize(sources);
      const noWeb = {
        ...sources,
        "configuration.sysml": sources["configuration.sysml"].replace(
          `attribute networkHosts : String = ${hostLiteral};`,
          'attribute networkHosts : String = "[]";',
        ),
      };
      const webRemoved = await repository.publishSystemSources(
        noWeb,
        initial.version,
        "local-control",
      );
      const noNetwork = {
        ...noWeb,
        "configuration.sysml": noWeb["configuration.sysml"].replace(
          `attribute :>> allowedHosts = ${hostLiteral};`,
          'attribute :>> allowedHosts = "[]";',
        ),
      };
      ok(noNetwork["configuration.sysml"] !== noWeb["configuration.sysml"]);
      const allRemoved = await repository.publishSystemSources(
        noNetwork,
        webRemoved.version,
        "local-control",
      );
      const restored = await repository.publishSystemSources(
        sources,
        allRemoved.version,
        "local-control",
      );
      const model1 = await validateSourceExecutable(initial, projectId);
      const model2 = await validateSourceExecutable(webRemoved, projectId);
      const admitted = await validateSourceExecutable(restored, projectId);
      const operatorId = admitted.identity.builderId;
      equal(model1.identity.builderId, operatorId);
      equal(admitted.policy.mayProposeSysmlRevision, true);
      await evidenceHost.storage.registerSystem({
        projectId,
        systemId: "network-impact-evidence",
      });
      const evidenceStores = await evidenceHost.storage.operator(operatorId);
      stateStore = evidenceStores.state;
      skillsStore = evidenceStores.skills;
      const snapshot: SystemRuntimeState = {
        id: "own-history-session",
        revision: 0,
        catalogRevision: 1,
        busy: false,
        phase: "ready",
        provider: "simulated",
        executionModel: model1,
        candidates: [],
        events: [],
        messages: [{
          id: "page-before-withdrawal",
          role: "tool",
          text: "PRIVATE PAGE TEXT",
          at: "2026-10-26T00:00:00Z",
          execution: { ...model1.version, actionId: "catalog-action" },
          observation: {
            kind: "tool-result",
            value: {
              url,
              title: "PRIVATE PAGE TITLE",
              text: "PRIVATE PAGE BODY",
            },
          },
        }],
      };
      await stateStore.save(snapshot, null);
      snapshot.revision = 1;
      snapshot.executionModel = model2;
      snapshot.messages.push({
        id: "refused-after-withdrawal",
        role: "tool",
        text: "PRIVATE REFUSAL TEXT",
        at: "2026-10-26T00:01:00Z",
        execution: { ...model2.version, actionId: "catalog-action" },
        observation: {
          kind: "tool-failure",
          value: {
            code: "NETWORK_SCOPE_DENIED",
            url,
            missingPermission: { kind: "network-host", host },
            allowedHosts: [],
          },
        },
      }, {
        id: "missing-provenance",
        role: "tool",
        text: "PRIVATE LEGACY TEXT",
        at: "2026-10-26T00:02:00Z",
        observation: {
          kind: "tool-result",
          value: {
            url,
            title: "PRIVATE LEGACY TITLE",
            text: "PRIVATE LEGACY BODY",
          },
        },
      }, {
        id: "request-network-impact",
        role: "user",
        text: "Compare the network permission history.",
        at: "2026-10-26T00:03:00Z",
      });
      await stateStore.save(snapshot, 0);
      snapshot.executionModel = admitted;
      // Historical metadata is input to the evidence reader, not a claim that
      // an installation ran in this qualification. Deliberately unbound legacy
      // metadata cannot provide instructions or fabricated Git source receipts.
      const content = "# Fixture\nPRIVATE SKILL INSTRUCTIONS";
      const digest = await skillContentDigest(content);
      const historicalVersion = {
        digest: model1.version.digest,
        repositoryVersion: initial.version,
      };
      const historicalAt = "2026-10-26T00:00:00Z";
      const historicalSkills: SkillCatalogRecord = {
        ownerId: operatorId,
        revision: 0,
        skills: [{
          id: "fixture",
          name: "Fixture",
          description: "",
          digest,
          byteLength: new TextEncoder().encode(content).length,
          content,
          source: {
            kind: "https",
            location: url,
            requestedUrl: url,
            finalUrl: url,
            acquiredAt: historicalAt,
            modelVersion: historicalVersion,
          },
          installedAt: historicalAt,
          loaded: false,
        }],
        operations: [],
      };
      const appendHistoricalInstall = async (invocationId: string) => {
        const expected = historicalSkills.revision;
        historicalSkills.revision++;
        historicalSkills.operations.push({
          kind: "install",
          skillId: "fixture",
          skillDigest: digest,
          callerId: operatorId,
          behaviorId: "historical-unattributed-install",
          invocationId,
          requestDigest: await sha256(
            JSON.stringify({ operatorId, invocationId, url }),
          ),
          policyId: model1.skillPolicy!.id,
          modelVersion: historicalVersion,
          at: historicalAt,
          revision: historicalSkills.revision,
        });
        await skillsStore!.save(
          historicalSkills,
          expected === 0 ? null : expected,
        );
      };
      await appendHistoricalInstall("install-one");
      await appendHistoricalInstall("install-two");
      let sourceReads = 0;
      const evidence = new LiveNetworkImpactEvidenceReader({
        resolveSources(ownerId) {
          equal(ownerId, operatorId);
          sourceReads++;
          return Promise.resolve([
            {
              id: "owner-state",
              kind: "state",
              read: (budget) => stateStore!.readNetworkImpactEvidence(budget),
            },
            {
              id: "owner-skills",
              kind: "skills",
              read: (budget) =>
                skillsStore!.readNetworkImpactEvidence({ ...budget, ownerId }),
            },
          ]);
        },
      });
      const history = await GitModelRepository.openReadOnly({
        projectDir,
        repositoryId,
        buildService: builds,
      });
      const analysis = new NetworkImpactService({
        lineage: history,
        models: new CompiledNetworkImpactModelReader({
          compilation: sourceExecutablesCompilation,
          repository: history,
          projectId,
        }),
        evidence,
      });
      const limits = { ...DEFAULT_NETWORK_IMPACT_LIMITS };
      const consultation = new NetworkImpactConsultation({
        analyze: (input, signal) => analysis.analyze(input, signal),
        limits,
        maxPageSize: 20,
        maxResponseCharacters: 32_000,
      });
      let authorized = true;
      const provider = new ModelContextInformation({
        projectId,
        reader: new ModelContextReader(repository),
        resolveCallerModel: (callerId, version) =>
          Promise.resolve(
            authorized && callerId === operatorId &&
              version.digest === admitted.version.digest &&
              version.repositoryVersion === admitted.version.repositoryVersion
              ? admitted
              : null,
          ),
        snapshotForCaller: () => snapshot,
        readSourceRevision: () =>
          Promise.resolve({ version: restored.version, sources }),
        toolingQuery: () => Promise.resolve({}),
        networkImpact: {
          service: consultation,
          resolveEvidenceScope: (callerId) =>
            Promise.resolve(
              callerId === operatorId
                ? { id: "own-history-scope", ownerId: operatorId }
                : null,
            ),
        },
      });
      const before = await fingerprint(directory);
      const context = await provider.read(admitted);
      ok(
        context.modelTools?.some((tool) => tool.operation === "network_impact"),
      );
      const query = {
        operation: "network_impact",
        version: restored.version,
        action: "compare",
        operatorId,
        host,
        fromVersion: initial.version,
        toVersion: restored.version,
      };
      const receipt = await provider.consultModel(admitted, query);
      const summary = receipt.result as NetworkImpactConsultationSummary;
      equal(summary.action, "compare");
      equal(summary.counts.versions, 4);
      equal(summary.counts.transitions, 3);
      equal(summary.coverage.calculationComplete, true);
      equal(summary.coverage.networkObservationComplete, false);
      equal("frames" in summary, false);
      equal(sourceReads, 1);
      deepStrictEqual(
        summary.evidenceRead.sources?.map((source) => source.revisionBounds),
        [
          { from: 0, to: 1 },
          { from: 2, to: 2 },
        ],
      );
      const page = async (
        view: NetworkImpactConsultationView,
        cursor?: string,
      ) =>
        (await provider.consultModel(admitted, {
          operation: "network_impact",
          version: restored.version,
          action: "details",
          analysisRef: summary.analysisRef,
          view,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        })).result as NetworkImpactConsultationPage;
      const all = async (view: NetworkImpactConsultationView) => {
        const items: unknown[] = [];
        let cursor: string | undefined;
        do {
          const result = await page(view, cursor);
          ok(JSON.stringify(result).length <= 32_000);
          deepStrictEqual(result.evidenceRead, summary.evidenceRead);
          items.push(...result.items);
          cursor = result.nextCursor;
        } while (cursor);
        return items;
      };
      const transitions = await all("transitions") as Array<
        { changes: Array<{ kind: string }> }
      >;
      deepStrictEqual(
        transitions.map((transition) =>
          transition.changes.map((change) => change.kind)
        ),
        [
          ["permission-revoked", "unchanged"],
          ["unchanged", "permission-revoked"],
          ["permission-granted", "permission-granted"],
        ],
      );
      const observations = await all(
        "evidence",
      ) as NetworkImpactEvidenceMatch[];
      ok(
        observations.some((entry) =>
          entry.kind === "page-received" && entry.match === "exact-version"
        ),
      );
      ok(observations.some((entry) => entry.kind === "network-refused"));
      ok(observations.some((entry) => entry.kind === "skill-downloaded"));
      ok(
        observations.some((entry) =>
          entry.kind === "skill-operation-unattributed"
        ),
      );
      ok(observations.some((entry) => entry.match === "unresolved"));
      ok((await all("witnesses")).length > 0);
      equal((await all("versions")).length, 4);
      ok((await all("issues")).length > 0);
      ok(!JSON.stringify([summary, observations]).includes("PRIVATE"));
      deepStrictEqual(await fingerprint(directory), before);
      const captured = await page("evidence");
      snapshot.revision = 2;
      snapshot.messages.push({
        id: "subsequent-page",
        role: "tool",
        text: "PRIVATE NEW PAGE",
        at: "2026-10-26T00:04:00Z",
        execution: { ...admitted.version, actionId: "catalog-action" },
        observation: {
          kind: "tool-result",
          value: { url, text: "PRIVATE NEW BODY" },
        },
      });
      await stateStore.save(snapshot, 1);
      await appendHistoricalInstall("install-three");
      deepStrictEqual(await page("evidence"), captured);
      equal(sourceReads, 1);
      await rejects(
        () =>
          provider.consultModel(admitted, {
            ...query,
            operatorId: "another-native-operator",
          }),
        { code: "MODEL_CONTEXT_SCOPE" },
      );
      equal(sourceReads, 1);
      authorized = false;
      await rejects(() => page("evidence"), {
        code: "MODEL_CONTEXT_AUTHORITY",
      });
      equal(sourceReads, 1);
      // Exercise production composition in addition to the independently
      // assembled analysis above: the primary owner is injected, and the
      // source-admitted initial skill lifecycle opens the real skills owner.
      const workspaceDirectory = `${directory}/workspace`;
      await Deno.mkdir(workspaceDirectory);
      // Retain the existing Git repository and all four exact native versions.
      // The manifest supplies host identity, without recreating source history.
      await Deno.mkdir(`${projectDir}/sources`, { recursive: true });
      await Deno.writeTextFile(
        `${projectDir}/model-project.json`,
        JSON.stringify({
          schemaVersion: 1,
          id: repositoryId,
          name: "model-project",
          sourcesDirectory: "sources",
        }),
      );
      const postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        systemId: "network-impact-workspace",
      });
      const workspaceStore = postgres.primary.state;
      let workspace:
        | Awaited<ReturnType<typeof openOperatorWorkspace>>
        | undefined;
      try {
        const primaryModel = postgres.backend.model;
        const agents = {
          label: "workspace-network-consultation",
          decide: () =>
            Promise.resolve({ kind: "reply" as const, text: "Ready" }),
          review() {
            throw new Error("No candidate review expected");
          },
        };
        const executors: BehaviorInvocationPort[] = [];
        const registry = new BehaviorInvocationRegistry(executors);
        const primary = new SystemRuntime({
          ...postgres.runtimePorts,
          agents,
          model: primaryModel,
          store: workspaceStore,
          runner: new DenoToolRunner(),
          behaviors: registry,
        });
        await primary.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        let ownerReads = 0;
        workspace = await openOperatorWorkspace({
          ...postgres.workspacePorts,
          primary,
          primaryModel,
          repository: postgres.backend.repository,
          tooling: postgres.backend.tooling,
          createSourceModel: postgres.backend.createSourceModel,
          agents,
          directory: workspaceDirectory,
          executors,
          skillDownload: new HttpsSkillDownloader({
            fetch: (() =>
              Promise.resolve(
                new Response("# Workspace fixture\nPRIVATE WORKSPACE SKILL"),
              )) as typeof fetch,
          }),
          primaryHistory: {
            readNetworkImpactEvidence(input) {
              ownerReads++;
              return workspaceStore.readNetworkImpactEvidence(input);
            },
          },
          networkImpactRepository: history,
        });
        await postgres.start(workspace);
        const installedState = await postgres.primary.skills.load(operatorId);
        ok(
          installedState,
          "The source-selected initial skills have a persistent owner",
        );
        const current = primary.snapshot.executionModel!;
        const ownContext = await workspace.information.read(current);
        ok(
          ownContext.skills?.catalog.some((skill) =>
            skill.id === "assembly-modeling"
          ),
        );
        const install = current.behaviors?.find((behavior) =>
          behavior.name === "InstallerSkill"
        );
        ok(install);
        await registry.invoke({
          behavior: install,
          input: { id: "workspace-fixture", url },
          callerId: current.identity.builderId,
          invocationId: "workspace-install",
          modelVersion: {
            digest: current.version.digest,
            repositoryVersion: restored.version,
          },
        });
        const own =
          (await workspace.information.consultModel!(current, query) as {
            result: NetworkImpactConsultationSummary;
          }).result;
        equal(ownerReads, 1);
        deepStrictEqual(
          own.evidenceRead.sources?.map((source) => source.kind).sort(),
          ["skills", "state"],
        );
        ok(own.evidenceRead.sources?.every((source) => source.complete));
        ok(
          own.evidenceRead.sources?.every((source) =>
            source.revisionBounds?.to !== null
          ),
        );
        const ownEvidence =
          (await workspace.information.consultModel!(current, {
            operation: "network_impact",
            version: restored.version,
            action: "details",
            analysisRef: own.analysisRef,
            view: "evidence",
          }) as { result: NetworkImpactConsultationPage }).result;
        ok(
          (ownEvidence.items as NetworkImpactEvidenceMatch[]).some((item) =>
            item.kind === "skill-downloaded"
          ),
        );
        await rejects(
          () =>
            workspace!.information.consultModel!(current, {
              ...query,
              operatorId: "another-native-operator",
            }),
          { code: "MODEL_CONTEXT_SCOPE" },
        );
        equal(ownerReads, 1);
      } finally {
        await postgres.close();
      }
    } finally {
      try {
        await evidenceHost.close();
      } finally {
        await buildStore.close();
      }
      await Deno.remove(directory, { recursive: true });
    }
  },
});

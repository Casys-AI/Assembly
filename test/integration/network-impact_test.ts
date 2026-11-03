import { skillSourceFixture } from "../support/skill-source-fixture.ts";
import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { isAbsolute } from "node:path";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { storedBuildMaterializer } from "../../src/adapters/model/builds/materialization/stored.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { NetworkImpactService } from "../../src/application/model/impact/analysis.ts";
import { CompiledNetworkImpactModelReader } from "../../src/adapters/model/impact/compiled-model-reader.ts";
import { LiveNetworkImpactEvidenceReader } from "../../src/application/model/impact/live-evidence-reader.ts";
import { openPostgresFixtureHost } from "../support/postgres-runtime-fixture.ts";
import { ContextSkillsService } from "../../src/application/skills/context-skills.ts";
import { HttpsSkillDownloader } from "../../src/adapters/out/http-client/download.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { ToolInvocationError } from "../../src/domain/work/errors/tool-invocation.ts";
import { sha256 } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type { Candidate } from "../../src/domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import {
  type NetworkImpactRequest,
} from "../../src/domain/model/consultation/network-impact.ts";
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
    "network withdrawal qualifies native intermediate versions and real skill observations through PostgreSQL owner handles",
  ignore: !toolkitIntegrationEnabled ||
    !postgresTestEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-network-impact-" });
    const projectDir = `${directory}/project`;
    await Deno.mkdir(projectDir);
    const repositoryId = crypto.randomUUID();
    const projectId = `git:${repositoryId}`;
    const host = "raw.githubusercontent.com";
    const url = `https://${host}/fixture/SKILL.md`;
    const store = await KvModelBuildStore.open({ path: ":memory:" });
    const vault = new FileBuildVault({
      directory: `${projectDir}/.assembly/runtime/builds/vault`,
    });
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const builds = new ModelBuildService({
      repositoryId,
      store,
      vault,
      compiler,
      materializer: storedBuildMaterializer,
    });
    const evidenceHost = await openPostgresFixtureHost();
    try {
      const writer = await GitModelRepository.open({
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
      const initial = await writer.initialize(sources);
      const noWeb = {
        ...sources,
        "configuration.sysml": sources["configuration.sysml"].replace(
          `attribute networkHosts : String = ${hostLiteral};`,
          'attribute networkHosts : String = "[]";',
        ),
      };
      const webRemoved = await writer.publishSystemSources(
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
      ok(
        noNetwork["configuration.sysml"] !== noWeb["configuration.sysml"],
        "Skill host list should be explicitly removed",
      );
      const allRemoved = await writer.publishSystemSources(
        noNetwork,
        webRemoved.version,
        "local-control",
      );
      const restored = await writer.publishSystemSources(
        sources,
        allRemoved.version,
        "local-control",
      );
      const model1 = await validateSourceExecutable(initial, projectId);
      const model2 = await validateSourceExecutable(webRemoved, projectId);
      const model4 = await validateSourceExecutable(restored, projectId);
      const operatorId = model1.identity.builderId;
      equal(model2.identity.builderId, operatorId);
      const candidate = {
        id: "network-reader",
        kind: "read_web_page",
        code: "PRIVATE TOOL CODE",
      } as Candidate;
      let refusal: unknown;
      let webFetches = 0;
      try {
        await new DenoToolRunner({
          allowHosts: [],
          fetch: () => {
            webFetches++;
            throw new Error("No transport expected");
          },
        }).run(candidate, { url });
      } catch (error) {
        ok(error instanceof ToolInvocationError);
        refusal = error.failure;
      }
      equal(webFetches, 0);
      await evidenceHost.storage.registerSystem({
        projectId,
        systemId: "network-impact-evidence",
      });
      const evidenceStores = await evidenceHost.storage.operator(operatorId);
      const stateStore = evidenceStores.state;
      const skillsStore = evidenceStores.skills;
      const state: SystemRuntimeState = {
        id: "network-system",
        revision: 0,
        catalogRevision: 1,
        busy: false,
        phase: "ready",
        provider: "simulated",
        executionModel: model1,
        candidates: [],
        events: [],
        messages: [{
          id: "page-1",
          role: "tool",
          text: "PRIVATE PAGE CONTENT",
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
      await stateStore.save(state, null);
      state.revision = 1;
      state.executionModel = model2;
      state.messages.push({
        id: "refused-1",
        role: "tool",
        text: "PRIVATE FAILURE TEXT",
        at: "2026-10-26T00:01:00Z",
        execution: { ...model2.version, actionId: "catalog-action" },
        observation: { kind: "tool-failure", value: refusal },
      });
      await stateStore.save(state, 0);
      state.revision = 2;
      state.executionModel = model4;
      state.events.push({
        id: "declared-call",
        at: "2026-10-26T00:02:00Z",
        kind: "tool-called",
        label: "PRIVATE EVENT LABEL",
        execution: { ...model4.version, actionId: "catalog-action" },
      });
      state.messages.push({
        id: "legacy-page",
        role: "tool",
        at: "2026-10-26T00:03:00Z",
        text: "PRIVATE LEGACY TEXT",
        observation: {
          kind: "tool-result",
          value: {
            url,
            title: "PRIVATE LEGACY TITLE",
            text: "PRIVATE LEGACY PAGE",
          },
        },
      });
      await stateStore.save(state, 1);
      let downloads = 0;
      const service = new ContextSkillsService({
        ...skillSourceFixture().ports,
        store: skillsStore,
        download: new HttpsSkillDownloader({
          fetch: (() => {
            downloads++;
            return Promise.resolve(
              new Response("# Fixture\nPRIVATE SKILL INSTRUCTIONS", {
                status: 200,
              }),
            );
          }) as typeof fetch,
        }),
        now: () => "2026-10-26T00:00:00Z",
      });
      const authority = {
        callerId: operatorId,
        policy: model1.skillPolicy!,
        modelVersion: {
          digest: model1.version.digest,
          repositoryVersion: initial.version,
        },
        behaviorId: "install-exposure",
        invocationId: "install-1",
        permissions: ["install"] as const,
      };
      await service.install({ ...authority, permissions: ["install"] }, {
        id: "fixture",
        url,
      });
      const replay = await service.install({
        ...authority,
        permissions: ["install"],
      }, { id: "fixture", url });
      equal(replay.replayed, true);
      equal(downloads, 1);
      await service.install({
        ...authority,
        invocationId: "install-2",
        permissions: ["install"],
      }, { id: "fixture", url });
      equal(downloads, 2);
      const before = await fingerprint(directory);
      // Read every persisted field and historical row, without evidence budgets
      // or projections hiding writes made during consultation.
      const capturePersistence = () => {
        const client = evidenceHost.database.client;
        return Promise.all([
          client.runtimeState.findMany({ orderBy: { operatorId: "asc" } }),
          client.runtimeRevision.findMany({
            orderBy: [{ operatorId: "asc" }, { revision: "asc" }],
          }),
          client.skillCatalog.findMany({
            orderBy: [{ operatorId: "asc" }, { ownerId: "asc" }],
          }),
          client.skillInvocation.findMany({
            orderBy: [
              { operatorId: "asc" },
              { ownerId: "asc" },
              { callerId: "asc" },
              { invocationId: "asc" },
            ],
          }),
        ]);
      };
      const persistenceBefore = await capturePersistence();
      const request = {
        operatorId,
        host,
        fromVersion: initial.version,
        toVersion: restored.version,
      };
      const evidence = new LiveNetworkImpactEvidenceReader({
        resolveSources(ownerId) {
          if (ownerId !== operatorId) return Promise.resolve([]);
          return Promise.resolve([
            {
              id: "owner-state",
              kind: "state",
              read: (budget) => stateStore.readNetworkImpactEvidence(budget),
            },
            {
              id: "owner-skills",
              kind: "skills",
              read: (budget) =>
                skillsStore.readNetworkImpactEvidence({ ...budget, ownerId }),
            },
          ]);
        },
      });
      // A fresh derived cache per read also exercises the missing-vault path;
      // neither native compilation nor the populated writer cache can mask it.
      const analyze = async (input: NetworkImpactRequest) => {
        const cache = await KvModelBuildStore.open({ path: ":memory:" });
        try {
          const reader = await GitModelRepository.openReadOnly({
            projectDir,
            repositoryId,
            buildService: new ModelBuildService({
              repositoryId,
              store: cache,
              vault: {
                getVerified: (digest) => vault.getVerified(digest),
                has: (digest) => vault.has(digest),
                putVerified: () =>
                  Promise.reject(new Error("Input build vault is read-only")),
              },
              materializer: storedBuildMaterializer,
            }),
          });
          return await new NetworkImpactService({
            lineage: reader,
            models: new CompiledNetworkImpactModelReader({
              repository: reader,
              projectId,
            }),
            evidence,
          }).analyze(input);
        } finally {
          await cache.close();
        }
      };
      const report = await analyze(request);
      equal(
        report.coverage.calculationComplete,
        true,
        JSON.stringify(report.frames.map((entry) => entry.issues)),
      );
      deepStrictEqual(
        report.frames.map((entry) =>
          entry.paths.map((path) => path.hostPermission)
        ),
        [["allowed", "allowed"], ["denied", "allowed"], ["denied", "denied"], [
          "allowed",
          "allowed",
        ]],
      );
      deepStrictEqual(
        report.transitions.map((entry) =>
          entry.changes.map((change) => change.kind)
        ),
        [["permission-revoked", "unchanged"], [
          "unchanged",
          "permission-revoked",
        ], ["permission-granted", "permission-granted"]],
      );
      equal(
        report.evidence.filter((entry) => entry.kind === "page-received")
          .length,
        2,
      );
      const page = report.evidence.find((entry) =>
        entry.id.includes("page-1")
      )!;
      equal(page.match, "exact-version");
      equal(page.relatedVersions[0], initial.version);
      equal(page.policyAtRecordedVersion, "allowed");
      equal(
        report.evidence.find((entry) => entry.kind === "network-refused")
          ?.policyAtRecordedVersion,
        "denied",
      );
      equal(
        report.evidence.filter((entry) => entry.kind === "skill-downloaded")
          .length,
        1,
      );
      equal(
        report.evidence.filter((entry) =>
          entry.kind === "skill-operation-unattributed"
        ).length,
        1,
      );
      equal(
        report.evidence.find((entry) => entry.id.includes("legacy-page"))
          ?.match,
        "unresolved",
      );
      ok(report.evidence.some((entry) => entry.kind === "context-only"));
      ok(report.evidence.every((entry) => entry.startOrder === "unknown"));
      equal(report.coverage.networkObservationComplete, false);
      ok(!JSON.stringify(report).includes("PRIVATE"));
      const partial = await analyze({
        ...request,
        limits: { maxVersions: 2, maxRecords: 1 },
      });
      equal(partial.coverage.calculationComplete, false);
      equal(partial.coverage.recordsReadComplete, false);
      equal(partial.lineage.reason, "version-limit");
      const unknownOperator = await analyze({
        ...request,
        operatorId: "absent-native-operator",
      });
      equal(unknownOperator.coverage.modelReadComplete, false);
      ok(
        unknownOperator.transitions.every((entry) =>
          entry.directAccessAfter === "unknown"
        ),
      );
      deepStrictEqual(await fingerprint(directory), before);
      deepStrictEqual(await capturePersistence(), persistenceBefore);
      // Optional review artifact only; default tests retain no corpus or report.
      const qualificationReport = readAssemblyEnv(
        "ASSEMBLY_NETWORK_IMPACT_QUALIFICATION_REPORT",
      );
      if (qualificationReport) {
        ok(
          isAbsolute(qualificationReport),
          "Qualification report path must be absolute",
        );
        await Deno.writeTextFile(
          qualificationReport,
          JSON.stringify(report, null, 2) + "\n",
          { createNew: true },
        );
      }
      // Missing historical build bytes are unknown; neither source compilation nor cache repair occurs.
      const descriptor = await writer.descriptorAt(webRemoved.version);
      ok(descriptor);
      await Deno.remove(`${vault.directory}/${descriptor.artifactDigest}.zst`);
      const missingBefore = await fingerprint(directory);
      const missing = await analyze(request);
      equal(missing.frames[1].state, "unknown");
      equal(missing.transitions[0].changes[0].kind, "indeterminate");
      deepStrictEqual(await fingerprint(directory), missingBefore);
      deepStrictEqual(await capturePersistence(), persistenceBefore);
    } finally {
      await evidenceHost.close();
      await store.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

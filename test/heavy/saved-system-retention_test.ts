/** Combined 4.11a witness. Real Toolkit, Git/vault, PostgreSQL and runtime
 * admission commands; candidate test outcomes are scripted, never sandbox QA.
 * The frontend controller drives the actual local HTTP edge. No browser layout,
 * human authentication, historical ACL or fresh execution is qualified here. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { savedSystemReadFixture } from "../support/saved-system-read-fixture.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type {
  AgentPort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import { DenoRuntimeProvenanceCollector } from "../../src/infrastructure/runtime-provenance.ts";
import { createConversationsHandler } from "../../src/adapters/in/http/work/conversations.ts";
import { savedSystemDigest } from "../../src/domain/work/records/saved-systems.ts";
import { type SavedSystemView } from "../../src/application/work/saved-systems/release-view.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";

const enabled = toolkitIntegrationEnabled &&
  postgresTestEnabled;
const origin = "http://127.0.0.1:4311";
import {
  retainedToolDraft as draft,
  savedSystemRetentionSources as sources,
  sourceBlock as block,
} from "../support/saved-system-retention-sources.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

function command(path: string, body: unknown) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name:
    "saved exact system crosses real native admission, runtime retirement and cold PostgreSQL/Git/vault inspection",
  ignore: !enabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "assembly-saved-native-pg-",
    });
    let fixture:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    let database:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>["database"]
      | undefined;
    let controller:
      | ReturnType<ReturnType<typeof savedSystemReadFixture>["controller"]>
      | undefined;
    let providerCalls = 0, tests = 0, invocations = 0;
    let succeeded = false;
    let cleanupFailure: Error | undefined;
    let phase = "setup";
    let savedSummary: {
      id: string;
      digest: string | null;
      status: string;
      pins: Array<{ operatorId: string; version: string }>;
    } | undefined;
    let coldProcess: Deno.ChildProcess | undefined;
    const agents: AgentPort = {
      label: "Scripted retention witness; no provider",
      decide() {
        providerCalls++;
        throw new Error("Retention witness must not call a provider");
      },
      review() {
        providerCalls++;
        throw new Error("Human-mode selection must not fabricate review");
      },
      admit() {
        providerCalls++;
        throw new Error("Human-mode selection must not auto-admit");
      },
    };
    const runner: ToolRunnerPort = {
      test(selected) {
        tests++;
        assert.deepEqual({
          name: selected.name,
          description: selected.description,
          kind: selected.kind,
          code: selected.code,
        }, draft);
        return Promise.resolve({
          passed: true,
          checks: [{
            name: "scripted candidate-test boundary",
            passed: true,
            detail:
              "A setup double; this is not tool behavior or sandbox qualification",
          }],
        });
      },
      run() {
        invocations++;
        throw new Error("Saved-system inspection must never invoke tools");
      },
    };
    try {
      fixture = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources: await sources(),
      });
      database = fixture.database;
      phase = "initialize-native-runtimes";
      const provenance = new DenoRuntimeProvenanceCollector({
        applicationDirectory: fileURLToPath(new URL("../../", import.meta.url)),
        toolkitPackageDirectory: fixture.backend.toolkitPackageDirectory,
        agents: { provider: "scripted-test", model: "no-provider-invoked" },
      });
      const executors: BehaviorInvocationPort[] = [];
      const workBudget = new WorkBudgetService(fixture.primary.budget);
      const primary = new SystemRuntime({
        ...fixture.runtimePorts,
        model: fixture.backend.model,
        agents,
        runner,
        workBudget,
        runtimeProvenance: provenance,
        behaviors: new BehaviorInvocationRegistry(executors),
      });
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const workspace = await openOperatorWorkspace({
        ...fixture.workspacePorts,
        createSourceModel: fixture.backend.createSourceModel,
        primaryHistory: fixture.primary.state,
        primary,
        primaryModel: fixture.backend.model,
        repository: fixture.repository,
        tooling: fixture.backend.tooling,
        agents,
        directory,
        executors,
        workBudget,
        runtimeProvenance: provenance,
      });
      await fixture.start(workspace);
      await fixture.idle(primary);
      const pending = primary.snapshot.candidates.find((candidate) =>
        candidate.initialToolSeed?.id === "saved-reader-v1"
      );
      assert(pending);
      assert.equal(pending.stage, "awaiting-admission");
      assert.equal(pending.admission, undefined);
      phase = "admit-exact-candidate";
      const decision = await createConversationsHandler(
        workspace.conversations,
        origin,
      )(command(
        `/api/conversations/${
          encodeURIComponent(fixture.identity.builderId)
        }/decisions`,
        {
          candidateId: pending.id,
          candidateDigest: pending.digest,
          expectedRevision: primary.snapshot.revision,
          verdict: "approve",
          reason:
            "Explicit fixture command admits the exact source-selected candidate under the existing local workflow",
        },
      ));
      assert.equal(decision?.status, 202, await decision?.text());
      await fixture.idle(primary);
      const active = primary.snapshot.candidates.find((candidate) =>
        candidate.id === pending.id
      )!;
      assert.equal(active.stage, "active");
      assert.equal(
        active.admission?.candidateDigest,
        await toolDraftDigest(draft),
      );
      assert(
        active.sourceBinding,
        "The real source writer must have persisted Git and SQL binding receipts",
      );
      assert.equal(tests, 1);
      assert.equal(providerCalls, 0);
      assert.equal(invocations, 0);
      const collector = (await workspace.conversations.conversations())
        .conversations.find((entry) =>
          entry.agentId !== fixture!.identity.builderId && entry.runtimeOwned
        )!;
      assert(collector);
      const collectorRuntime = workspace.runtimeFor(collector.agentId)!.runtime;
      const pins = [
        primary.snapshot.executionModel!,
        collectorRuntime.snapshot.executionModel!,
      ];
      assert.notEqual(
        pins[0].version.repositoryVersion,
        pins[1].version.repositoryVersion,
        "Activation advances only its admitting operator's pin",
      );
      const scope = {
        ...fixture.storage.scope,
        executionSpaceId: fixture.storage.executionSpaceId,
      };
      const read = savedSystemReadFixture({
        client: fixture.storage.client,
        scope,
        projectDir: fixture.backend.project.projectDir,
        repositoryId: fixture.backend.project.id,
        sourceScopeId: fixture.storage.sourceScopeId,
        primaryOperatorId: fixture.identity.builderId,
        buildService: fixture.backend.buildService,
        vault: fixture.backend.vault,
        cache: fixture.backend.store,
        retainCommit: fixture.backend.retainSavedSystemCommit,
      });
      const stateRows = () =>
        database!.client.runtimeState.findMany({
          where: scope,
          orderBy: { operatorId: "asc" },
          select: { operatorId: true, revision: true, payload: true },
        });
      const before = await stateRows();
      const baseline = await fixture.repository.current();
      phase = "save-through-controller-and-http";
      controller = read.controller();
      await controller.save(
        "Retained native system",
        "Inspect exact admitted operators after source Case closure and runtime retirement",
        { branch: { kind: "main" }, sourceVersion: baseline.version },
        { mode: "create", name: "retained-native-system" },
      );
      assert.equal(controller.state.error, "");
      const saved = controller.state.selected!;
      assert(saved);
      savedSummary = {
        id: saved.id,
        digest: saved.digest,
        status: saved.status,
        pins: saved.selectedOperators.map((operator) => ({
          operatorId: operator.operatorId,
          version: operator.repositoryVersion,
        })),
      };
      assert.equal(saved.status, "retained");
      assert.equal(saved.assetAvailability, "verified");
      assert.deepEqual(
        saved.manifest!.operators.map((operator) => operator.repositoryVersion)
          .sort(),
        pins.map(() => baseline.version).sort(),
      );
      assert.equal(
        saved.manifest!.operators.flatMap((operator) => operator.tools).length,
        1,
      );
      assert.deepEqual(
        await stateRows(),
        before,
        "Save changes no canonical runtime state, Case, budget or message history",
      );
      assert.equal(
        (await fixture.repository.current()).version,
        baseline.version,
        "Save changes no working baseline",
      );
      await controller.inspect(saved.id);
      assert.equal(controller.state.selected?.assetAvailability, "verified");
      assert.deepEqual(
        await stateRows(),
        before,
        "Inspect changes no runtime state",
      );
      assert.equal(
        (await read.service.list())[0].assetAvailability,
        "unchecked",
      );
      const initializationCase = primary.snapshot.cases?.find((record) =>
        record.id === active.caseId
      );
      assert.equal(
        initializationCase?.status,
        "closed-done",
        "The source initialization Case closes through the ordinary candidate workflow",
      );

      // A real accepted native revision removes the secondary. Reconciliation
      // retires its runtime while preserving its canonical SQL history.
      phase = "publish-and-adopt-runtime-retirement";
      const head = await fixture.repository.current();
      const removed = block(
        head.sources["configuration.sysml"]!,
        "part collector : ConversationSystem {",
      );
      const working = {
        ...head.sources,
        "configuration.sysml":
          head.sources["configuration.sysml"]!.slice(0, removed.from) +
          head.sources["configuration.sysml"]!.slice(removed.to),
      };
      const advanced = await fixture.repository.publishSystemSources(
        working,
        head.version,
        "Retire the fixture collector after preserving S",
      );
      const nextModel = await validateSourceExecutable(
        advanced,
        fixture.backend.projectId,
      );
      await workspace.adopt(
        {
          expectedDigest: nextModel.version.digest,
          expectedVersion: advanced.version,
        },
        () =>
          primary.adoptModelVersion({
            expectedDigest: nextModel.version.digest,
            expectedVersion: advanced.version,
          }),
      );
      await fixture.idle(primary);
      assert.equal(workspace.runtimeFor(collector.agentId), undefined);
      assert.equal(
        await fixture.storage.client.operatorRuntime.count({
          where: { ...scope, operatorId: collector.agentId },
        }),
        1,
        "Retirement preserves durable history rather than deleting it",
      );
      const historical = await read.service.inspect(saved.id);
      assert.equal(historical.assetAvailability, "verified");
      assert.equal(historical.digest, saved.digest);
      assert.equal(historical.manifest!.operators.length, 2);
      const current = await read.service.save({
        saveKey: "after-retirement",
        tag: { mode: "create", name: "after-retirement" },
        name: "Current native system",
        purpose: "Only currently admitted source members",
        source: { branch: { kind: "main" }, sourceVersion: advanced.version },
      });
      assert.equal(current.status, "retained");
      assert.equal(current.manifest!.registeredOperatorIds.length, 1);
      assert.deepEqual(
        current.manifest!.operators.map((operator) => operator.operatorId),
        [fixture.identity.builderId],
      );
      const afterRetirement = await stateRows();
      const stateDigest = await savedSystemDigest(
        afterRetirement.map((row) => ({
          ...row,
          revision: String(row.revision),
        })),
      );
      const coldArguments = [
        database.schema,
        fixture.backend.project.projectDir,
        fixture.backend.project.id,
        fixture.backend.buildStorage.vaultDirectory,
        fixture.identity.builderId,
        saved.id,
        JSON.stringify(scope),
      ];
      phase = "close-runtime-workers-and-pools";
      await fixture.close({ retainDatabase: true });
      fixture = undefined;
      controller.dispose();
      controller = undefined;

      phase = "cold-subprocess-inspection";
      coldProcess = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          "--frozen",
          "--allow-read",
          "--allow-env",
          "--allow-run=git",
          "--allow-net=127.0.0.1,localhost",
          "--allow-sys=hostname,systemMemoryInfo,cpus",
          fileURLToPath(
            new URL(
              "../support/saved-system-integrated-cold-reader.ts",
              import.meta.url,
            ),
          ),
          ...coldArguments,
        ],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          ASSEMBLY_POSTGRES_TEST_URL: database.connectionString,
          ...(Deno.env.get("DENO_DIR")
            ? { DENO_DIR: Deno.env.get("DENO_DIR")! }
            : {}),
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const coldTimeout = setTimeout(() => {
        try {
          coldProcess?.kill("SIGKILL");
        } catch { /* already reaped */ }
      }, 90_000);
      let output: Deno.CommandOutput;
      try {
        output = await coldProcess.output();
      } finally {
        clearTimeout(coldTimeout);
      }
      const result = JSON.parse(new TextDecoder().decode(output.stdout)) as {
        unavailable?: boolean;
        stage?: string;
        code?: string;
        view: SavedSystemView;
        tool: { sources: Array<{ content: unknown }> };
        foreignRefused: boolean;
        stateDigest: string;
      };
      assert(
        output.success,
        JSON.stringify({
          exitCode: output.code,
          stage: result.stage,
          code: result.code,
          stderr: new TextDecoder().decode(output.stderr).replaceAll(
            directory,
            "<owned-test-directory>",
          ).slice(0, 2000),
        }),
      );
      assert.equal(result.view.digest, saved.digest);
      assert.deepEqual(result.view.manifest, saved.manifest);
      assert.equal(result.view.assetAvailability, "verified");
      assert.deepEqual(result.tool.sources[0].content, draft);
      assert.equal(result.foreignRefused, true);
      assert.equal(
        result.stateDigest,
        stateDigest,
        "Cold inspection creates no runtime, Case or state revision",
      );
      const currentHead = await new Deno.Command("git", {
        args: [
          "--no-replace-objects",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          `--git-dir=${coldArguments[1]}/.git`,
          "rev-parse",
          "HEAD",
        ],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(currentHead.success, true);
      assert.equal(
        new TextDecoder().decode(currentHead.stdout).trim(),
        advanced.version.slice(7),
        "Cold inspection leaves the later working baseline unchanged",
      );

      assert.equal(tests, 1);
      assert.equal(providerCalls, 0);
      assert.equal(invocations, 0);
      phase = "completed";
      succeeded = true;
    } finally {
      controller?.dispose();
      try {
        coldProcess?.kill("SIGKILL");
      } catch { /* only the owned, already reaped child */ }
      const cleanupIssues: string[] = [];
      try {
        await fixture?.close({ retainDatabase: true });
      } catch {
        cleanupIssues.push("runtime-resource-close-failed");
      }
      let catalogue: Array<
        { id: string; status: string; digest: string | null; revision: number }
      > = [];
      let stateRevisions: Array<{ operatorId: string; revision: string }> = [];
      if ((!succeeded || cleanupIssues.length) && database) {
        try {
          catalogue = await database.client.savedSystem.findMany({
            select: { id: true, status: true, digest: true, revision: true },
          });
          stateRevisions = (await database.client.runtimeState.findMany({
            select: { operatorId: true, revision: true },
          })).map((row) => ({
            operatorId: row.operatorId,
            revision: String(row.revision),
          }));
        } catch {
          cleanupIssues.push("safe-evidence-read-failed");
        }
      }
      // The existing dedicated-DB helper owns schema/pool cleanup even on a
      // failure. Export bounded, nonsecret SQL evidence before dropping it.
      try {
        await database?.close();
      } catch {
        cleanupIssues.push("isolated-database-close-failed");
      }
      if (succeeded && !cleanupIssues.length) {
        try {
          await Deno.remove(directory, { recursive: true });
        } catch {
          cleanupIssues.push("owned-directory-cleanup-failed");
        }
      }
      if (!succeeded || cleanupIssues.length) {
        try {
          await Deno.mkdir(directory, { recursive: true });
          await Deno.writeTextFile(
            `${directory}/qualification-summary.json`,
            JSON.stringify(
              {
                phase,
                succeeded,
                providerCalls,
                tests,
                invocations,
                saved: savedSummary,
                catalogue,
                stateRevisions,
                cleanupIssues,
              },
              null,
              2,
            ),
          );
        } catch {
          cleanupIssues.push("safe-evidence-write-failed");
        }
        console.error(`Saved-system witness evidence retained: ${directory}`);
      }
      if (succeeded && cleanupIssues.length) {
        cleanupFailure = new Error(
          `Saved-system witness cleanup failed: ${cleanupIssues.join(", ")}`,
        );
      }
    }
    // A primary assertion/setup error propagates through finally unchanged.
    // Only an otherwise successful witness reports a cleanup failure here.
    if (cleanupFailure) throw cleanupFailure;
  },
});

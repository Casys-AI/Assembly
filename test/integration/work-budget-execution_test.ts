import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
/** Native source admission → real PostgreSQL journal and cumulative budget.
 * AgentPort is a reply double; no external model provider is contacted. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type { PostgresWorkBudgetStore } from "../../src/adapters/out/postgres/budget-store.ts";
import type { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import type { SourceModel } from "../../src/application/model/source-model.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { ModelContextInformation } from "../../src/application/model/consultation/context-information.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { queryModelRevision } from "../../src/application/model/editing/query-revision.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import {
  openPostgresDatabase,
  postgresTestEnabled,
} from "../support/postgres.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const declaration =
  `part invocationBudget : APEWorkBudget::InvocationBudgetPolicy {
 attribute :>> id = "qualified-budget";
 attribute :>> revision = 1;
 attribute :>> unit = "agent-invocation";
 attribute :>> limit = 2;
 attribute :>> onExhausted = "wait";
 attribute :>> exhaustionRecipient = "local-control";
}`;
Deno.test({
  name: "native budget library alone preserves executable digest and rights",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const source = await loadInitialSources(undefined, { information: false });
    const historical = { ...source };
    delete historical["work-budget.sysml"];
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const compile = async (sources: Record<string, string>) =>
      await validateSourceExecutable({
        ...await compiler.compile(sources),
        version: "budget-proof",
      }, "git:5a313952-a19e-56a6-9de3-bae38a428958");
    const before = await compile(historical), after = await compile(source);
    assert.equal(after.version.digest, before.version.digest);
    assert.deepEqual(after.version.sourceIds, before.version.sourceIds);
    assert.deepEqual(after.mandate, before.mandate);
    assert.deepEqual(after.behaviors, before.behaviors);
    assert.equal(after.workBudgetPolicy, undefined);
    source["configuration.sysml"] = source["configuration.sysml"].replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem { ${declaration}`,
    );
    const bounded = await compile(source);
    assert.notEqual(bounded.version.digest, after.version.digest);
    assert(
      bounded.workBudgetPolicy!.sourceIds.includes(
        bounded.workBudgetPolicy!.elementId,
      ),
    );
    assert(
      bounded.version.sourceIds.includes(bounded.workBudgetPolicy!.elementId),
    );
  },
});
Deno.test({
  name:
    "native adopted budget remains cumulative across publication restart removal and ledger loss",
  ignore: !toolkitIntegrationEnabled || !postgresTestEnabled,
  async fn() {
    const projectId = `git:${crypto.randomUUID()}`;
    const directory = await Deno.makeTempDir({
      prefix: "ase-budget-execution-",
    });
    const database = await openPostgresDatabase();
    let recovery:
      | Awaited<ReturnType<typeof openPostgresDurableRecoveryHost>>
      | undefined;
    let calls = 0;
    let current: {
      service: SystemRuntime;
      store: PostgresSystemStateStore;
      ledger: PostgresWorkBudgetStore;
      model: SourceModel;
      session: Awaited<
        ReturnType<
          Awaited<
            ReturnType<typeof openPostgresDurableRecoveryHost>
          >["openSession"]
        >
      >;
    } | undefined;
    try {
      const sources = await loadInitialSources(undefined, {
        information: false,
      });
      sources["configuration.sysml"] = sources["configuration.sysml"].replace(
        "part liveBuilder : ConversationSystem {",
        `part liveBuilder : ConversationSystem { ${declaration}`,
      );
      const compiler = new ToolkitCompiler({ packageDir: packageDir! });
      const repository = await GitModelRepository.open({
        projectDir: directory,
        compiler: {
          async compile(sources) {
            const result = await compiler.compile(sources);
            await validateSourceExecutable(
              { ...result, version: "gate" },
              projectId,
            );
            return result;
          },
          recipe: () => compiler.recipe(),
        },
      });
      const open = async () => {
        const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
        const model = createSourceModel({
          tooling,
          repository,
          projectId,
          initialSources: sources,
        });
        const identity = await model.initialize();
        recovery ??= await openPostgresDurableRecoveryHost({
          database,
          scope: { projectId, systemId: identity.systemId },
        });
        const session = await recovery.openSession();
        const { state: store, budget: ledger } = await session.storage.operator(
          identity.builderId,
        );
        const forbidden = () => {
          throw new Error("Unexpected tool or review call");
        };
        const service: SystemRuntime = new SystemRuntime({
          ...await session.runtimePortsFor(identity.builderId),
          model,
          store,
          // The admitted conversation now requires source consultation before
          // choosing a move. Exercise the production reader on its exact Git pin.
          information: new ModelContextInformation({
            projectId,
            reader: new ModelContextReader(repository),
            snapshotForCaller: (callerId) =>
              callerId === identity.builderId ? service.snapshot : undefined,
            resolveCallerModel: async (callerId, version) => {
              const admitted = service.snapshot.executionModel;
              if (
                callerId !== identity.builderId ||
                admitted?.version.digest !== version.digest ||
                admitted.version.repositoryVersion !== version.repositoryVersion
              ) return null;
              return await model.readExecutableModel(
                identity,
                version.repositoryVersion,
              );
            },
            readSourceRevision: () => model.readSourceRevision(identity),
            toolingQuery: async (version, expression) =>
              await queryModelRevision(
                tooling,
                await repository.at(version),
                expression,
              ),
          }),
          workBudget: new WorkBudgetService(ledger),
          agents: {
            label: "native-budget-double",
            decide(context) {
              calls++;
              assert(context.workBudget);
              return Promise.resolve({
                kind: "reply",
                text: "Recorded reply.",
              });
            },
            review: forbidden,
          },
          runner: { run: forbidden, test: forbidden },
        });
        try {
          await service.initialize();
          await session.start((delivery) =>
            service.processAcceptedContribution(delivery)
          );
          return { model, store, ledger, service, session };
        } catch (error) {
          await session.stop();
          throw error;
        }
      };
      const close = async () => {
        await current?.session.stop();
        current = undefined;
      };
      current = await open();
      const turn = async (text = "Continue") => {
        await current!.service.submit(text);
        await current!.session.idle(current!.service);
      };
      const initial = current.service.snapshot.executionModel!;
      const dossier = current.service.snapshot.id;
      await turn();
      await turn();
      assert.equal(calls, 2);
      assert.equal(current.service.snapshot.workBudget!.consumed, 2);
      assert.equal(current.service.snapshot.workBudget!.remaining, 0);
      await close();
      current = await open();
      assert.equal(current.service.snapshot.id, dossier);
      assert.equal(current.service.snapshot.workBudget!.consumed, 2);
      const publish = async (configuration: string) => {
        const head = await repository.current();
        const proposal = await repository.propose({
          baseVersion: head.version,
          sources: { ...head.sources, "configuration.sysml": configuration },
          author: "budget-qualification",
          reason: "Qualify explicit source policy adoption.",
        });
        return await repository.accept({
          id: proposal.id,
          expectedVersion: head.version,
          author: "budget-qualification",
        });
      };
      const first = await repository.current();
      const increased = await publish(
        first.sources["configuration.sysml"].replace(
          "revision = 1",
          "revision = 2",
        ).replace("limit = 2", "limit = 3"),
      );
      // Publishing alone leaves the exhausted balance and admitted pin intact.
      assert.equal(current.service.snapshot.workBudget!.remaining, 0);
      assert.equal(calls, 2);
      assert.equal(
        current.service.snapshot.executionModel!.version.digest,
        initial.version.digest,
      );
      const prospective = await current.model.readExecutableModel(
        initial.identity,
      );
      await current.service.adoptModelVersion({
        expectedDigest: prospective.version.digest,
        expectedVersion: increased.version,
      });
      assert.equal(calls, 2);
      assert.equal(current.service.snapshot.workBudget!.consumed, 2);
      await turn("Use the adopted third invocation");
      assert.equal(calls, 3);
      assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      const stable = await repository.current();
      const removal = stable.sources["configuration.sysml"].replace(
        declaration.replace("revision = 1", "revision = 2").replace(
          "limit = 2",
          "limit = 3",
        ),
        "",
      );
      assert.notEqual(removal, stable.sources["configuration.sysml"]);
      for (
        const configuration of [
          removal,
          stable.sources["configuration.sysml"].replace(
            'id = "qualified-budget"',
            'id = "another-budget"',
          ),
        ]
      ) {
        const revision = await publish(configuration);
        const available = await current.model.readExecutableModel(
          initial.identity,
        );
        await assert.rejects(
          () =>
            current!.service.adoptModelVersion({
              expectedDigest: available.version.digest,
              expectedVersion: revision.version,
            }),
          /budget|policy|binding/i,
        );
        assert.equal(calls, 3);
        assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      }
      // Preserve a safe policy-change boundary, then qualify exhaustion and
      // restart through the persisted native checkpoint rather than retired cursors.
      const admitted = current.service.snapshot.executionModel!;
      const unadopted = await publish(
        stable.sources["configuration.sysml"].replace(
          "revision = 2",
          "revision = 3",
        ).replace("limit = 3", "limit = 4"),
      );
      assert.notEqual(unadopted.version, admitted.version.repositoryVersion);
      await turn(
        "Published extra credit must not extend the admitted allowance",
      );
      assert.equal(
        current.service.snapshot.executionModel!.version.repositoryVersion,
        admitted.version.repositoryVersion,
      );
      assert.equal(current.service.snapshot.workBudget!.remaining, 0);
      assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      assert.equal(calls, 3);
      // An unadopted changed source head can refuse before budget admission.
      // Restore the admitted policy source and reopen the worker session after
      // the refused delivery, retaining the dossier and cumulative ledger.
      // No model adoption is attempted during a budget wait.
      await close();
      await publish(stable.sources["configuration.sysml"]);
      current = await open();
      assert.equal(current.service.snapshot.id, dossier);
      assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      assert.equal(
        current.service.snapshot.executionModel!.version.repositoryVersion,
        admitted.version.repositoryVersion,
      );
      await turn("Exhaust the admitted third invocation allowance");
      assert.equal(calls, 3);
      assert.equal(
        current.service.snapshot.budgetSuspension!.reason,
        "exhausted",
      );
      const suspension = current.service.snapshot.budgetSuspension!;
      const suspended = (await current.session.native.execution.inspect(
        initial.identity.builderId,
      )).find((execution) =>
        execution.status === "waiting" && execution.checkpointId &&
        execution.waits.some((wait) =>
          wait.kind === "budget" && wait.nodeId === suspension.nodeId
        )
      );
      assert(suspended);
      await close();
      current = await open();
      assert.equal(current.service.snapshot.id, dossier);
      const restored = (await current.session.native.execution.inspect(
        initial.identity.builderId,
      )).find((execution) => execution.threadId === suspended.threadId);
      assert.equal(restored?.checkpointId, suspended.checkpointId);
      assert.deepEqual(restored?.waits, suspended.waits);
      await turn("Another message after an exhausted restart");
      assert.equal(calls, 3);
      assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      const unsafe = await current.model.readExecutableModel(initial.identity);
      await assert.rejects(() =>
        current!.service.adoptModelVersion({
          expectedDigest: unsafe.version.digest,
          expectedVersion: unsafe.version.repositoryVersion,
        }), { code: "EVOLUTION_BOUNDARY_UNSAFE" });
      await close();
      // Delete only this isolated fixture's ledger, simulating its loss.
      await database.client.workBudget.deleteMany({ where: { projectId } });
      current = await open();
      assert.equal(current.service.snapshot.id, dossier);
      await turn("Missing ledger must not grant fresh credit");
      assert.equal(calls, 3);
      assert(current.service.snapshot.budgetSuspension);
      assert.equal(current.service.snapshot.workBudget!.consumed, 3);
      await close();
    } finally {
      await recovery?.close();
      await database.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

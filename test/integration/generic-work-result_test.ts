/** Native SysML criteria, real PostgreSQL and a file-backed test reader; no ERP integration. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { WorkPlanBehavior } from "../support/work-plan-behavior.ts";
import { openPostgresFixtureHost } from "../support/postgres-runtime-fixture.ts";
import type { PostgresTestDatabase } from "../support/postgres.ts";
import type { WorkPlanStorePort } from "../../src/application/work/plans/ports.ts";
import { WorkPlanExecutor } from "../../src/application/work/plans/executor.ts";
import {
  type ObservationInvocationPort,
  ObservationInvocationRegistry,
  readOnlyObservation,
} from "../../src/application/work/behaviors/observation.ts";
import type { BehaviorInvocationPort } from "../../src/application/work/behaviors/invocation.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type { BehaviorInvocationRequest } from "../../src/domain/work/execution/modeled-behavior.ts";
import type { WorkPlanResultView } from "../../src/application/work/plans/result-view.ts";
import type { WorkResultObservation } from "../../src/domain/work/policies/verified-effect-closure.ts";
import { verifiedBoundRecordSources } from "../support/verified-work-fixture.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "one generic executor binds admitted input through SysML and resumes record verification without repeating effects",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const digests: string[] = [];
    const projectId = `git:${crypto.randomUUID()}`;
    for (const comparison of [">=", "<="] as const) {
      const directory = await Deno.makeTempDir({
        prefix: "ase-generic-result-",
      });
      let store: WorkPlanStorePort | undefined;
      let host: Awaited<ReturnType<typeof openPostgresFixtureHost>> | undefined;
      let database: PostgresTestDatabase | undefined;
      try {
        const sources = await verifiedBoundRecordSources();
        if (comparison === "<=") {
          sources["configuration.sysml"] = sources["configuration.sysml"]!
            .replace(
              "observed.amount >= expected.amount",
              "observed.amount <= expected.amount",
            );
        }
        const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
          .compile(sources);
        const model = await validateSourceExecutable({
          ...compiled,
          version: `fixture:${comparison}`,
        }, projectId);
        const contract = model.workResultContracts![0]!;
        const planner = model.behaviors!.find((entry) =>
          entry.name === "PlanifierTravail"
        )!;
        const work = model.behaviors!.find((entry) =>
          entry.id === contract.workBehaviorId
        )!;
        const read = model.behaviors!.find((entry) =>
          entry.id === contract.observationBehaviorId
        )!;
        const next = model.behaviors!.find((entry) =>
          entry.name === "ConfierAnalyse"
        )!;
        ok(planner && work && read && next);
        equal(contract.valueBindings?.length, 3);
        equal(Object.hasOwn(contract.expected.values, "amount"), false);
        equal(Object.hasOwn(contract.query!.values, "recordId"), false);
        equal(Object.hasOwn(contract.query!.values, "artifactName"), false);
        digests.push(model.version.digest);
        const version = {
          digest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion!,
        };
        const materialInput = {
          recordId: comparison === ">=" ? "record-A" : "record-B",
          status: "paid",
          amount: comparison === ">=" ? 20 : 40,
        };
        const path = join(directory, "record.json");
        let effects = 0, dependents = 0, reads = 0;
        type SourceRecord = {
          id: string;
          callerId: string;
          workInvocationId: string;
          workBehaviorId: string;
          workInputDigest: string;
          modelVersion: typeof version;
          values: { status: string; amount: number };
        };
        const envelope = (
          request: BehaviorInvocationRequest,
          result: unknown,
        ) => ({
          behaviorId: request.behavior.id,
          invocationId: request.invocationId,
          targetNativeId: request.behavior.targetNativeId,
          modelVersion: request.modelVersion,
          result,
        });
        const workInvoker: BehaviorInvocationPort = {
          supports: (behavior) =>
            Promise.resolve([work.id, next.id].includes(behavior.id)),
          async invoke(request) {
            if (request.behavior.id === work.id) {
              effects++;
              const record: SourceRecord = {
                id: request.input.recordId as string,
                callerId: request.callerId,
                workInvocationId: request.invocationId,
                workBehaviorId: request.behavior.id,
                workInputDigest: await executionDigest(request.input),
                modelVersion: request.modelVersion,
                values: {
                  status: request.input.status as string,
                  amount: (request.input.amount as number) + 5,
                },
              };
              await Deno.writeTextFile(path, JSON.stringify(record));
            } else dependents++;
            // The work reply supplies no observation values or verdict.
            return envelope(request, { status: "completed" });
          },
        };
        const reader: ObservationInvocationPort = {
          [readOnlyObservation]: true,
          supports: (behavior, pin) =>
            Promise.resolve(
              behavior.id === read.id && pin.digest === version.digest,
            ),
          async invoke(request) {
            reads++;
            const record = JSON.parse(
              await Deno.readTextFile(path),
            ) as SourceRecord;
            equal(request.input.recordId, record.id);
            const { id, values, ...correlation } = record;
            const result: WorkResultObservation = {
              ...correlation,
              available: true,
              source: { id, revision: await executionDigest(record) },
              values,
            };
            return envelope(request, result);
          },
        };
        const observer = new ObservationInvocationRegistry([reader]);
        const open = async () => {
          host = await openPostgresFixtureHost(database);
          database = host.database;
          await host.storage.registerSystem({
            projectId,
            systemId: "generic-result",
          });
          store = (await host.storage.operator(model.identity.builderId)).plans;
          const executor = new WorkPlanExecutor({
            now: () => "2026-11-03T00:00:00.000Z",
            store,
            invokeTarget: (request) => workInvoker.invoke(request),
            observeTarget: (request) => observer.invoke(request),
          });
          return new WorkPlanBehavior({
            executor,
            resolveCallerModel: () => Promise.resolve(structuredClone(model)),
            planTargetIds: new Set([planner.targetNativeId]),
            planTargetOwners: new Map([[
              planner.targetNativeId,
              model.identity.builderId,
            ]]),
            workTargetIds: new Set([work.targetNativeId, next.targetNativeId]),
            workInvoker,
            observationInvoker: observer,
          });
        };
        const planId = `record-result:${comparison}`;
        const tasksJson = JSON.stringify([
          {
            id: "record",
            behaviorId: work.id,
            input: materialInput,
            dependsOn: [],
          },
          {
            id: "next",
            behaviorId: next.id,
            input: { text: "Continue after verification" },
            dependsOn: ["record"],
          },
        ]);
        const request = (resume = false): BehaviorInvocationRequest => ({
          behavior: planner,
          callerId: model.identity.builderId,
          modelVersion: version,
          invocationId: resume ? `resume:${planId}` : planId,
          input: { tasksJson, ...(resume ? { resume: true, planId } : {}) },
        });
        let runtime = await open();
        const first = (await runtime.invoke(request()))
          .result as WorkPlanResultView;
        const firstRaw = (await store!.load(first.id))!;
        equal(
          firstRaw.tasks[0].resultContract?.expected.values.amount,
          materialInput.amount,
        );
        equal(
          firstRaw.tasks[0].resultContract?.query?.values.recordId,
          materialInput.recordId,
        );
        equal(effects, 1);
        equal(reads, 1);
        equal(first.status, comparison === ">=" ? "completed" : "waiting");
        equal(
          first.tasks[0].verification?.status,
          comparison === ">=" ? "verified" : "contradicted",
        );
        equal(dependents, comparison === ">=" ? 1 : 0);
        const changedTasks = JSON.parse(tasksJson);
        changedTasks[0].input.amount++;
        const alteredResume = request(true);
        alteredResume.input.tasksJson = JSON.stringify(changedTasks);
        await rejects(
          () => runtime.invoke(alteredResume),
          /resume cannot change/,
        );
        equal(effects, 1);
        await host!.close({ retainDatabase: true });
        host = undefined;
        store = undefined;
        if (comparison === "<=") {
          // Independent source update, not a rerun of the original work.
          const changed = JSON.parse(
            await Deno.readTextFile(path),
          ) as SourceRecord;
          changed.values.amount = materialInput.amount - 5;
          await Deno.writeTextFile(path, JSON.stringify(changed));
        }
        runtime = await open();
        const resumed = (await runtime.invoke(request(true)))
          .result as WorkPlanResultView;
        equal(resumed.status, "completed");
        equal(resumed.tasks[0].verification?.status, "verified");
        equal(effects, 1);
        equal(dependents, 1);
        equal(reads, comparison === ">=" ? 1 : 2);
      } finally {
        try {
          await host?.close();
        } finally {
          await database?.close();
        }
        await Deno.remove(directory, { recursive: true });
      }
    }
    ok(
      digests[0] !== digests[1],
      "Changing the native condition must change the execution pin",
    );
  },
});

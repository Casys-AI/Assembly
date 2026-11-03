/** Real native policies, promotion, Git and PostgreSQL; only agent decisions are controlled. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { equal, ok } from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { PostgresTestDatabase } from "../support/postgres.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import { workReceipt } from "../../src/application/work/operators/journal.ts";
import { caseExecutionContext } from "../../src/application/work/cases/runtime.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type { WorkPlanRecord } from "../../src/domain/work/entities/plans.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { verifiedWorkSources } from "../support/verified-work-fixture.ts";

const extraction = String
  .raw`export default ({html}: {url:string;html:string}) => {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  return {title,text};
}`;

Deno.test({
  name:
    "native required artifact gates dependencies and survives restart without repeating completed work",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-verified-result-",
    });
    const sources = await verifiedWorkSources();
    let current: {
      service: SystemRuntime;
      postgres: Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
      registry: BehaviorInvocationRegistry;
      workspace: Awaited<ReturnType<typeof openOperatorWorkspace>>;
    } | undefined;
    let proposed = false;
    let collectorDecisions = 0;
    let analystDecisions = 0;
    const agents: AgentPort = {
      label: "verified-result-controlled-decisions",
      decide(context) {
        if (context.operator?.name === "Collecteur") {
          collectorDecisions++;
          const request = context.messages.findLast((message) =>
            message.work
          )?.text ?? "";
          if (request.includes("Build reader") && !proposed) {
            proposed = true;
            return Promise.resolve({
              kind: "propose_tool",
              text: "Build the requested local artifact.",
              tool: {
                name: "reader",
                description: "Read supplied HTML",
                kind: "read_web_page",
                code: extraction,
              },
            });
          }
        } else if (context.operator?.name === "Analyste") analystDecisions++;
        return Promise.resolve({
          kind: "reply",
          text: "Contribution finished.",
        });
      },
      review() {
        throw new Error(
          "This source fixture delegates local admission without an independent reviewer",
        );
      },
      admit(candidate) {
        return Promise.resolve({
          candidateDigest: candidate.digest,
          verdict: "approve",
          reason: "Exact local fixture admission",
        });
      },
    };
    let database: PostgresTestDatabase | undefined;
    const open = async () => {
      const postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        database,
        ...(database ? {} : { sources }),
      });
      database = postgres.database;
      const model = postgres.backend.model;
      const repository = postgres.repository;
      const store = postgres.primary.state;
      const executors: BehaviorInvocationPort[] = [];
      const registry = new BehaviorInvocationRegistry(executors);
      const service = new SystemRuntime({
        ...postgres.runtimePorts,
        agents,
        model,
        store,
        behaviors: registry,
        runner: new DenoToolRunner(),
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
          tooling: postgres.backend.tooling,
          primary: service,
          primaryModel: model,
          repository,
          agents,
          directory,
          executors,
        });
        await postgres.start(workspace);
        return { service, postgres, registry, workspace };
      } catch (error) {
        await postgres.close();
        throw error;
      }
    };
    const close = async () => {
      await current?.postgres.close({ retainDatabase: true });
      current = undefined;
    };
    try {
      current = await open();
      // Direct registry calls must carry the same explicit scope as a normal turn.
      const caseId = await current.service.submit(
        "Verify required work artifacts and retain completed work after restart.",
        undefined,
        undefined,
        true,
      );
      await current.postgres.idle(current.service);
      ok(caseId);
      const model = current.service.snapshot.executionModel!;
      equal(model.workResultContracts?.length, 1);
      const planner = model.behaviors!.find((entry) =>
        entry.name === "PlanifierTravail"
      )!;
      const collector = model.behaviors!.find((entry) =>
        entry.name === "ConfierCollecte"
      )!;
      const analyst = model.behaviors!.find((entry) =>
        entry.name === "ConfierAnalyse"
      )!;
      ok(planner && collector && analyst);
      const input = (text: string) => ({
        tasksJson: JSON.stringify([
          {
            id: "produce",
            behaviorId: collector.id,
            input: { text },
            dependsOn: [],
          },
          {
            id: "consume",
            behaviorId: analyst.id,
            input: { text: "Use the verified artifact" },
            dependsOn: ["produce"],
          },
        ]),
      });
      const request = (id: string, fields: Record<string, unknown>) => {
        const caseContext = caseExecutionContext(current!.service.snapshot);
        ok(caseContext);
        equal(caseContext.caseId, caseId);
        return {
          caseId,
          caseContext,
          behavior: planner,
          callerId: model.identity.builderId,
          invocationId: id,
          modelVersion: {
            digest: model.version.digest,
            repositoryVersion: model.version.repositoryVersion!,
          },
          input: fields,
        };
      };
      const emptyInput = input(
        "Finish the contribution without producing an artifact",
      );
      const empty =
        (await current.registry.invoke(request("missing-result", emptyInput)))
          .result as WorkPlanRecord;
      equal(
        empty.tasks[0].state,
        "completed",
        JSON.stringify(empty.tasks[0].error),
      );
      equal(empty.tasks[0].resultVerification?.status, "contradicted");
      equal(empty.tasks[1].state, "pending");
      equal(empty.status, "waiting");
      equal(analystDecisions, 0);
      console.info(
        "Verified-result fixture: technical completion did not release its dependency.",
      );

      // Whitespace is preserved in the exact admitted digest even though display text is trimmed.
      const text = "  Build reader and publish its exact admitted bytes.\n";
      const goodInput = input(text);
      const complete =
        (await current.registry.invoke(request("verified-result", goodInput)))
          .result as WorkPlanRecord;
      const worker = current.workspace.conversations.snapshot.conversations
        .find((unit) => unit.name === "Collecteur")!;
      const runtime = current.workspace.runtimeFor(worker.agentId)!.runtime;
      const durable = await runtime.readPersistedState();
      ok(durable);
      equal(
        complete.status,
        "completed",
        JSON.stringify({
          status: complete.status,
          verification: complete.tasks[0].resultVerification,
          tests: durable.candidates.map((candidate) => candidate.tests),
        }),
      );
      equal(complete.tasks[0].resultVerification?.status, "verified");
      equal(complete.tasks[0].resultVerification?.attempts, 1);
      equal(complete.tasks[1].state, "completed");
      equal(analystDecisions, 1);
      const message = durable.messages.find((message) =>
        workReceipt(message)?.invocationId ===
          complete.tasks[0].invocation.invocationId
      )!;
      equal(workReceipt(message)?.inputDigest, await executionDigest({ text }));
      equal(message.text, text.trim());
      const active = durable.candidates.find((candidate) =>
        candidate.name === "reader" && candidate.stage === "active"
      );
      ok(active, JSON.stringify(durable.candidates));
      ok(active.tests?.passed);
      console.info(
        "Verified-result fixture: native publication verified and dependent work released.",
      );

      // A later artifact from another work cannot satisfy the first plan's obligation.
      const attemptsBefore = collectorDecisions;
      const stillMissing = (await current.registry.invoke(
        request("resume-missing", {
          ...emptyInput,
          resume: true,
          planId: empty.id,
        }),
      )).result as WorkPlanRecord;
      equal(stillMissing.status, "waiting");
      equal(stillMissing.tasks[0].resultVerification?.status, "exhausted");
      equal(
        stillMissing.tasks[0].resultVerification?.observations.at(-1)?.status,
        "contradicted",
      );
      equal(stillMissing.tasks[1].state, "pending");
      equal(collectorDecisions, attemptsBefore);
      equal(analystDecisions, 1);
      console.info(
        "Verified-result fixture: another work's artifact did not satisfy the missing result.",
      );

      await close();
      current = await open();
      const replay = (await current.registry.invoke(
        request("resume-complete", {
          ...goodInput,
          resume: true,
          planId: complete.id,
        }),
      )).result as WorkPlanRecord;
      equal(replay.status, "completed");
      equal(replay.tasks[0].resultVerification?.status, "verified");
      equal(replay.tasks[0].resultVerification?.attempts, 1);
      equal(collectorDecisions, attemptsBefore);
      equal(analystDecisions, 1);
      console.info(
        "Verified-result fixture: restart retained verification without repeating work.",
      );
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

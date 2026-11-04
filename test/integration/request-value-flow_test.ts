import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
/** Deterministic provider; real source, grants, queue, plan and sandbox. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { postgresTestEnabled } from "../support/postgres.ts";
import {
  currentCandidateInspection,
  recordedFeedback,
  recordedToolPages,
} from "../fixtures/request-value-attribution.ts";
import { openRequestValueRuntime } from "../fixtures/request-value-runtime.ts";
import {
  openRequestValueFixture,
  requestValueObjective,
  requestValueUrls,
} from "../fixtures/request-value-profile.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { caseTypesForModel } from "../../src/domain/work/records/case-types.ts";
import { designerScopeId } from "../../src/application/work/cases/runtime.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import {
  type MainCandidateInspection,
  OperatorConversationError,
} from "../../src/application/work/operators/conversations.ts";
import { recordedOperatorWork } from "../../src/application/work/operators/journal.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  WORK_PLAN_RESULT_FORMAT,
  type WorkPlanResultView,
} from "../../src/application/work/plans/result-view.ts";

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
    "one Request coordinates two admitted extractors through Main and a closed plan",
  ignore: !toolkitIntegrationEnabled || !postgresTestEnabled,
  async fn() {
    const progressEnabled =
      Deno.env.get("ASSEMBLY_REQUEST_VALUE_PROGRESS") === "1";
    const progress = (step: string, actor?: string, callKinds?: string[]) => {
      if (progressEnabled) {
        console.log(
          "Value-flow progress: " + JSON.stringify({
            at: new Date().toISOString(),
            step,
            actor,
            callKinds,
          }),
        );
      }
    };
    const originalFetch = globalThis.fetch;
    const originalTest = DenoToolRunner.prototype.test;
    const testStarts: string[] = [];
    const testReturns: string[] = [];
    let activeTests = 0, maxActiveTests = 0;
    let releaseFirst!: () => void;
    const secondTestFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markSecondStarted!: () => void;
    const secondTestStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const within = (event: Promise<void>, ms: number, message: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        event.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    DenoToolRunner.prototype.test = async function (draft) {
      const position = testStarts.push(draft.name);
      if (position === 2) markSecondStarted();
      activeTests++;
      maxActiveTests = Math.max(maxActiveTests, activeTests);
      let report;
      try {
        report = await originalTest.call(this, draft);
        // The first sandbox stays in flight until the second starts, within a
        // bound: the overlap then proves only that the code runs both tests
        // at once, whatever the load staggers before them (each step's model
        // reads). A path that serialized them would let the bound expire.
        if (position === 1) {
          await within(
            secondTestStarted,
            60_000,
            "Second sandbox test did not start while the first was in flight",
          );
        }
      } finally {
        activeTests--;
        if (position === 2) releaseFirst();
      }
      if (position === 1) {
        await within(
          secondTestFinished,
          30_000,
          "Second sandbox test did not finish",
        );
      }
      testReturns.push(draft.name);
      return report;
    };
    const fetched: string[] = [];
    globalThis.fetch = (input) => {
      const url = String(input);
      assert(
        requestValueUrls.includes(url as typeof requestValueUrls[number]),
        `Unexpected network ${url}`,
      );
      fetched.push(url);
      const index = requestValueUrls.indexOf(
        url as typeof requestValueUrls[number],
      );
      const fact = index === 0
        ? "Fixture security denies access by default."
        : "Fixture permissions require explicit network grants.";
      return Promise.resolve(
        new Response(
          `<html><head><title>Deno fixture ${index}</title></head><body><p>${fact}</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      );
    };
    const contexts: ChatContext[] = [];
    const preparationContexts: ChatContext[] = [];
    const workerSteps = new Map<string, number>();
    let ownerStep = 0;
    let phase = 0;
    let prepareArrivals = 0;
    let releasePreparation!: () => void;
    let rejectPreparation!: (error: Error) => void;
    let preparationTimer: ReturnType<typeof setTimeout> | undefined;
    const preparationBarrier = new Promise<void>((resolve, reject) => {
      releasePreparation = resolve;
      rejectPreparation = reject;
    });
    let tasksJson = "";
    let preparationPlan: WorkPlanResultView | undefined;
    const decided = new Set<string>();
    const inspected = new Set<string>();
    const inspectionCandidates = new Map<string, string>();
    const processedMainFeedback = new Set<string>();
    const pendingDecisions = new Map<
      string,
      "decide_operator_change" | "decide_operator_candidate"
    >();
    const candidateBatches: ChatDecision[][] = [];
    let mainClosedTurns = 0;
    let requestReplyReady = false;
    const completedReplays: Array<
      { name: string; quiet: boolean; violations: unknown[] }
    > = [];
    let callSequence = 0;
    /** The main Request Main opened (an explicit fixture, never an
     * `open_request` decision), as Main discovers it in its own context.
     * Main never resumes it while it runs: its plan resumes on its own
     * contributors' receipts. */
    const mainRoot = (context: ChatContext) =>
      context.requestOpening?.mainRequests?.find((entry) =>
        entry.caseId === "operator-request:value-root"
      );
    const provider: AgentPort = {
      label: "scripted-request-value",
      async decideBatch(context) {
        const first = await this.decide(context);
        let decisions = [first];
        if (first.kind === "inspect_operator_candidate") {
          const candidates = context.operatorToolAdmission!.candidates;
          assert.equal(
            candidates.length,
            2,
            "Inspect both pending operators together",
          );
          decisions = candidates.map((candidate) => {
            inspected.add(candidate.candidateId);
            return {
              kind: "inspect_operator_candidate",
              text: "Inspect both exact candidates in one native response",
              operatorId: candidate.operatorId,
              candidateId: candidate.candidateId,
              candidateDigest: candidate.candidateDigest,
              expectedRevision: candidate.expectedRevision,
              caseId: candidate.caseId,
              policyId: candidate.policyId,
              policyRevision: candidate.policyRevision,
            };
          });
          candidateBatches.push(structuredClone(decisions));
        } else if (first.kind === "decide_operator_candidate") {
          const exact = context.messages.flatMap((message) => {
            if (message.observation?.kind !== "candidate-inspection") return [];
            const value = message.observation.value as MainCandidateInspection;
            return value.decisionReference && !decided.has(value.candidate.id)
              ? [value]
              : [];
          });
          assert.equal(
            exact.length,
            2,
            "Both exact inspections must reach the same provider decision",
          );
          assert.deepEqual(
            new Set(
              exact.map((inspection) =>
                inspection.decisionReference.operatorId
              ),
            ),
            new Set(
              context.operatorToolAdmission!.candidates.map((candidate) =>
                candidate.operatorId
              ),
            ),
            "Delivered inspections cover both still-pending recipients",
          );
          decisions = exact.map((inspection) => {
            const pending = context.operatorToolAdmission!.candidates.find((
              candidate,
            ) => candidate.candidateId === inspection.candidate.id)!;
            assert(
              pending,
              "An exact delivered inspection still belongs to an eligible candidate",
            );
            const { name: _name, kind: _kind, ...reference } = pending;
            assert.deepEqual(inspection.decisionReference, reference);
            pendingDecisions.set(
              inspection.candidate.id,
              "decide_operator_candidate",
            );
            return {
              kind: "decide_operator_candidate",
              text: "Admit both inspected exact candidates in inspection order",
              ...inspection.decisionReference,
              verdict: "approve",
              reason: "Exact code and sandbox evidence inspected.",
            };
          });
          candidateBatches.push(structuredClone(decisions));
        }
        progress(
          "decide-batch",
          context.operator?.nativeId,
          decisions.map((decision) => decision.kind),
        );
        return {
          calls: decisions.map((decision) => ({
            id: `request-value-call-${++callSequence}`,
            decision,
          })),
        };
      },
      decide(context): Promise<ChatDecision> {
        contexts.push(structuredClone(context));
        const name = context.operator!.name;
        if (name === "Main Operator") {
          for (const message of context.messages) {
            const prefixes = [
              "Request continuation result;",
              "Delegated decision result;",
              "Exact operator candidate inspection.",
            ];
            const prefix = prefixes.find((item) =>
              message.text.startsWith(item)
            );
            if (!prefix || processedMainFeedback.has(message.id)) continue;
            processedMainFeedback.add(message.id);
            const result = recordedFeedback(
              message,
              prefix === "Exact operator candidate inspection."
                ? "candidate-inspection"
                : "__text_only__",
              prefix,
            ) as
              | {
                status?: string;
                code?: string;
                details?: string;
                message?: string;
                value?: {
                  kind?: string;
                  changeId?: string;
                  candidateId?: string;
                };
              }
              | undefined;
            assert(result, `Malformed host feedback: ${prefix}`);
            if (prefix === "Exact operator candidate inspection.") {
              const exact = result as unknown as MainCandidateInspection;
              assert(
                exact.candidate?.id && exact.candidate.digest &&
                  exact.candidate.code && exact.candidate.tests?.passed &&
                  exact.contract && exact.authorityExercise &&
                  exact.decisionReference,
                "Projected inspection must retain exact code, tests, contract and decision reference",
              );
              assert.equal(
                exact.decisionReference.operatorId,
                exact.operatorId,
              );
              assert.equal(
                exact.decisionReference.candidateId,
                exact.candidate.id,
              );
              assert.equal(
                exact.decisionReference.candidateDigest,
                exact.candidate.digest,
              );
              assert.equal(
                exact.decisionReference.caseId,
                exact.candidate.caseId,
              );
              assert.equal(
                exact.decisionReference.policyId,
                "request-value-tools",
              );
              assert.equal(exact.decisionReference.policyRevision, 1);
              assert(
                Number.isSafeInteger(exact.decisionReference.expectedRevision),
              );
              inspectionCandidates.set(message.id, exact.candidate.id);
            }
            assert.notEqual(
              result.status,
              "refused",
              `${prefix} ${result.code ?? "unknown"}: ${
                result.details ?? result.message ?? "refused"
              }`,
            );
            if (prefix === "Delegated decision result;") {
              const decisionId = result.value?.changeId ??
                result.value?.candidateId;
              assert(
                decisionId && pendingDecisions.has(decisionId),
                "A delegated result must match an issued decision",
              );
              assert.equal(result.status, "succeeded");
              assert.equal(
                result.value?.kind,
                pendingDecisions.get(decisionId),
              );
              decided.add(decisionId);
              pendingDecisions.delete(decisionId);
            }
          }
          assert(
            pendingDecisions.size === 0,
            "The issued decision must have a recorded result before continuing",
          );
          const request = context.operatorAuthority?.requests.find((item) =>
            !decided.has(item.id)
          );
          if (request) {
            pendingDecisions.set(request.id, "decide_operator_change");
            assert(request.requestedBy);
            return Promise.resolve({
              kind: "decide_operator_change",
              text: "Decide the bounded host request",
              operatorId: request.requestedBy,
              changeId: request.id,
              expectedRevision: request.baseRevision,
              policyId: "request-value-network",
              policyRevision: 1,
              verdict: "approve",
            });
          }
          const value = currentCandidateInspection(
            context.messages,
            decided,
            inspectionCandidates,
          );
          if (value) {
            pendingDecisions.set(
              value.candidate.id,
              "decide_operator_candidate",
            );
            return Promise.resolve({
              kind: "decide_operator_candidate",
              text: "Admit exact inspected candidate",
              ...value.decisionReference,
              verdict: "approve",
              reason: "Exact code and sandbox evidence inspected.",
            });
          }
          const candidate = context.operatorToolAdmission?.candidates.find((
            item,
          ) => !inspected.has(item.candidateId));
          if (candidate) {
            inspected.add(candidate.candidateId);
            return Promise.resolve({
              kind: "inspect_operator_candidate",
              text: "Inspect the exact candidate",
              operatorId: candidate.operatorId,
              candidateId: candidate.candidateId,
              candidateDigest: candidate.candidateDigest,
              expectedRevision: candidate.expectedRevision,
              caseId: candidate.caseId,
              policyId: candidate.policyId,
              policyRevision: candidate.policyRevision,
            });
          }
          const root = mainRoot(context);
          assert(root, "The originating Request must be discoverable");
          if (root.status === "closed-done") {
            const notice = context.messages.findLast((message) =>
              message.operatorNotice?.kind === "request-completed" &&
              message.operatorNotice.caseId === root.caseId
            )?.operatorNotice;
            const observed = notice?.kind === "request-completed"
              ? notice.result
              : context.messages.findLast((message) =>
                message.text.startsWith("Request continuation result;")
              )?.text;
            assert(observed, "Main must return an observed result");
            mainClosedTurns++;
            return Promise.resolve({ kind: "reply", text: observed });
          }
          // Nothing designates Main and the Request is running: Main never
          // resumes a Request in progress.
          return Promise.resolve({
            kind: "reply",
            text: "No decision awaits Main; the Request is running.",
          });
        }
        if (name === "Research owner") {
          const planner = context.modeledBehaviors!.find((entry) =>
            entry.name === "Execute plan"
          )!;
          const targets = context.modeledBehaviors!.filter((entry) =>
            ["permissions contribution", "constraints contribution"].includes(
              entry.name,
            )
          );
          assert.equal(targets.length, 2);
          const createPlan = () => {
            tasksJson = JSON.stringify(targets.map((target, index) => ({
              id: `${phase}-${target.name}`,
              behaviorId: target.id,
              input: {
                text: `${
                  [
                    "Request the assigned network host and wait",
                    "Prepare the candidate and wait for admission",
                    "Read your assigned page and report actual content",
                  ][phase]
                }: ${
                  target.name === "permissions contribution"
                    ? requestValueUrls[0]
                    : requestValueUrls[1]
                }`,
              },
              dependsOn: phase === 0 && index > 0
                ? [`${phase}-${targets[index - 1]!.name}`]
                : [],
            })));
            return {
              kind: "invoke_behavior" as const,
              text: "Submit both independent contributions",
              behaviorId: planner.id,
              inputJson: JSON.stringify({ tasksJson }),
            };
          };
          if (ownerStep++ === 0) return Promise.resolve(createPlan());
          const message = context.messages.findLast((item) =>
            recordedFeedback(
              item,
              "behavior-result",
              "Résultat observé du comportement ",
            ) !== undefined
          );
          const result = message
            ? recordedFeedback(
              message,
              "behavior-result",
              "Résultat observé du comportement ",
            ) as { result?: WorkPlanResultView }
            : undefined;
          const plan = result?.result;
          assert(plan, "The native plan result must be observed");
          assert.equal(plan.format, WORK_PLAN_RESULT_FORMAT);
          assert.deepEqual(
            plan.graph,
            JSON.parse(tasksJson),
            "Transport keeps the complete exact resume graph",
          );
          if (plan.status === "completed") {
            if (phase === 1) preparationPlan = structuredClone(plan);
            if (phase < 2) {
              phase++;
              return Promise.resolve(createPlan());
            }
            // The closing reply leads with the observed page texts: Main reads
            // it through the request-completed notice, bounded at 1000
            // characters, while the full outputs follow for the record.
            const observed = plan.tasks.flatMap((task) => task.outputs)
              .filter((output) => output.kind === "tool-source")
              .map((output) => (output.value as { text: string }).text);
            requestReplyReady = true;
            return Promise.resolve({
              kind: "reply",
              text: observed.join(" ") + " " +
                JSON.stringify(plan.tasks.map((task) => task.outputs)) +
                " Assembly generated-tool code executes without local-file permission; Deno service permissions are a separate scope.",
            });
          }
          assert.equal(plan.status, "waiting");
          const last = context.messages.at(-1);
          if (
            last?.role === "tool" &&
            last.text.includes("Resume the same closed plan")
          ) {
            return Promise.resolve({
              kind: "invoke_behavior",
              text: "Resume the recorded plan",
              behaviorId: planner.id,
              inputJson: JSON.stringify({
                tasksJson: JSON.stringify(plan.graph),
                resume: true,
                planId: plan.id,
              }),
            });
          }
          return Promise.resolve({
            kind: "reply",
            text: "The closed plan is waiting for its recorded decisions.",
          });
        }
        const index = name === "Permissions operator" ? 0 : 1;
        const step = workerSteps.get(name) ?? 0;
        workerSteps.set(name, step + 1);
        if (step === 0) {
          return Promise.resolve({
            kind: "propose_mandate_change",
            text: "Request the documentation host",
            reason: "Read the assigned page",
            requestedRights: { addNetworkHosts: ["docs.deno.com"] },
          });
        }
        if (step === 1) {
          return Promise.resolve({
            kind: "reply",
            text: "The network decision has been recorded.",
          });
        }
        if (step === 2) {
          assert(context.case, "Preparation must retain the root Request");
          preparationContexts.push(structuredClone(context));
          if (++prepareArrivals === 1) {
            preparationTimer = setTimeout(
              () =>
                rejectPreparation(
                  new Error("Candidate preparation did not start in parallel"),
                ),
              10_000,
            );
          } else {
            clearTimeout(preparationTimer);
            releasePreparation();
          }
          return preparationBarrier.then(() => ({
            kind: "propose_tool",
            text: "Prepare the extractor",
            tool: {
              name: `request_value_reader_${index}`,
              description: `Extract contribution ${index}`,
              kind: "read_web_page",
              code: extraction + `\n// operator ${index}`,
            },
          }));
        }
        if (step === 3) {
          return Promise.resolve({
            kind: "reply",
            text: "The candidate decision has been recorded.",
          });
        }
        const tool = context.activeTools.find((item) =>
          item.name === `request_value_reader_${index}`
        )!;
        assert(tool);
        if (step === 4) {
          return Promise.resolve({
            kind: "invoke_tool",
            text: "Verify an outside host is refused",
            toolId: tool.id,
            input: { url: "https://outside.example/forbidden" },
          });
        }
        if (step === 5) {
          assert(
            context.lastToolFailure,
            "Outside host must be refused before any effect",
          );
          return Promise.resolve({
            kind: "invoke_tool",
            text: "Read the admitted source",
            toolId: tool.id,
            input: { url: requestValueUrls[index]! },
          });
        }
        const result = recordedToolPages(context.messages).findLast((page) =>
          page.url === requestValueUrls[index]
        );
        assert(result, "An actual tool result is required");
        return Promise.resolve({ kind: "reply", text: JSON.stringify(result) });
      },
      review() {
        throw new Error("No independent reviewer is configured");
      },
    };
    let runtime:
      | Awaited<ReturnType<typeof openRequestValueRuntime>>
      | undefined;
    let scratch: string | undefined;
    let fixture:
      | Awaited<ReturnType<typeof openRequestValueFixture>>
      | undefined;
    let success = false;
    try {
      scratch = await Deno.makeTempDir({
        prefix: "assembly-value-flow-debug-",
      });
      console.log(`Value-flow scratch: ${scratch}`);
      fixture = await openRequestValueFixture(
        Deno.env.get("SYSML_TOOLKIT_DIR")!,
        scratch,
      );
      runtime = await openRequestValueRuntime(
        Deno.env.get("SYSML_TOOLKIT_DIR")!,
        provider,
        fixture,
      );
      // Idempotence where it happens: a closed plan resumed by a child's
      // completion re-invokes that settled task and must read back its
      // recorded receipt as is, with no agent call, HTTP effect, message or
      // budget. Target-bound effects are checked on every replay; the shared
      // Request budget on replays during which no other agent was called.
      const conversations = runtime.workspace.conversations;
      const dispatchWork = conversations.submitWork.bind(conversations);
      const consumed = async () =>
        budgetState(
          (await runtime!.budgets.load(
            runtime!.workspace.runtimeFor(runtime!.owner.agentId)!.runtime
              .cases.cases[0]!.budget!.scopeId,
          ))!,
        ).view.consumed;
      conversations.submitWork = async (
        agentId,
        text,
        correlationId,
        proof,
      ) => {
        const target = runtime!.workspace.runtimeFor(agentId)!.runtime;
        const recorded = recordedOperatorWork(
          target.snapshot,
          agentId,
          proof.callerId,
          correlationId,
        );
        if (!recorded?.settled || recorded.result.status !== "completed") {
          return await dispatchWork(agentId, text, correlationId, proof);
        }
        const name = agentId === runtime!.peers[0]!.agentId
          ? "Permissions operator"
          : "Constraints operator";
        const url = requestValueUrls[name === "Permissions operator" ? 0 : 1];
        const targetCalls = () =>
          contexts.filter((context) => context.operator?.name === name).length;
        const before = {
          calls: contexts.length,
          targetCalls: targetCalls(),
          fetched: fetched.filter((item) => item === url).length,
          messages: target.snapshot.messages.length,
          consumed: await consumed(),
        };
        const replayed = await dispatchWork(
          agentId,
          text,
          correlationId,
          proof,
        );
        const quiet = contexts.length === before.calls;
        const violations = [
          canonical(replayed) !== canonical(recorded.result) &&
          "receipt",
          targetCalls() !== before.targetCalls && "agent call",
          fetched.filter((item) => item === url).length !== before.fetched &&
          "HTTP effect",
          target.snapshot.messages.length !== before.messages && "message",
          quiet && await consumed() !== before.consumed && "budget",
        ].filter(Boolean);
        completedReplays.push({ name, quiet, violations });
        return replayed;
      };
      // Main no longer opens a Request in main (4.8d D3): the owner's Request
      // is an explicit host fixture opened from Main's design conversation.
      const ownerRuntime =
        runtime.workspace.runtimeFor(runtime.owner.agentId)!.runtime;
      const ownerModel = ownerRuntime.snapshot.executionModel!;
      await ownerRuntime.openOperatorRequest({
        changeId: "value-root",
        caseTypeId: caseTypesForModel(ownerModel).find((type) =>
          type.type === "request" &&
          type.ownerId === ownerModel.identity.builderId
        )!.id,
        objective: requestValueObjective,
        openedBy: runtime.mainId,
        openedFrom: {
          conversationId: runtime.primary.snapshot.id,
          designerScopeId: designerScopeId(runtime.primary.snapshot),
        },
      });
      // The Request runs on its own plan, never resumed by Main: under load
      // its plans outlast the fixture's ten-minute default drain, so each
      // drain is bounded by the run budget instead.
      const drainMs = 1_800_000;
      await runtime.workspace.conversations.idle();
      await runtime.postgres.idle(undefined, drainMs);
      const settle = async () => {
        await runtime!.workspace.conversations.idle();
        await runtime!.postgres.idle(undefined, drainMs);
        assert.equal(runtime!.primary.snapshot.error, undefined);
      };
      const speakToMain = async (text: string) => {
        await runtime!.workspace.conversations.submitHuman({
          agentId: runtime!.mainId,
          expectedRevision: runtime!.primary.snapshot.revision,
          text,
        });
        await settle();
      };
      await speakToMain(
        requestValueObjective +
          " Close the Request when both sourced contributions are complete.",
      );
      // The Request runs on its own plan, resumed by its contributors'
      // receipts. Main is woken only when a network request designates it;
      // the candidates wait for its next turn, which the person gives it.
      // Main never resumes the running Request.
      const owner =
        runtime.workspace.runtimeFor(runtime.owner.agentId)!.runtime;
      const awaitingMain = () =>
        runtime!.peers.some((peer) =>
          runtime!.workspace.runtimeFor(peer.agentId)!.runtime.snapshot
            .candidates.some((candidate) =>
              candidate.stage === "awaiting-admission"
            )
        );
      for (
        let round = 0;
        !requestReplyReady;
        round++
      ) {
        assert(round < 3, "Request did not converge within the bounded driver");
        assert(
          awaitingMain(),
          "A settled running Request waits only for Main's candidate decisions",
        );
        await speakToMain("Decide the operator candidates awaiting you.");
      }
      await owner.closeCase(
        owner.cases.cases[0]!.id,
        "done",
        ACCEPTED_CASE_CLOSURE,
      );
      await settle();
      // The completion is journalled in Main's design conversation without a
      // turn: Main reads it when the person speaks to it again.
      const completion = runtime.primary.snapshot.messages.filter((message) =>
        message.operatorNotice?.kind === "request-completed" &&
        message.operatorNotice.caseId === owner.cases.cases[0]!.id
      );
      assert.equal(completion.length, 1);
      assert.equal(completion[0]!.noticeWake, undefined);
      assert.equal(mainClosedTurns, 0, "The completion starts no Main turn");
      await speakToMain("Report the Request's observed result.");
      assert.equal(mainClosedTurns, 1);
      assert.equal(candidateBatches.length, 2);
      assert.deepEqual(
        candidateBatches.map((batch) => batch.map((call) => call.kind)),
        [
          ["inspect_operator_candidate", "inspect_operator_candidate"],
          ["decide_operator_candidate", "decide_operator_candidate"],
        ],
      );
      assert.deepEqual(
        candidateBatches[1]!.map((decision) =>
          (decision as Extract<
            ChatDecision,
            { kind: "decide_operator_candidate" }
          >).candidateId
        ),
        candidateBatches[0]!.map((decision) =>
          (decision as Extract<
            ChatDecision,
            { kind: "inspect_operator_candidate" }
          >).candidateId
        ),
        "Decide A then B after inspecting A then B",
      );
      assert.equal(owner.cases.cases.length, 1);
      assert.equal(owner.cases.cases[0]!.status, "closed-done");
      assert.deepEqual(new Set(fetched), new Set(requestValueUrls));
      assert.equal(prepareArrivals, 2, "Both preparations started together");
      assert.equal(testStarts.length, 2);
      assert.equal(
        maxActiveTests,
        2,
        "Real candidate sandbox tests must overlap",
      );
      assert.deepEqual(
        testReturns,
        [...testStarts].reverse(),
        "Sandbox results return out of order",
      );
      assert(preparationPlan && preparationPlan.status === "completed");
      assert.equal(preparationPlan.caseId, owner.cases.cases[0]!.id);
      assert.equal(preparationPlan.tasks.length, 2);
      for (const task of preparationPlan.tasks) {
        assert(task.contribution);
        assert.equal(task.contribution.invocationId, task.invocationId);
        assert.equal(
          preparationPlan.graph.find((node) => node.id === task.id)!.behaviorId,
          task.behaviorId,
        );
        assert.equal(task.caseId, owner.cases.cases[0]!.id);
      }
      assert(
        preparationContexts.every((context) =>
          context.case?.id === owner.cases.cases[0]!.id
        ),
      );
      assert.equal(
        new Set(
          preparationContexts.map((context) => context.workBudget?.scopeId),
        ).size,
        1,
      );
      const correlations = preparationContexts.map((context) =>
        context.messages.findLast((message) => message.work)?.work
          ?.correlationId
      );
      assert(correlations.every(Boolean));
      assert.equal(new Set(correlations).size, 2);
      assert.equal(fetched.length, 2);
      // Main never resumed the running Request.
      assert.equal(
        owner.snapshot.messages.filter((message) =>
          message.id.includes(":resume:")
        ).length,
        0,
      );
      // Idempotence: every closed-plan re-invocation of a settled task read
      // back its receipt as is, without effect. Phase 0's last completion is
      // Permissions' (it depends on Constraints), replayed while no other
      // agent runs, so the shared budget is checked there too.
      assert.deepEqual(
        completedReplays.flatMap((replay) =>
          replay.violations.map((violation) => `${replay.name}: ${violation}`)
        ),
        [],
      );
      assert(
        completedReplays.some((replay) =>
          replay.name === "Permissions operator" && replay.quiet
        ),
        "A replay of Permissions' settled task runs while no other agent does",
      );
      // After closure, replaying the Permissions read task is refused at the
      // caller's closed context: no agent call, HTTP effect, message or budget.
      const reader = runtime.workspace.runtimeFor(runtime.peers[0]!.agentId)!
        .runtime;
      const readWork = reader.snapshot.messages.findLast((message) =>
        message.work
      )!;
      const receipt = readWork
        .work as import("../../src/domain/work/execution/case-context.ts").OperatorWorkReceipt;
      const budgetBefore = budgetState(
        (await runtime.budgets.load(owner.cases.cases[0]!.budget!.scopeId))!,
      ).view.consumed;
      const callsBefore = contexts.length,
        messagesBefore = reader.snapshot.messages.length;
      await assert.rejects(
        () =>
          runtime!.workspace.conversations.submitWork(
            runtime!.peers[0]!.agentId,
            readWork.text,
            receipt.correlationId,
            {
              callerId: receipt.callerId,
              behavior: owner.snapshot.executionModel!.behaviors!.find((
                entry,
              ) => entry.id === receipt.behaviorId)!,
              modelVersion: receipt.modelVersion,
              invocationId: receipt.invocationId,
              caseId: receipt.caseId,
              caseContext: receipt.caseContext,
            },
          ),
        (error: unknown) =>
          error instanceof OperatorConversationError &&
          error.code === "WORK_CASE_MISMATCH",
      );
      await settle();
      assert.equal(contexts.length, callsBefore);
      assert.equal(
        fetched.length,
        2,
        "A refused replay must not repeat HTTP effects",
      );
      assert.equal(reader.snapshot.messages.length, messagesBefore);
      assert.equal(
        budgetState(
          (await runtime.budgets.load(owner.cases.cases[0]!.budget!.scopeId))!,
        ).view.consumed,
        budgetBefore,
        "A refused replay cannot consume the Request budget",
      );
      assert.equal(
        runtime.primary.cases.cases.length,
        0,
        "Main remains in the designer conversation",
      );
      const mainReply = runtime.primary.snapshot.messages.findLast((message) =>
        message.role === "assistant"
      )?.text ?? "";
      assert(mainReply.includes("Fixture security denies access by default"));
      assert(
        mainReply.includes(
          "Fixture permissions require explicit network grants",
        ),
      );
      const reply = owner.snapshot.messages.findLast((message) =>
        message.role === "assistant"
      )?.text ?? "";
      assert(reply.includes("Fixture security denies access by default"));
      assert(
        reply.includes("Fixture permissions require explicit network grants"),
      );
      const digests = new Set<string>();
      for (const peer of runtime.peers) {
        const state:
          import("../../src/domain/work/dialogue.ts").SystemRuntimeState =
            runtime.workspace.runtimeFor(peer.agentId)!.runtime.snapshot;
        assert.equal(
          state.candidates.filter((candidate) =>
            candidate.stage === "active"
          )
            .length,
          1,
        );
        const candidate = state.candidates.find((item) =>
          item.stage === "active"
        )!;
        assert(
          candidate.tests?.passed &&
            candidate.tests.checks.every((check) => check.passed),
        );
        assert.equal(candidate.admission?.authority, "delegate");
        assert.equal(candidate.admission?.actorId, runtime.mainId);
        assert.equal(candidate.admission?.candidateDigest, candidate.digest);
        assert.equal(
          candidate.admission?.authorityExercise?.candidateDelegation?.policyId,
          "request-value-tools",
        );
        assert(
          state.configuration?.changes.some((change) =>
            change.status === "approved" &&
            change.authorityExercise?.delegation?.policyId ===
              "request-value-network"
          ),
        );
        assert(
          candidate.toolAdmissionPolicyPins?.some((pin) =>
            pin.policyId === "request-value-tools"
          ),
        );
        digests.add(candidate.digest);
        assert(
          recordedToolPages(state.messages).some((page) =>
            requestValueUrls.includes(
              page.url as typeof requestValueUrls[number],
            )
          ),
        );
      }
      assert.equal(
        digests.size,
        2,
        "Each operator owns distinct candidate bytes",
      );
      assert.equal(
        contexts.filter((context) =>
          context.operator?.name === "Research owner" && context.case
        ).every((context) => context.case!.id === owner.cases.cases[0]!.id),
        true,
      );
      progress("oracle-verified");
      success = true;
    } catch (error) {
      // Do not serialize arbitrary prompts, model text, or the environment.
      const redact = (text: string) =>
        text
          .replace(/(?:sk-ant-|sk-|Bearer\s+)[A-Za-z0-9_-]+/gi, "[redacted]")
          .replace(
            /(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi,
            "$1=[redacted]",
          ).slice(0, 1000);
      const safeError = redact(
        error instanceof Error ? error.message : String(error),
      );
      const snapshots =
        runtime?.workspace.conversations.snapshot.conversations.map((entry) => {
          const state = runtime!.workspace.runtimeFor(entry.agentId)?.runtime
            .snapshot;
          const workEvents = (state?.events ?? []).filter((event) =>
            "work" in event
          ).slice(-20).map((event) => {
            const work =
              (event as import("../../src/application/work/operators/journal.ts").OperatorWorkCompletion)
                .work;
            return {
              kind: event.kind,
              id: event.id,
              caseId: event.caseId,
              correlationId: work?.correlationId,
              status: work?.status,
              candidateIds: work?.candidateIds,
              revision: work?.revision,
            };
          });
          const planResults = (state?.messages ?? []).filter((message) =>
            recordedFeedback(
              message,
              "behavior-result",
              "Résultat observé du comportement ",
            ) !== undefined
          ).slice(-5).map((message) => {
            const plan = (recordedFeedback(
              message,
              "behavior-result",
              "Résultat observé du comportement ",
            ) as {
              result?: Partial<WorkPlanResultView>;
            } | undefined)?.result;
            return {
              messageId: message.id,
              caseId: message.caseId,
              planId: plan?.id,
              status: plan?.status,
              tasks: plan?.tasks?.map((task) => ({
                id: task.id,
                state: task.state,
                caseId: task.caseId,
                correlationId: task.contribution?.correlationId,
                errorCode: task.error?.code,
              })),
            };
          });
          return {
            name: entry.name,
            nativeId: entry.nativeId,
            phase: state?.phase,
            error: state?.error ? redact(state.error) : null,
            cases: state?.cases?.map((record) => ({
              id: record.id,
              status: record.status,
              owner: record.owner,
              budgetScope: record.budget?.scopeId,
            })),
            changes: state?.configuration?.changes.map((change) => ({
              id: change.id,
              caseId: change.caseId,
              status: change.status,
              kind: change.kind,
              requestedBy: change.requestedBy,
              revision: change.baseRevision,
            })),
            candidates: state?.candidates.map((candidate) => ({
              id: candidate.id,
              caseId: candidate.caseId,
              stage: candidate.stage,
              digest: candidate.digest,
              testsPassed: candidate.tests?.passed,
            })),
            workEvents,
            planResults,
            messages: state?.messages.slice(-20).map((message) => ({
              id: message.id,
              role: message.role,
              caseId: message.caseId,
              observation: message.observation?.kind,
              work: message.work
                ? {
                  callerId: message.work.callerId,
                  correlationId: message.work.correlationId,
                  invocationId: message.work.invocationId,
                  behaviorId: message.work.behaviorId,
                }
                : undefined,
              notice: message.operatorNotice?.kind,
            })),
          };
        }) ?? [];
      const projection = {
        failure: safeError,
        scratch: scratch ?? null,
        phase,
        mainClosedTurns,
        completedReplays,
        prepareArrivals,
        testStarts,
        testReturns,
        maxActiveTests,
        fetchedCount: fetched.length,
        contexts: contexts.length,
        snapshots,
      };
      try {
        const path = await Deno.makeTempFile({
          prefix: "assembly-mvp-value-flow-failure-",
          suffix: ".json",
        });
        const json = JSON.stringify(projection, null, 2);
        await Deno.writeTextFile(
          path,
          new TextEncoder().encode(json).length <= 128_000
            ? json + "\n"
            : JSON.stringify({ failure: safeError, scratch, truncated: true }) +
              "\n",
        );
        console.error(
          `Value-flow failure projection: ${path}; retained scratch: ${
            scratch ?? "unavailable"
          }`,
        );
      } catch {
        console.error(
          `Value-flow failure projection unavailable; retained scratch: ${
            scratch ?? "unavailable"
          }`,
        );
      }
      if (error instanceof Error) {
        error.message = safeError;
        if (error.stack) error.stack = redact(error.stack);
      }
      throw error instanceof Error ? error : new Error(safeError);
    } finally {
      clearTimeout(preparationTimer);
      globalThis.fetch = originalFetch;
      DenoToolRunner.prototype.test = originalTest;
      progress("closing-runtime");
      if (runtime) await runtime.close();
      else await fixture?.closeBackend();
      progress("closed-runtime");
      if (
        success && scratch &&
        Deno.env.get("ASSEMBLY_PRESERVE_REQUEST_VALUE_EVIDENCE") !== "1"
      ) await Deno.remove(scratch, { recursive: true });
    }
  },
});

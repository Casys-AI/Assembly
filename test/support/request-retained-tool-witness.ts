/** Controlled inputs for the joined and target PG/native witnesses. The runner is real: only
 * page acquisition is deterministic. No provider or network service is used. */
import assert from "node:assert/strict";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ToolDraft } from "../../src/domain/work/records/candidates.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces/opening.ts";
import type { openNormalAdmissionWitnessHost } from "./request-source-admission-normal-host.ts";

export const retainedWitnessUrl = "https://example.org/retained-witness";
export const retainedWitnessHtml =
  "<html><head><title>Retained witness</title></head><body><h1>Exact body</h1></body></html>";

const extraction = `export default ({html}: {url:string;html:string}) => {
  const title = (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] ?? "").trim();
  const body = html.match(/<body[^>]*>([\\s\\S]*?)<\\/body>/i)?.[1] ?? html;
  const text = body.replace(/<(script|style)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi," ")
    .replace(/<!--[\\s\\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\\s+/g," ").trim();
  return {title,text};
}`;
const outlineExtraction = String
  .raw`export default ({url,html}: {url:string;html:string}) => {
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
    const value = entity.slice(1,-1).toLowerCase();
    return value.startsWith("#") ? String.fromCodePoint(value[1] === "x" ? parseInt(value.slice(2),16) : Number(value.slice(1))) : named[value];
  });
  const clean = (value: string) => decode(value.replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim();
  const source = html.replace(/<!--[\s\S]*?-->/g," ").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ");
  const title = clean(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const headings = [...source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => clean(match[2]));
  const links: string[] = [];
  for (const anchor of source.matchAll(/<a\b[^>]*>/gi)) {
    const match = anchor[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const target = new URL(href,url);
      if (!["http:","https:"].includes(target.protocol)) continue;
      target.hash = "";
      if (!links.includes(target.href)) links.push(target.href);
    } catch { /* invalid URL */ }
  }
  return {title, text:[...headings,...links].join("\n")};
}`;

/** Each contract has distinct bytes and an observable deterministic result. */
export const retainedWitnessDrafts: readonly ToolDraft[] = [
  {
    name: "retained-page",
    description: "Read the selected page",
    kind: "read_web_page",
    code: extraction,
  },
  {
    name: "retained-outline",
    description: "Read the selected page outline",
    kind: "read_web_page_outline",
    code: outlineExtraction,
  },
];

/** Closed metadata only: no context, tool source, fetched body or session data. */
export interface RetainedWitnessProgress {
  phase:
    | "decision-entered"
    | "decision-context-checked"
    | "skill-checked"
    | "tool-selected"
    | "reply-selected"
    | "decision-failed"
    | "runner-entered"
    | "page-fetched"
    | "runner-completed"
    | "runner-failed";
  caseId?: string;
  decision?: number;
  toolIndex?: number;
  elapsedMs?: number;
}
export type RetainedWitnessObserver = (event: RetainedWitnessProgress) => void;

/** Assert the actual admitted decision context, then choose each tool once per
 * Case. The provider double never supplies source bytes or target authority. */
export function retainedWitnessAgent(observe?: RetainedWitnessObserver): {
  agent: AgentPort;
  decisions: Map<string, number>;
  arm(expectedSkill: { digest: string; content: string }): void;
} {
  const decisions = new Map<string, number>();
  let expectedSkill: { digest: string; content: string } | undefined;
  return {
    decisions,
    arm(skill) {
      expectedSkill = skill;
    },
    agent: {
      label: "Controlled retained-tool witness",
      decide(context) {
        const caseId = context.case?.id;
        observe?.({ phase: "decision-entered", caseId });
        try {
          assert(caseId, "The decision must carry its exact Request");
          assert(context.admittedModelVersion?.repositoryVersion);
          assert(context.skills);
          assert.equal(context.skills.loaded.length, 1);
          observe?.({ phase: "decision-context-checked", caseId });
          if (!expectedSkill) {
            return Promise.resolve({
              kind: "reply" as const,
              text: "Origin ready",
            });
          }
          assert.equal(context.skills.loaded[0].digest, expectedSkill.digest);
          assert.equal(context.skills.loaded[0].content, expectedSkill.content);
          observe?.({ phase: "skill-checked", caseId });
          const count = decisions.get(caseId) ?? 0;
          decisions.set(caseId, count + 1);
          if (count < retainedWitnessDrafts.length) {
            const draft = retainedWitnessDrafts[count];
            const matches = context.activeTools.filter((tool) =>
              tool.name === draft.name && tool.kind === draft.kind
            );
            assert.equal(
              matches.length,
              1,
              "Exact retained tool must be visible",
            );
            observe?.({
              phase: "tool-selected",
              caseId,
              decision: count + 1,
              toolIndex: count,
            });
            return Promise.resolve({
              kind: "invoke_tool" as const,
              text: `Invoke ${draft.name}`,
              toolId: matches[0].id,
              input: { url: retainedWitnessUrl },
            });
          }
          observe?.({ phase: "reply-selected", caseId, decision: count + 1 });
          return Promise.resolve({ kind: "reply" as const, text: "Completed" });
        } catch (error) {
          observe?.({ phase: "decision-failed", caseId });
          throw error;
        }
      },
      review() {
        throw new Error("The witness must not promote a target candidate");
      },
    },
  };
}

/** Sandbox execution remains real; a closed fetch double fixes page bytes and
 * asserts concrete URL, so it cannot make an external network request. */
export function retainedWitnessRunner(observe?: RetainedWitnessObserver): {
  runner: DenoToolRunner;
  fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    runner: new class extends DenoToolRunner {
      override async run(...args: Parameters<DenoToolRunner["run"]>) {
        const started = Date.now();
        const toolIndex = retainedWitnessDrafts.findIndex((draft) =>
          draft.kind === args[0].kind
        );
        observe?.({ phase: "runner-entered", toolIndex });
        try {
          const result = await super.run(...args);
          observe?.({
            phase: "runner-completed",
            toolIndex,
            elapsedMs: Date.now() - started,
          });
          return result;
        } catch (error) {
          observe?.({
            phase: "runner-failed",
            toolIndex,
            elapsedMs: Date.now() - started,
          });
          throw error;
        }
      }
    }({
      fetch(input) {
        const url = String(input);
        assert.equal(url, retainedWitnessUrl);
        fetched.push(url);
        observe?.({ phase: "page-fetched" });
        return Promise.resolve(
          new Response(retainedWitnessHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      },
    }),
  };
}

/** Both the joined qualification and the smaller target diagnostic keep the
 * same bounded phase trace. Case IDs stay in memory only for correlation. */
export function retainedWitnessObservation(label: string) {
  const started = Date.now();
  let lastPhase = started;
  const progress: RetainedWitnessProgress[] = [];
  return {
    progress,
    mark(phase: string) {
      const now = Date.now();
      console.log(`${label} phase`, {
        phase,
        elapsedMs: now - started,
        phaseMs: now - lastPhase,
      });
      lastPhase = now;
    },
    observe(event: RetainedWitnessProgress) {
      progress.push(event);
      if (progress.length > 64) progress.shift();
      const { caseId: _caseId, ...safe } = event;
      console.log(`${label} target progress`, {
        ...safe,
        elapsedMs: Date.now() - started,
        ...(event.elapsedMs !== undefined
          ? { operationMs: event.elapsedMs }
          : {}),
      });
    },
  };
}

type WitnessHost = Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>;

/** The receipt is the actual accepted initial contribution, not opening.phase.
 * This explicit PG/native witness needs three durable decision iterations. The
 * measured 30s run completed both tools but was still preparing decision three;
 * allow 90s here, without changing normal test budgets or terminal-failure checks.
 * Capture only closed outcomes/counts before the fixture destroys its schemas. */
export async function waitRetainedInitialCompleted(
  host: WitnessHost,
  record: OpeningRecord,
  progress: readonly RetainedWitnessProgress[],
  mark: (phase: string) => void,
  label = "A+",
): Promise<void> {
  const started = Date.now();
  const deadline = started + 90_000;
  const view = await host.stage.nativeRuntime.forCaseSpace(
    record.executionSpaceId,
    record.caseId,
  );
  let status = "missing";
  let acceptedThreadId: string | undefined;
  const fail = async (reason: string): Promise<never> => {
    const summary: Record<string, unknown> = {
      reason,
      receiptStatus: status,
      elapsedMs: Date.now() - started,
      workerErrors: host.workerErrors.length,
      progress: progress.filter((entry) =>
        !entry.caseId || entry.caseId === record.caseId
      )
        .slice(-24).map(({ caseId: _caseId, ...entry }) => entry),
    };
    // Diagnostic reads cannot replace the original failure or consume an
    // unbounded cleanup interval. Never serialize snapshots/result/error JSON.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const diagnostics = (async () => {
      const snapshots = acceptedThreadId
        ? await view.execution.inspect(host.primaryOperatorId, {
          threadId: acceptedThreadId,
          contributionId: record.initialContributionId,
        })
        : [];
      if (!acceptedThreadId) {
        summary.nativeDiagnostic = "accepted-receipt-thread-unavailable";
      }
      summary.native = snapshots.slice(0, 4).map((snapshot) => ({
        status: snapshot.status,
        waits: snapshot.waits.slice(0, 8).map((wait) => ({
          kind: wait.kind,
          mechanism: wait.mechanism,
        })),
        unsettledEffects: snapshot.unsettledEffects.length,
        pendingContributions: snapshot.pendingContributions.length,
        refusal: snapshot.refusal?.code === "NATIVE_EXECUTION_ADMISSION_REFUSED"
          ? snapshot.refusal.code
          : undefined,
      }));
      const scope = {
        ...host.storage.scope,
        executionSpaceId: record.executionSpaceId,
        operatorId: host.primaryOperatorId,
      };
      const runs = await host.storage.client.executionRun.findMany({
        where: { ...scope, contributionId: record.initialContributionId },
        orderBy: { createdAt: "desc" },
        take: 4,
        select: { status: true, retryCount: true, errorJson: true },
      });
      summary.runs = runs.map((run) => {
        // Match fixed diagnostic categories; error messages can contain skill
        // content or source bytes when a provider assertion fails.
        const error = run.errorJson ?? "";
        const classification = !error
          ? "none"
          : /AssertionError|ERR_ASSERTION|Expected values|Expected actual/.test(
              error,
            )
          ? "provider-or-host-assertion"
          : /Retained tool|retained tool|retained dependency/.test(error)
          ? "retained-tool-validation"
          : /timeout exceeded when trying to connect/.test(error)
          ? "pool-acquisition-timeout"
          : /admission|authority|permission/i.test(error)
          ? "admission-or-authority"
          : "technical-error";
        // Only fixed product messages may leave this diagnostic. Assertion
        // messages in particular may embed complete expected/actual sources.
        const knownFailures = [
          "The exact Request execution binding is unavailable.",
          "Retained tool dependency differs from the active target model",
          "The target retained tool admission is unavailable",
          "The retained tool execution target changed",
          "The target tool resource projection differs",
          "The current space execution admission is unavailable.",
          "The admitted tool dependency changed before invocation",
          "The completed tool's native identity is unavailable",
          "EFFECT_RECEIPT_MISMATCH",
        ];
        return {
          status: run.status,
          retryCount: run.retryCount,
          classification,
          knownFailure: knownFailures.find((message) =>
            error.includes(message)
          ),
        };
      });
      const effects = await host.storage.client.executionEffect.findMany({
        where: { ...scope, contributionId: record.initialContributionId },
        orderBy: { startedAt: "asc" },
        take: 32,
        select: { nodeId: true, status: true, resultJson: true },
      });
      const stores = await (await host.storage.caseSpace(
        record.executionSpaceId,
        record.caseId,
      )).operator(host.primaryOperatorId);
      const state = await stores.state.load();
      const nodes = state?.executionModel
        ? [
          ...Object.values(state.executionModel.flows),
          ...Object.values(state.executionModel.caseFlows ?? {}),
        ].flatMap((flow) => flow.nodes)
        : [];
      summary.effects = effects.map((effect) => {
        let outcome: unknown;
        try {
          outcome = JSON.parse(effect.resultJson ?? "null")?.outputs?.outcome;
        } catch { /* malformed receipt stays opaque */ }
        const code = outcome && typeof outcome === "object"
          ? (outcome as { code?: unknown }).code
          : undefined;
        const knownCodes = [
          "TOOL_COMPLETED",
          "TOOL_EXECUTION_FAILED",
          "TOOL_UNAVAILABLE",
          "URL_INVALID",
          "URL_NOT_SUPPLIED",
          "NETWORK_HOST_NOT_ALLOWED",
        ];
        return {
          mechanism: nodes.find((node) =>
            node.nativeId === effect.nodeId
          )?.mechanism ?? "unmapped",
          status: effect.status,
          outcome: typeof code === "string" && knownCodes.includes(code)
            ? code
            : undefined,
        };
      });
      summary.state = state
        ? {
          busy: state.busy,
          messages: state.messages.length,
          candidates: state.candidates.length,
        }
        : "missing";
    })();
    try {
      await Promise.race([
        diagnostics,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("diagnostic-deadline")),
            3_000,
          );
        }),
      ]);
    } catch {
      summary.diagnostics = "incomplete";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const serialized = JSON.stringify(summary);
    console.log(
      `${label} initial contribution observed before fixture cleanup`,
      serialized,
    );
    throw new Error(`${label} initial contribution: ${serialized}`);
  };
  while (Date.now() < deadline) {
    const accepted = await view.dispatch.inspectAccepted(
      host.primaryOperatorId,
      record.initialContributionId,
    );
    if (accepted) acceptedThreadId = accepted.receipt.threadId;
    const observed: string = accepted?.receipt.status ?? "missing";
    if (observed !== status) {
      status = observed;
      mark(`initial-receipt-${status}`);
    }
    if (status === "completed") {
      assert(accepted);
      const snapshots = await view.execution.inspect(host.primaryOperatorId, {
        threadId: accepted.receipt.threadId,
        contributionId: record.initialContributionId,
      });
      if (
        snapshots.some((snapshot) =>
          ["refused", "failed", "uncertain"].includes(snapshot.status)
        )
      ) {
        await fail("completed-transport-with-unsuccessful-native-outcome");
      }
      return;
    }
    if (["failed", "cancelled", "uncertain"].includes(status)) {
      await fail("terminal-receipt");
    }
    if (host.workerErrors.length) await fail("worker-error");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await fail("deadline");
}

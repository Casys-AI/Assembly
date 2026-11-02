/** Explicit, bounded real-provider qualification in an isolated temporary system. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DenoRuntimeProvenanceCollector } from "../src/infrastructure/runtime-provenance.ts";
import { ClaudeAgents } from "../src/adapters/out/llm-providers/agents.ts";
import { DenoToolRunner } from "../src/adapters/out/sandbox/runner.ts";
import {
  parallelPreparationEvidence,
  recordedToolPages,
  recordedWorkPlans,
  soleToolPageEvidence,
} from "../test/fixtures/request-value-attribution.ts";
import { openRequestValueRuntime } from "../test/fixtures/request-value-runtime.ts";
import {
  openRequestValueFixture,
  requestValueObjective,
  requestValueUrls,
} from "../test/fixtures/request-value-profile.ts";

if (!Deno.args.includes("--live")) {
  console.log(
    "No provider or public page contacted. Pass --live after deterministic qualification and explicit scheduling.",
  );
  Deno.exit(0);
}
const scratch = await Deno.makeTempDir({ prefix: "assembly-request-value-" });
console.log(`Evidence directory: ${scratch}`);
// The credential file can also configure the user's live project. This process
// always creates its own project below scratch, so inherit credentials only.
Deno.env.delete("ASSEMBLY_MODEL_PROJECT_DIR");
Deno.env.delete("ASE_MODEL_PROJECT_DIR");
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
const model = Deno.env.get("ANTHROPIC_MODEL");
if (!packageDir || !apiKey || !model) {
  const failure = "Toolkit path, provider key and model are required";
  await Deno.writeTextFile(
    `${scratch}/qualification-report.json`,
    JSON.stringify({
      mechanismCompleted: false,
      valueReview: "pending-human",
      failure,
      providerRequests: 0,
      usageComplete: false,
    }) + "\n",
  );
  console.error(failure);
  Deno.exit(1);
}
const maxRequests = 32;
const totalTimeCeilingMs = 20 * 60_000;
const deadline = Date.now() + totalTimeCeilingMs;
let requests = 0;
const completions: Array<{ usage?: unknown }> = [];
const providerPayloads: unknown[] = [];
const usageComplete = () =>
  requests > 0 && completions.length === requests &&
  completions.every((entry) => entry.usage !== undefined);
const provider = new ClaudeAgents({
  apiKey,
  model,
  effort: "low",
  decisionMaxTokens: 2048,
  timeoutMs: 60_000,
  fetch: (url, init) => {
    if (requests >= maxRequests || Date.now() >= deadline) {
      throw new Error("Qualification provider request or time ceiling reached");
    }
    requests++;
    if (typeof init?.body === "string") {
      const payload = JSON.parse(init.body);
      const contexts = [];
      for (const message of payload.messages ?? []) {
        for (
          const block of Array.isArray(message.content) ? message.content : []
        ) {
          if (
            block.type !== "text" || typeof block.text !== "string" ||
            !block.text.startsWith("{")
          ) continue;
          try {
            const context = JSON.parse(block.text).context;
            if (
              !context?.operator?.nativeId || !Array.isArray(context.messages)
            ) continue;
            contexts.push({
              operatorId: context.operator.nativeId,
              caseId: context.case?.id,
              characters: JSON.stringify(context).length,
              characterCounts: Object.fromEntries(
                Object.entries(context).map((
                  [key, value],
                ) => [key, JSON.stringify(value)?.length ?? 0]),
              ),
              messageCount: context.messages.length,
              candidateCount:
                context.operatorToolAdmission?.candidates?.length ?? 0,
            });
          } catch { /* Protocol repairs have no projected context. */ }
        }
      }
      providerPayloads.push({
        request: requests,
        at: new Date().toISOString(),
        model: payload.model,
        contexts,
      });
    }
    const remaining = Math.max(1, deadline - Date.now());
    return fetch(url, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(remaining)])
        : AbortSignal.timeout(remaining),
    });
  },
  onCompletion: (metadata) => {
    completions.push(metadata);
  },
});
const provenance = new DenoRuntimeProvenanceCollector({
  applicationDirectory: fileURLToPath(new URL("../", import.meta.url)),
  toolkitPackageDirectory: packageDir,
  agents: { provider: "claude", model, effort: "low", decisionMaxTokens: 2048 },
});
const originalSandboxTest = DenoToolRunner.prototype.test;
const sandboxTests: Array<
  { name: string; startedAt: string; endedAt?: string }
> = [];
DenoToolRunner.prototype.test = async function (draft) {
  const event = {
    name: draft.name,
    startedAt: new Date().toISOString(),
    endedAt: undefined as string | undefined,
  };
  sandboxTests.push(event);
  try {
    return await originalSandboxTest.call(this, draft);
  } finally {
    event.endedAt = new Date().toISOString();
  }
};
let runtime: Awaited<ReturnType<typeof openRequestValueRuntime>> | undefined;
let fixture: Awaited<ReturnType<typeof openRequestValueFixture>> | undefined;
const timer = setTimeout(() => {
  const report = {
    qualification: "request-value-real-provider",
    mechanismCompleted: false,
    valueReview: "pending-human",
    failure: "Total time ceiling reached",
    model,
    deno: Deno.version,
    sandboxTests,
    providerRequests: requests,
    providerRequestCeiling: maxRequests,
    totalTimeCeilingMs,
    providerUsage: completions,
    usageComplete: false,
  };
  Deno.writeTextFileSync(
    `${scratch}/qualification-report.json`,
    JSON.stringify(report).replaceAll(apiKey, "[redacted]") + "\n",
  );
  console.error(
    "Qualification stopped at the total time ceiling; incomplete evidence preserved when the scratch directory exists.",
  );
  Deno.exit(124);
}, Math.max(1, deadline - Date.now()));
let mechanismCompleted = false;
let sourceEvidenceCollection: "not-reached" | "partial" | "complete" =
  "not-reached";
const observedSources: Array<
  {
    operator: string;
    requestedUrl: string;
    returnedUrl: string;
    title: string;
    textExcerpt: string;
    textDigest: string;
    candidateDigest: string;
    candidateId: string;
    callEventId: string;
    completionEventId: string;
  }
> = [];
let mainResponse: string | null = null;
let rootRequest: { id: string; status: string } | null = null;
let parallelPreparation: ReturnType<typeof parallelPreparationEvidence>;
let failure: string | null = null;
const started = new Date().toISOString();
try {
  fixture = await openRequestValueFixture(packageDir, scratch);
  runtime = await openRequestValueRuntime(
    packageDir,
    provider,
    fixture,
    provenance,
  );
  const instruction =
    `${requestValueObjective}\nOpen exactly one Request on the admitted Research owner. Its two operators should each request the exact host ${
      new URL(requestValueUrls[0]).hostname
    }, prepare distinct read_web_page candidates in a closed parallel plan, and wait. Inspect and decide each exact candidate and each covered network request under the initial grants. Resume the exact Request as necessary to collect actual work-plan results and continue the work, without inventing human messages or source contents. Return the completed attributed result with actual sources, observed results, refusals and limitations. The Request may remain open after its completed contributions; do not confuse its lifecycle status with completion of the requested result.`;
  await runtime.workspace.conversations.submitHuman({
    agentId: runtime.mainId,
    expectedRevision: runtime.primary.snapshot.revision,
    text: instruction,
  });
  await runtime.workspace.conversations.idle();
  await runtime.postgres.idle();
  assert(Date.now() < deadline, "Qualification time ceiling reached");
  assert.equal(runtime.primary.snapshot.error, undefined);
  const owner = runtime.workspace.runtimeFor(runtime.owner.agentId)!.runtime;
  assert.equal(
    owner.cases.cases.length,
    1,
    "Exactly one root Request is required",
  );
  rootRequest = {
    id: owner.cases.cases[0]!.id,
    status: owner.cases.cases[0]!.status,
  };
  assert.notEqual(
    rootRequest.status,
    "closed-abandoned",
    "Root Request was abandoned",
  );
  assert.equal(owner.snapshot.error, undefined, "Request owner failed");
  assert.equal(
    runtime.primary.cases.cases.length,
    0,
    "Main must remain in its designer conversation",
  );
  const finalReply = runtime.primary.snapshot.messages.findLast((message) =>
    message.role === "assistant"
  )?.text ?? "";
  mainResponse = finalReply;
  assert(
    requestValueUrls.every((url) =>
      finalReply.includes(url)
    ),
    "Main did not return both source URLs",
  );
  const activeDigests = new Set<string>();
  sourceEvidenceCollection = "partial";
  for (const [index, peer] of runtime.peers.entries()) {
    const state: import("../src/domain/work/dialogue.ts").SystemRuntimeState =
      runtime.workspace.runtimeFor(peer.agentId)!.runtime.snapshot;
    assert.equal(state.error, undefined, "Contributor failed");
    assert(
      !state.configuration?.changes.some((change) =>
        change.caseId === rootRequest!.id && change.status === "pending"
      ),
      "Contribution still has a pending mandate decision",
    );
    const evidence = soleToolPageEvidence(
      state.messages,
      state.events,
      requestValueUrls[index]!,
    );
    assert(
      evidence,
      "Actual nonempty title and extracted text for the assigned URL are required",
    );
    assert(
      evidence.candidateId && evidence.callEventId &&
        evidence.completionEventId,
      evidence.limitation ?? "Producing candidate is not uniquely attributable",
    );
    const candidate = state.candidates.find((item) =>
      item.id === evidence.candidateId && item.stage === "active" &&
      item.tests?.passed
    );
    assert(
      candidate,
      "The observed producing candidate must be active and tested",
    );
    assert.equal(
      candidate.caseId,
      rootRequest.id,
      "Candidate belongs to another Request",
    );
    assert.equal(candidate.admission?.authority, "delegate");
    assert.equal(candidate.admission?.actorId, runtime.mainId);
    assert.equal(candidate.admission?.candidateDigest, candidate.digest);
    assert.equal(
      candidate.admission?.authorityExercise?.candidateDelegation?.policyId,
      "request-value-tools",
    );
    assert(
      !state.candidates.some((item) =>
        item.caseId === rootRequest!.id &&
        ["proposed", "testing", "reviewing", "awaiting-admission", "activating"]
          .includes(item.stage)
      ),
      "Contribution still has a pending candidate",
    );
    assert(
      state.configuration?.changes.some((change) =>
        change.status === "approved" &&
        change.authorityExercise?.delegation?.policyId ===
          "request-value-network"
      ),
      "Covered Main network decision missing",
    );
    activeDigests.add(candidate.digest);
    const result = evidence.page;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(result.text),
    );
    observedSources.push({
      operator: peer.name,
      requestedUrl: requestValueUrls[index]!,
      returnedUrl: result.url,
      title: result.title.slice(0, 500),
      textExcerpt: result.text.slice(0, 4000),
      textDigest: Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0")).join(""),
      candidateDigest: candidate.digest,
      candidateId: evidence.candidateId,
      callEventId: evidence.callEventId,
      completionEventId: evidence.completionEventId,
    });
  }
  sourceEvidenceCollection = "complete";
  assert.equal(activeDigests.size, 2, "Distinct candidate digests required");
  const plans = recordedWorkPlans(owner.snapshot.messages).filter((plan) =>
    plan.caseId === rootRequest!.id
  );
  assert(
    plans.length > 0 && plans.every((plan) =>
      plan.status === "completed"
    ),
    "Root Request has unresolved work plans",
  );
  parallelPreparation = parallelPreparationEvidence(
    plans,
    rootRequest.id,
    runtime.owner.agentId,
    runtime.peers.map((peer, index) => ({
      id: `prep-peer${index + 1}`,
      resourceId: peer.agentId,
      url: requestValueUrls[index]!,
      candidateId: observedSources[index]!.candidateId,
    })),
  );
  assert(
    parallelPreparation,
    "Exact candidate preparation attempts did not overlap with correlated Root receipts",
  );
  assert(
    sandboxTests.length === 2 && sandboxTests.every((event) => event.endedAt),
    "Exactly two completed sandbox tests are required",
  );
  // The observed conditions are evidence for review, not human acceptance.
  mechanismCompleted = true;
} catch (error) {
  failure = (error instanceof Error ? error.message : String(error))
    .replaceAll(apiKey, "[redacted]").slice(0, 2000);
} finally {
  const evidence = {
    qualification: "request-value-real-provider",
    started,
    ended: new Date().toISOString(),
    elapsedMs: Date.now() - Date.parse(started),
    mechanismCompleted,
    valueReview: "pending-human",
    observedSources,
    sourceEvidenceCollection,
    sandboxTests,
    mainResponse,
    rootRequest,
    parallelPreparation,
    sandboxCallsOverlap:
      sandboxTests.length === 2 && sandboxTests.every((event) => event.endedAt)
        ? Date.parse(sandboxTests[0]!.startedAt) <
            Date.parse(sandboxTests[1]!.endedAt!) &&
          Date.parse(sandboxTests[1]!.startedAt) <
            Date.parse(sandboxTests[0]!.endedAt!)
        : null,
    providerPayloads,
    failure,
    model,
    runtimeProvenance: runtime
      ? await provenance.collect().catch(() => null)
      : null,
    deno: Deno.version,
    providerRequests: requests,
    providerRequestCeiling: maxRequests,
    totalTimeCeilingMs,
    providerUsage: completions,
    usageComplete: usageComplete(),
    urls: requestValueUrls,
    directory: scratch,
    dataDir: fixture?.dataDir ?? null,
    projectDir: fixture?.projectDir ?? null,
    projectId: fixture?.projectId ?? null,
    initialGrants: runtime
      ? { network: runtime.networkGrant, admission: runtime.admissionGrant }
      : null,
    sourceVersion: runtime
      ? (await runtime.repository.current().catch(() => null))?.version ?? null
      : null,
    operators: runtime
      ? runtime.workspace.conversations.snapshot.conversations.map((entry) => {
        const state = runtime!.workspace.runtimeFor(entry.agentId)?.runtime
          .snapshot;
        const pages = recordedToolPages(state?.messages ?? []);
        return {
          name: entry.name,
          nativeId: entry.nativeId,
          modelVersion: state?.executionModel?.version,
          error: state?.error ?? null,
          finalJournalFacts: {
            toolCalls: state?.events.filter((event) =>
              event.kind === "tool-called"
            ).length ?? 0,
            toolCompletions: state?.events.filter((event) =>
              event.kind === "tool-completed"
            ).length ?? 0,
            pageObservations: {
              count: pages.length,
              omitted: Math.max(0, pages.length - 8),
              items: pages.slice(-8).map((page) => ({
                url: page.url.slice(0, 2048),
                title: page.title.slice(0, 512),
                textCharacters: page.text.length,
              })),
            },
            observedPlans: recordedWorkPlans(state?.messages ?? []).slice(-8)
              .map((plan) => ({
                id: plan.id,
                revision: plan.revision,
                status: plan.status,
                tasks: plan.tasks.map((task) => ({
                  id: task.id,
                  state: task.state,
                })),
              })),
          },
          cases: state?.cases ?? [],
          candidates: state?.candidates?.map((c) => ({
            id: c.id,
            digest: c.digest,
            kind: c.kind,
            stage: c.stage,
            caseId: c.caseId,
            tests: c.tests,
            admission: c.admission,
          })),
          messages: state?.messages.slice(-30).map((m) => ({
            role: m.role,
            caseId: m.caseId,
            text: m.text?.slice(0, 4000),
            work: m.work,
            observation: m.observation,
            operatorNotice: m.operatorNotice,
          })),
        };
      })
      : [],
  };
  {
    const text = JSON.stringify(evidence, null, 2).replaceAll(
      apiKey,
      "[redacted]",
    );
    const bounded = new TextEncoder().encode(text).length <= 1_000_000
      ? text
      : JSON.stringify({
        qualification: evidence.qualification,
        mechanismCompleted: false,
        valueReview: "pending-human",
        failure: "Evidence exceeded output ceiling",
        providerRequests: requests,
        providerUsage: completions,
        usageComplete: false,
      }).replaceAll(apiKey, "[redacted]");
    if (bounded !== text) {
      mechanismCompleted = false;
      failure = "Evidence exceeded output ceiling";
    }
    await Deno.writeTextFile(
      `${scratch}/qualification-report.json`,
      bounded + "\n",
    );
    console.log(`Evidence: ${scratch}/qualification-report.json`);
  }
  DenoToolRunner.prototype.test = originalSandboxTest;
  await runtime?.close();
  clearTimeout(timer);
  console.log(
    JSON.stringify({
      mechanismCompleted,
      valueReview: "pending-human",
      failure,
      model,
      providerRequests: requests,
      usageComplete: usageComplete(),
    }),
  );
}
if (!mechanismCompleted) Deno.exit(1);

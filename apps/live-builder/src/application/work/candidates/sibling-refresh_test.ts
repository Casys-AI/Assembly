import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { type ActivationResumeHost, settleActivation } from "./activation.ts";
import type {
  NativeExecutionPort,
  NativeExecutionSnapshot,
} from "../runtime/execution.ts";
import { prepareSiblingCatalogRefresh } from "./sibling-refresh.ts";
import {
  activate,
  candidate,
  candidateContract,
  exactReview,
  nativeCandidate,
  type PromotionCandidatesHost,
  stage,
} from "./promotion.ts";
import { draftDigest, valueDigest } from "../runtime/values.ts";

/** The real publication driver and admission rules, with a technical model port. */
async function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.repositoryVersion = "commit:before";
  const admissionNode = model.flows.promotion.nodes.find((node) =>
    node.mechanism === "decide_admission"
  )!;
  const prepared = async (id: string): Promise<Candidate> => {
    const draft = {
      name: `reader-${id}`,
      description: "Exact reader",
      kind: "read_web_page" as const,
      code: "export default ({html}) => ({title:'Page',text:html})",
    };
    const digest = await draftDigest(draft);
    const tests = {
      passed: true,
      checks: [{ name: "contract", passed: true, detail: "Exact code tested" }],
    };
    const reference = { id, candidateId: id, digest, baseCatalogRevision: 0 };
    return {
      ...draft,
      id,
      digest,
      caseId: "request-one",
      stage: "awaiting-admission",
      createdAt: "2026-10-26T00:00:00.000Z",
      baseCatalogRevision: 0,
      batchCall: { batchId: "one-response", callId: `provider-${id}` },
      tests,
      preparationEvidence: {
        modelDigest: model.version.digest,
        testsDigest: await valueDigest(tests),
        contractDigest: await valueDigest(model.contracts[0]),
      },
      requiredAuthority: "human",
      proposedConfigurationRevision: model.configuration.revision,
      promotionModelDigest: model.version.digest,
      promotionExecution: {
        subjectId: `promotion-${id}`,
        threadId: `promotion-thread-${id}`,
        modelDigest: model.version.digest,
      },
      promotionCursor: {
        nodeId:
          model.flows.promotion.nodes.find((node) =>
            node.mechanism === "decide_admission"
          )!.id,
      },
      promotionContext: {
        propose: { candidate: structuredClone(reference) },
        admit: { candidate: structuredClone(reference), tests },
      },
    };
  };
  const state = {
    id: "system",
    revision: 0,
    model: model.identity,
    executionModel: structuredClone(model),
    configuration: structuredClone(model.configuration),
    catalogRevision: 0,
    candidates: await Promise.all([prepared("a"), prepared("b")]),
    events: [],
    messages: [],
  } as unknown as SystemRuntimeState;
  // Fixed native receipts belong to the prepared candidates. Inspection returns
  // copies of these exact waits, including after publication/restart; this unit
  // fixture does not claim to execute or durably checkpoint the native graph.
  const snapshots: NativeExecutionSnapshot[] = state.candidates.map((
    entry,
  ) => ({
    contributionId: `prepared-${entry.id}`,
    identity: {
      operatorId: model.identity.builderId,
      invocationKey: JSON.stringify(["local", entry.caseId]),
      scope: {
        kind: "request",
        scopeId: entry.caseId!,
        rootRequestId: entry.caseId!,
      },
      purpose: "promotion",
      subjectId: entry.promotionExecution!.subjectId,
    },
    threadId: entry.promotionExecution!.threadId!,
    modelDigest: entry.promotionExecution!.modelDigest,
    repositoryVersion: model.version.repositoryVersion,
    flowRootId: model.flows.promotion.rootNativeId,
    status: "waiting",
    waits: [{
      nodeId: admissionNode.id,
      mechanism: "decide_admission",
      kind: "decision",
    }],
    unsettledEffects: [],
    pendingContributions: [],
  }));
  const unused = () =>
    Promise.reject(
      new Error("This activation fixture only inspects native waits"),
    );
  const execution: NativeExecutionPort = {
    inspect: (operatorId) => {
      equal(operatorId, model.identity.builderId);
      return Promise.resolve(structuredClone(snapshots));
    },
    run: unused,
    closeScope: unused,
    retireAndAdvance: unused,
  };
  const publications: string[] = [];
  const hooks: {
    published?: () => void;
    interruptAfterPublication?: boolean;
  } = {};
  const host: PromotionCandidatesHost & ActivationResumeHost = {
    get state() {
      return state;
    },
    ports: {
      execution,
      model: {
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        activateCandidate: (_identity, selected) => {
          const binding = { elementId: `native-${selected.id}`, graphPath: "" };
          if (
            !model.catalog.some((entry) => entry.candidateId === selected.id)
          ) {
            publications.push(selected.id);
            model.catalog.push({
              nativeId: binding.elementId,
              candidateId: selected.id,
              digest: selected.digest,
              name: selected.name,
              kind: selected.kind,
              contractId: model.contracts[0].nativeId,
              status: "active",
            });
            model.version.repositoryVersion = `commit:after-${selected.id}`;
            hooks.published?.();
            if (hooks.interruptAfterPublication) {
              hooks.interruptAfterPublication = false;
              throw new Error("Interrupted after the exact publication");
            }
          }
          return Promise.resolve(binding);
        },
        findCandidate: undefined,
      },
    },
    currentModel: () => Promise.resolve(structuredClone(model)),
    update(
      change: (state: SystemRuntimeState) => void,
      when?: (state: SystemRuntimeState) => boolean,
    ) {
      if (when && !when(state)) return Promise.resolve();
      change(state);
      state.revision++;
      return Promise.resolve();
    },
    candidate(id) {
      return candidate.call(host, id);
    },
    candidateContract(current, selected) {
      return candidateContract.call(host, current, selected);
    },
    nativeCandidate(current, selected, status) {
      return nativeCandidate.call(host, current, selected, status);
    },
    exactReview(current, selected) {
      return exactReview.call(host, current, selected);
    },
    stage(id, status, label) {
      return stage.call(host, id, status, label);
    },
    feedback: () => Promise.resolve(),
  };
  async function assertRefreshable() {
    // Positive control for every refusal variant: its intact setup must first
    // satisfy the production refresh predicate with a verified single entry.
    const selected = state.candidates[0];
    const native = structuredClone(model);
    native.catalog.push({
      nativeId: `native-${selected.id}`,
      candidateId: selected.id,
      digest: selected.digest,
      name: selected.name,
      kind: selected.kind,
      contractId: native.contracts[0].nativeId,
      status: "active",
    });
    const refresh = await prepareSiblingCatalogRefresh(
      state,
      selected,
      native,
      await execution.inspect(native.identity.builderId),
    );
    deepStrictEqual(refresh?.siblings.map((entry) => entry.candidateId), ["b"]);
  }
  return { model, state, host, publications, hooks, assertRefreshable };
}

Deno.test("verified sibling publication refreshes the exact tested base and still requires its separate admission", async () => {
  const f = await fixture();
  const sibling = structuredClone(f.state.candidates[1]);
  f.hooks.published = () => {
    // Catalog insertion can move excerpts while the admitted actions are exact.
    f.model.flows.promotion.source.line = "moved-source-position";
    f.model.flows.promotion.nodes[0].source.line = "moved-node-position";
  };
  await activate.call(f.host, "a", "human", "Admit the first exact candidate");
  const refreshed = f.state.candidates[1];
  equal(refreshed.baseCatalogRevision, 1);
  equal(refreshed.stage, "awaiting-admission");
  equal(refreshed.admission, undefined);
  equal(refreshed.admissionDecision, undefined);
  equal(refreshed.requiredAuthority, sibling.requiredAuthority);
  deepStrictEqual(refreshed.tests, sibling.tests);
  deepStrictEqual(refreshed.preparationEvidence, sibling.preparationEvidence);
  equal(refreshed.catalogRefreshes?.length, 1);
  equal(refreshed.catalogRefreshes![0].publishedCandidateId, "a");
  equal(refreshed.catalogRefreshes![0].fromCatalogRevision, 0);
  equal(refreshed.catalogRefreshes![0].toCatalogRevision, 1);
  equal(
    (refreshed.promotionContext!.admit as {
      candidate: { baseCatalogRevision: number };
    }).candidate.baseCatalogRevision,
    1,
  );
  ok(
    f.state.events.some((event) =>
      event.kind === "candidate-catalog-base-refreshed" &&
      event.candidateId === "b"
    ),
  );
  deepStrictEqual(f.publications, ["a"]);
  await activate.call(f.host, "b", "human", "Admit the second exact candidate");
  deepStrictEqual(f.publications, ["a", "b"]);
  deepStrictEqual(f.state.candidates.map((entry) => entry.stage), [
    "active",
    "active",
  ]);
  equal(f.state.catalogRevision, 2);
});

for (
  const changed of [
    "different-batch",
    "different-case",
    "duplicate-call-id",
    "missing-evidence",
    "changed-draft",
    "changed-tests",
    "recorded-decision",
    "unrelated-catalog-entry",
    "changed-contract",
    "new-authority",
  ] as const
) {
  Deno.test(`sibling refresh retains stale-base refusal for ${changed}`, async () => {
    const f = await fixture();
    await f.assertRefreshable();
    const sibling = f.state.candidates[1];
    if (changed === "different-batch") sibling.batchCall!.batchId = "other";
    if (changed === "different-case") sibling.caseId = "other-request";
    if (changed === "duplicate-call-id") {
      sibling.batchCall!.callId = "provider-a";
    }
    if (changed === "missing-evidence") delete sibling.preparationEvidence;
    if (changed === "changed-draft") sibling.code += "\n// changed";
    if (changed === "changed-tests") {
      sibling.tests!.checks[0].detail = "changed";
    }
    if (changed === "recorded-decision") {
      sibling.admissionDecision = {
        candidateDigest: sibling.digest,
        verdict: "approve",
        reason: "A decision cannot be transplanted",
      };
    }
    f.hooks.published = () => {
      if (changed === "unrelated-catalog-entry") {
        f.model.catalog.push({
          ...f.model.catalog[0],
          nativeId: "unrelated-native",
          candidateId: "unrelated-candidate",
          name: "unrelated",
        });
      }
      if (changed === "changed-contract") {
        f.model.contracts[0].acceptanceCriteria = ["Different contract"];
      }
      if (changed === "new-authority") {
        f.model.mandate.mayAdmitOwnCandidates = true;
      }
    };
    await activate.call(
      f.host,
      "a",
      "human",
      "Admit the exact first candidate",
    );
    equal(sibling.baseCatalogRevision, 0);
    equal(sibling.catalogRefreshes, undefined);
    await rejects(() =>
      activate.call(f.host, "b", "human", "An unrelated change is stale")
    );
    deepStrictEqual(f.publications, ["a"]);
    equal(sibling.stage, "awaiting-admission");
    equal(sibling.admission, undefined);
  });
}

Deno.test("recovery after a verified first effect refreshes its sibling without republishing the effect", async () => {
  const f = await fixture();
  const receipts = await f.host.ports.execution!.inspect(
    f.model.identity.builderId,
  );
  const siblingExecution = structuredClone(
    f.state.candidates[1].promotionExecution,
  );
  f.hooks.interruptAfterPublication = true;
  await rejects(() =>
    activate.call(f.host, "a", "human", "Admit the exact first candidate")
  );
  equal(f.state.candidates[0].stage, "activating");
  equal(f.state.candidates[1].baseCatalogRevision, 0);
  deepStrictEqual(f.publications, ["a"]);
  deepStrictEqual(await settleActivation.call(f.host, "a", "restart"), {
    status: "active",
  });
  equal(f.state.candidates[1].baseCatalogRevision, 1);
  equal(f.state.candidates[1].catalogRefreshes?.length, 1);
  deepStrictEqual(f.state.candidates[1].promotionExecution, siblingExecution);
  deepStrictEqual(
    await f.host.ports.execution!.inspect(f.model.identity.builderId),
    receipts,
  );
  deepStrictEqual(f.publications, ["a"]);
  await activate.call(
    f.host,
    "b",
    "human",
    "Separate recovered sibling admission",
  );
  deepStrictEqual(f.publications, ["a", "b"]);
});

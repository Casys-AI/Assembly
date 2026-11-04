import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  activate,
  artifactEvidence,
  candidate,
  candidateContract,
  exactInputCandidate,
  exactReview,
  nativeCandidate,
  type PromotionCandidatesHost,
  stage,
} from "./promotion.ts";
import { draftDigest, valueDigest } from "../runtime/values.ts";

const AT = "2026-10-28T00:00:00.000Z";

function draft(name = "reader"): ToolDraft {
  return {
    name,
    description: "Exact reader",
    kind: "read_web_page",
    code: "export default ({html}) => ({title:'Page',text:html})",
  };
}

async function testedCandidate(
  overrides: Partial<Candidate> = {},
): Promise<Candidate> {
  const d = draft(overrides.name ?? "reader");
  const digest = await draftDigest(d);
  return {
    ...d,
    id: "c1",
    digest,
    stage: "awaiting-admission",
    createdAt: AT,
    baseCatalogRevision: 0,
    tests: { passed: true, checks: [] },
    requiredAuthority: "human",
    ...overrides,
  };
}

function modelFixture(): ExecutableModel {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.repositoryVersion = "commit:char";
  return model;
}

function hostFixture(
  model: ExecutableModel,
  candidates: Candidate[],
  opts: {
    publications?: string[];
    feedbacks?: string[];
    catalogRevision?: number;
  } = {},
): PromotionCandidatesHost {
  const state = {
    id: "system",
    revision: 0,
    model: model.identity,
    executionModel: structuredClone(model),
    configuration: structuredClone(model.configuration),
    catalogRevision: opts.catalogRevision ?? 0,
    candidates,
    events: [],
    messages: [],
    phase: "",
  } as unknown as SystemRuntimeState;
  const host: PromotionCandidatesHost = {
    get state() {
      return state;
    },
    ports: {
      clock: { now: () => "2026-11-03T00:00:00.000Z" },
      model: {
        readExecutableModel: () => Promise.resolve(structuredClone(model)),
        activateCandidate: (_identity, selected) => {
          const binding = {
            elementId: `native-${selected.id}`,
            graphPath: "",
          };
          if (
            !model.catalog.some((entry) => entry.candidateId === selected.id)
          ) {
            opts.publications?.push(selected.id);
            model.catalog.push({
              nativeId: binding.elementId,
              candidateId: selected.id,
              digest: selected.digest,
              name: selected.name,
              kind: selected.kind,
              contractId: model.contracts[0].nativeId,
              status: "active",
            });
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
    candidate(id: string) {
      return candidate.call(host, id);
    },
    stage(id: string, status, label: string) {
      return stage.call(host, id, status, label);
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
    feedback(text: string) {
      opts.feedbacks?.push(text);
      return Promise.resolve();
    },
  };
  return host;
}

// --- candidate() ---

Deno.test("promotion/candidate returns the stored candidate", async () => {
  const c = await testedCandidate();
  const host = hostFixture(modelFixture(), [c]);
  equal(candidate.call(host, "c1").id, "c1");
});

Deno.test("promotion/candidate throws when missing", () => {
  const host = hostFixture(modelFixture(), []);
  let error: unknown;
  try {
    candidate.call(host, "missing");
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  equal(error.message, "Candidat introuvable");
});

// --- stage() ---

Deno.test("promotion/stage updates stage, phase and journal", async () => {
  const c = await testedCandidate({ stage: "proposed" });
  const host = hostFixture(modelFixture(), [c]);
  await stage.call(host, "c1", "testing", "Essai");
  equal(host.state.candidates[0].stage, "testing");
  equal(host.state.phase, "Essai");
  ok(host.state.events.some((e) => e.kind === "tool-testing"));
});

// --- candidateContract() ---

Deno.test("promotion/candidateContract returns the unique contract", async () => {
  const model = modelFixture();
  const c = await testedCandidate();
  const host = hostFixture(model, [c]);
  const found = candidateContract.call(host, model, c);
  equal(found.kind, "read_web_page");
});

Deno.test("promotion/candidateContract throws without a unique contract", async () => {
  const model = modelFixture();
  model.contracts = [];
  const c = await testedCandidate();
  const host = hostFixture(model, [c]);
  let error: unknown;
  try {
    candidateContract.call(host, model, c);
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("contrat unique"));
  // Two contracts of the same kind also fail.
  const model2 = modelFixture();
  model2.contracts = [
    structuredClone(model2.contracts[0]!),
    structuredClone(model2.contracts[0]!),
  ];
  let error2: unknown;
  try {
    candidateContract.call(host, model2, c);
  } catch (e) {
    error2 = e;
  }
  ok(error2 instanceof Error);
});

// --- nativeCandidate() ---

Deno.test("promotion/nativeCandidate matches an exact active entry", async () => {
  const model = modelFixture();
  const c = await testedCandidate();
  const host = hostFixture(model, [c]);
  model.catalog.push({
    nativeId: "native-c1",
    candidateId: "c1",
    digest: c.digest,
    name: c.name,
    kind: c.kind,
    contractId: model.contracts[0].nativeId,
    status: "active",
  });
  equal(nativeCandidate.call(host, model, c, "active"), true);
  equal(nativeCandidate.call(host, model, c, "activating"), false);
});

Deno.test("promotion/nativeCandidate rejects digest, binding and contract mismatches", async () => {
  const model = modelFixture();
  const c = await testedCandidate({
    binding: { elementId: "native-c1", graphPath: "" },
  });
  const host = hostFixture(model, [c]);
  model.catalog.push({
    nativeId: "other-native",
    candidateId: "c1",
    digest: c.digest,
    name: c.name,
    kind: c.kind,
    contractId: model.contracts[0].nativeId,
    status: "active",
  });
  // Binding points elsewhere.
  equal(nativeCandidate.call(host, model, c, "active"), false);
  // Wrong digest.
  const changed = structuredClone(c);
  changed.digest = "0".repeat(64);
  equal(nativeCandidate.call(host, model, changed, "active"), false);
  // Missing contract.
  const broken = modelFixture();
  broken.contracts = [];
  broken.catalog = structuredClone(model.catalog);
  equal(nativeCandidate.call(host, broken, c, "active"), false);
});

// --- exactInputCandidate() ---

Deno.test("promotion/exactInputCandidate returns the exact candidate", async () => {
  const c = await testedCandidate();
  const host = hostFixture(modelFixture(), [c]);
  const found = exactInputCandidate.call(
    host,
    { id: "c1", digest: c.digest },
    "c1",
  );
  equal(found.id, "c1");
});

Deno.test("promotion/exactInputCandidate rejects another target", async () => {
  const c = await testedCandidate();
  const host = hostFixture(modelFixture(), [c]);
  let error: unknown;
  try {
    exactInputCandidate.call(host, { id: "c2", digest: c.digest }, "c1");
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  equal(error.message, "L’action native vise un autre candidat.");
  let missing: unknown;
  try {
    exactInputCandidate.call(host, { id: "c1", digest: c.digest });
  } catch (e) {
    missing = e;
  }
  ok(missing instanceof Error);
});

Deno.test("promotion/exactInputCandidate rejects a changed digest", async () => {
  const c = await testedCandidate();
  const host = hostFixture(modelFixture(), [c]);
  let error: unknown;
  try {
    exactInputCandidate.call(host, { id: "c1", digest: "0".repeat(64) }, "c1");
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  equal(error.message, "Le digest du candidat natif a changé.");
});

// --- exactReview() ---

async function reviewedFixture(verdict: "approve" | "refuse" = "approve") {
  const model = modelFixture();
  model.identity.reviewerId = "reviewer-native";
  model.configuration.reviewer = {
    id: "reviewer",
    mandateRevision: 1,
  } as unknown as ExecutableModel["configuration"]["reviewer"];
  const node = model.flows.promotion.nodes.find((n) =>
    n.mechanism === "decide_admission"
  )!;
  const reviewNode = {
    ...structuredClone(node),
    id: "review-node",
    nativeId: "review-action",
    mechanism: "review_candidate" as const,
    performerId: "reviewer-native",
  };
  model.flows.promotion.nodes.push(reviewNode);
  const c = await testedCandidate({
    tests: {
      passed: true,
      checks: [{ name: "c", passed: true, detail: "ok" }],
    },
  });
  const contract = model.contracts.find((entry) => entry.kind === c.kind)!;
  c.review = {
    candidateDigest: c.digest,
    verdict,
    reason: "Looks exact",
  };
  c.reviewExecution = {
    modelDigest: model.version.digest,
    actionId: "review-action",
    reviewerId: "reviewer",
    testsDigest: await valueDigest(c.tests),
    contractDigest: await valueDigest(contract),
  };
  return { model, candidate: c, contract };
}

Deno.test("promotion/exactReview accepts the exact approve proof", async () => {
  const { model, candidate: c } = await reviewedFixture("approve");
  const host = hostFixture(model, [c]);
  const result = await exactReview.call(host, model, c);
  deepStrictEqual(result, {
    approved: true,
    candidateDigest: c.digest,
    reason: "Looks exact",
  });
});

Deno.test("promotion/exactReview accepts a refuse verdict as not approved", async () => {
  const { model, candidate: c } = await reviewedFixture("refuse");
  const host = hostFixture(model, [c]);
  const result = await exactReview.call(host, model, c);
  equal(result.approved, false);
});

Deno.test("promotion/exactReview rejects review, proof and pin mismatches", async () => {
  const cases: Array<
    (f: Awaited<ReturnType<typeof reviewedFixture>>) => void
  > = [
    (f) => delete (f.candidate as Partial<Candidate>).review,
    (f) => {
      f.candidate.review!.candidateDigest = "0".repeat(64);
    },
    (f) => {
      (f.candidate.review as unknown as { verdict: string }).verdict = "maybe";
    },
    (f) => delete (f.candidate as Partial<Candidate>).reviewExecution,
    (f) => {
      f.candidate.reviewExecution!.modelDigest = "other";
    },
    (f) => {
      (f.model.configuration as unknown as { reviewer: undefined }).reviewer =
        undefined;
    },
    (f) => {
      f.candidate.reviewExecution!.reviewerId = "other-reviewer";
    },
    (f) => {
      (f.model.identity as unknown as { reviewerId: undefined }).reviewerId =
        undefined;
    },
    (f) => {
      f.candidate.reviewExecution!.actionId = "unknown-action";
    },
    (f) => {
      f.candidate.tests!.checks[0].detail = "changed";
    },
    (f) => {
      f.model.contracts[0].acceptanceCriteria = ["changed"];
    },
  ];
  for (const mutate of cases) {
    const f = await reviewedFixture();
    mutate(f);
    const host = hostFixture(f.model, [f.candidate]);
    let error: unknown;
    try {
      await exactReview.call(host, f.model, f.candidate);
    } catch (e) {
      error = e;
    }
    ok(
      error instanceof Error,
      "exactReview must reject the mutated fixture",
    );
    ok(error.message.includes("revue native"));
  }
});

// --- artifactEvidence() ---

Deno.test("promotion/artifactEvidence reports content match without activation", async () => {
  const model = modelFixture();
  const c = await testedCandidate();
  const host = hostFixture(model, [c]);
  const evidence = await artifactEvidence.call(host, c, model);
  equal(evidence.contentDigestMatches, true);
  equal(evidence.activationConfirmed, false);
  equal(evidence.localStage, "awaiting-admission");
  equal(evidence.nativeStatus, undefined);
});

Deno.test("promotion/artifactEvidence confirms only the exact active entry", async () => {
  const model = modelFixture();
  const c = await testedCandidate({ stage: "active" });
  c.admission = {
    candidateId: c.id,
    candidateDigest: c.digest,
    mandateRevision: 1,
    authority: "human",
    actorId: "human",
    configurationRevision: model.configuration.revision,
    reason: "admitted",
    at: AT,
  };
  model.catalog.push({
    nativeId: "native-c1",
    candidateId: c.id,
    digest: c.digest,
    name: c.name,
    kind: c.kind,
    contractId: model.contracts[0].nativeId,
    status: "active",
  });
  const host = hostFixture(model, [c]);
  // Pin the host execution model to the same digest.
  host.state.executionModel!.version.digest = model.version.digest;
  const evidence = await artifactEvidence.call(host, c, model);
  equal(evidence.activationConfirmed, true);
  equal(evidence.nativeStatus, "active");
  deepStrictEqual(evidence.nativeModelVersion, {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  });
});

Deno.test("promotion/artifactEvidence flags a changed draft", async () => {
  const model = modelFixture();
  const c = await testedCandidate();
  c.code += "\n// changed";
  const host = hostFixture(model, [c]);
  const evidence = await artifactEvidence.call(host, c, model);
  equal(evidence.contentDigestMatches, false);
  equal(evidence.activationConfirmed, false);
});

// --- activate() ---

Deno.test("promotion/activate refuses a changed candidate, base or tests", async () => {
  const changed = await testedCandidate();
  changed.code += "\n// changed";
  for (
    const mutate of [
      () => Promise.resolve(changed),
      () => testedCandidate({ baseCatalogRevision: 99 }),
      () =>
        testedCandidate({
          tests: { passed: false, checks: [] },
        }),
      () => testedCandidate({ tests: undefined }),
    ]
  ) {
    const c = await mutate();
    const host = hostFixture(modelFixture(), [c]);
    let error: unknown;
    try {
      await activate.call(host, "c1", "human", "Admit");
    } catch (e) {
      error = e;
    }
    ok(error instanceof Error);
    equal(error.message, "Le candidat ou sa base a changé depuis la revue.");
  }
});

Deno.test("promotion/activate refuses a duplicate active name", async () => {
  const first = await testedCandidate({ id: "a", name: "same" });
  first.stage = "active";
  const second = await testedCandidate({ id: "c1", name: "same" });
  const host = hostFixture(modelFixture(), [first, second]);
  let error: unknown;
  try {
    await activate.call(host, "c1", "human", "Admit");
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("porte déjà ce nom"));
});

Deno.test("promotion/activate under reviewer revalidates the exact review", async () => {
  const { model, candidate: c } = await reviewedFixture("approve");
  c.stage = "awaiting-admission";
  // Break the proof: reviewer activation must fail before admission.
  c.reviewExecution!.modelDigest = "other";
  const host = hostFixture(model, [c]);
  let error: unknown;
  try {
    await activate.call(host, "c1", "reviewer", "Admit");
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("revue native"));
});

Deno.test("promotion/activate admits and publishes a human candidate", async () => {
  const model = modelFixture();
  const c = await testedCandidate();
  const feedbacks: string[] = [];
  const publications: string[] = [];
  const host = hostFixture(model, [c], { feedbacks, publications });
  await activate.call(host, "c1", "human", "Admit the exact candidate");
  const stored = host.state.candidates[0]!;
  equal(stored.stage, "active");
  equal(stored.admission?.authority, "human");
  equal(stored.admission?.candidateDigest, stored.digest);
  ok(
    host.state.events.some((e) => e.kind === "tool-admitted"),
    "admission event",
  );
  ok(
    host.state.events.some((e) => e.kind === "tool-activating"),
    "activating event",
  );
  ok(host.state.events.some((e) => e.kind === "tool-active"), "active event");
  deepStrictEqual(publications, ["c1"]);
  equal(feedbacks.length, 1);
  ok(feedbacks[0].includes("ACTIF"));
  ok(feedbacks[0].includes("c1"));
});

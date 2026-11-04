// deno-lint-ignore-file require-await -- Async port doubles preserve promise failure contracts.
import { sourceCompilation } from "../../../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { strict as assert } from "node:assert";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { ModelPublicationError } from "./service.ts";
import { toolDraftDigest } from "../../work/artifacts/catalog.ts";
import {
  exerciseOwnerAuthority,
  legacyOwnerAuthority,
  mainExecutionSpace,
} from "../../../domain/governance/authority.ts";
import {
  type CandidateActivationPublication,
  changePublication,
} from "../../../domain/model/publication/change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { SystemGovernance } from "../../../domain/governance/policies/governance.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import {
  delegatedCandidateAuthorityExercise,
  toolAdmissionPreparation,
} from "../../../domain/governance/policies/tool-admission-policy.ts";
import { compareModelSources } from "../revisions/source-diff.ts";
import { NativeModelPublicationRevalidator } from "./revalidation.ts";

const unitProjectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
function conversationElements(count: number): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [{
    "@id": "package",
    "@type": "Package",
    declaredName: "AssemblyLiveBuilder",
    qualifiedName: "AssemblyLiveBuilder",
  }, {
    "@id": "system-type",
    "@type": "PartDefinition",
    declaredName: "ConversationSystem",
    qualifiedName: "AssemblyLiveBuilder::ConversationSystem",
    owner: { "@id": "package" },
  }];
  for (let index = 0; index < count; index++) {
    const system = `system-${index}`,
      scope = `AssemblyLiveBuilder::unit_${index}`;
    result.push({
      "@id": system,
      "@type": "PartUsage",
      declaredName: `unit_${index}`,
      qualifiedName: scope,
      owner: { "@id": "package" },
      type: [{ "@id": "system-type" }],
    });
    for (const member of ["builder", "catalog"]) {
      result.push({
        "@id": `${system}-${member}`,
        "@type": "PartUsage",
        declaredName: member,
        qualifiedName: `${scope}::${member}`,
        owner: { "@id": system },
      });
    }
  }
  return result;
}

Deno.test("queued creation refuses the technical registry overflow before compiling synthetic native units", async () => {
  const f = await fixture();
  const change: PendingChange = {
    ...f.change,
    kind: "operator-creation",
    role: "operator",
    name: "Extra operator",
    requestedRights: undefined,
    operator: {
      instruction: "Own bounded work.",
      networkHosts: [],
      requestType: { name: "Research", maxInvocations: 1 },
      firstRequest: { objective: "Answer once." },
    },
  };
  let validations = 0;
  const revalidator = new NativeModelPublicationRevalidator(
    unitProjectId,
    () => {
      validations++;
      throw new Error("VALIDATION_REACHED");
    },
    sourceCompilation,
  );
  await assert.rejects(
    () =>
      revalidator.revalidate({
        approval: f.approval,
        executionBase: { ...f.base, elements: conversationElements(64) },
        candidate: { ...f.candidate, elements: conversationElements(65) },
        edits: [edit],
        change,
      }),
    /technical registry limit of 64/,
  );
  assert.equal(validations, 0);
  await assert.rejects(
    () =>
      revalidator.revalidate({
        approval: f.approval,
        executionBase: { ...f.base, elements: conversationElements(63) },
        candidate: { ...f.candidate, elements: conversationElements(64) },
        edits: [edit],
        change,
      }),
    /VALIDATION_REACHED/,
  );
  assert.equal(validations, 1);
});

function assertEquals(actual: unknown, expected: unknown): void {
  assert.equal(actual, expected);
}
async function assertRejects(
  work: () => Promise<unknown>,
  name: string,
  message: string,
) {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof Error && error.name === name &&
      error.message.includes(message),
  );
}
const edit = {
  op: "setFeatureValue" as const,
  target: {
    id: "x",
    qualifiedName: "A::x",
    metaclass: "Feature",
    preimage: "before",
  },
  value: "y",
};

const systemId = "ASELiveBuilder::liveBuilder";
const digest = "a".repeat(64);
function model(
  version: string,
  revision: number,
  mandateRevision: number,
): ExecutableModel {
  return {
    identity: { systemId, builderId: "builder" },
    version: { digest, repositoryVersion: version },
    configuration: {
      id: "config",
      revision,
      envelope: {
        kind: "conversational-case-management",
        pattern: "1.3",
        revision: 1,
      },
      builder: { id: "builder", mandateRevision, admissionAuthority: "human" },
      network: { allowedHosts: [] },
      changes: [],
    },
    policy: {
      mayAddNetworkHosts: true,
      mayChangeUrlSelection: true,
      urlSelectionMode: "user-provided",
    },
    catalog: [],
  } as unknown as ExecutableModel;
}
async function revision(
  version: string,
  source: string,
): Promise<ModelRevision> {
  const sources = { "model.sysml": source };
  return {
    version,
    sources,
    sourceDigest: await modelSourceDigest(sources),
    elements: [],
    documents: [],
    semanticDigest: "",
    provenanceDigest: "",
    sourceHashes: {},
    engineVersion: "test",
  };
}
async function fixture() {
  const base = await revision("base-1", "package A;\n");
  const candidate = await revision("base-1", "package B;\n");
  const before = model("base-1", 2, 2);
  const after = model("base-1", 3, 3);
  const diff = compareModelSources(base.sources, candidate.sources);
  const change: PendingChange = {
    id: "change-1",
    kind: "mandate-change",
    status: "approved",
    reason: "selection",
    requestedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-02T00:00:00.000Z",
    baseRevision: 2,
    baseModelDigest: digest,
    authority: "human",
    authorityExercise: exerciseOwnerAuthority(before, "mandate-change"),
    requestedRights: { setUrlSelectionMode: "authorized-host" },
    diff: {
      title: "selection",
      author: "owner",
      base: {
        repositoryVersion: base.version,
        modelDigest: digest,
        sourceDigest: base.sourceDigest,
      },
      sourceDigest: candidate.sourceDigest,
      ...diff,
    },
  };
  after.policy.urlSelectionMode = "authorized-host";
  const approval = changePublication(change, before.version);
  const validate = async (revision: ModelRevision) =>
    revision === base ? before : after;
  const revalidator = new NativeModelPublicationRevalidator(
    "project",
    validate,
    sourceCompilation,
  );
  return { base, candidate, before, after, change, approval, revalidator };
}

Deno.test("approved change revalidates its durable decision and displayed exact sources", async () => {
  const f = await fixture();
  const evidence = await f.revalidator.revalidate({
    approval: f.approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
    change: f.change,
  });
  assertEquals(evidence.baseUnchanged, true);
  assertEquals(evidence.authorityStillValid, true);
  assertEquals(evidence.scopeDigest.length, 64);
});

Deno.test("changed repository base needs a new decision, never an implicit reapproval", async () => {
  const f = await fixture();
  const moved = { ...f.base, version: "later" };
  await assertRejects(
    () =>
      f.revalidator.revalidate({
        approval: f.approval,
        executionBase: moved,
        candidate: f.candidate,
        edits: [edit],
        change: f.change,
      }),
    "ModelPublicationError",
    "APPROVED_BASE_CHANGED",
  );
});

Deno.test("an unrelated publication before preview preserves the old execution pin and approves only the exact shown source base", async () => {
  const f = await fixture();
  const approval = changePublication(f.change, {
    ...f.before.version,
    repositoryVersion: "actual-old-execution-pin",
  });
  assert.equal(
    approval.adoptedPin.repositoryVersion,
    "actual-old-execution-pin",
  );
  assert.equal(approval.approvedSourceBase!.repositoryVersion, f.base.version);
  const input = {
    approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
    change: f.change,
  };
  assert.equal(
    (await f.revalidator.revalidate(input)).authorityStillValid,
    true,
  );
  await assert.rejects(
    () =>
      f.revalidator.revalidate({
        ...input,
        executionBase: { ...f.base, version: "publication-after-preview" },
      }),
    /APPROVED_BASE_CHANGED/,
  );
  const legacy = { ...approval };
  delete legacy.approvedSourceBase;
  await assert.rejects(
    () => f.revalidator.revalidate({ ...input, approval: legacy }),
    /APPROVED_BASE_CHANGED/,
  );
});

Deno.test("separate source pins still reject changed source hash, target digest, configuration and owner authority", async (t) => {
  for (
    const kind of ["source", "digest", "configuration", "authority"] as const
  ) {
    await t.step(kind, async () => {
      const f = await fixture();
      const approval = changePublication(f.change, {
        ...f.before.version,
        repositoryVersion: "actual-old-execution-pin",
      });
      if (kind === "source") {
        approval.approvedSourceBase!.sourceDigest = "f".repeat(64);
      }
      if (kind === "digest") f.before.version.digest = "f".repeat(64);
      if (kind === "configuration") f.before.configuration.revision++;
      if (kind === "authority") {
        f.before.ownerAuthority = {
          ...legacyOwnerAuthority(systemId),
          operatorId: "another-owner",
        };
      }
      await assert.rejects(
        () =>
          f.revalidator.revalidate({
            approval,
            executionBase: f.base,
            candidate: f.candidate,
            edits: [edit],
            change: f.change,
          }),
        /APPROVED_SOURCE_BASE_MISMATCH|APPROVED_MODEL_MISMATCH|APPROVAL_AUTHORITY_INVALID/,
      );
    });
  }
});

Deno.test("altered candidate sources and missing durable change cannot reuse approval", async () => {
  const f = await fixture();
  const args = {
    approval: f.approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
  };
  await assertRejects(
    () => f.revalidator.revalidate(args),
    "ModelPublicationError",
    "DURABLE_CHANGE_MISSING",
  );
  await assertRejects(
    () =>
      f.revalidator.revalidate({
        ...args,
        change: f.change,
        candidate: {
          ...f.candidate,
          sources: { "model.sysml": "package C;\n" },
        },
      }),
    "ModelPublicationError",
    "SOURCE_DIGEST_MISMATCH",
  );
});

Deno.test("a changed displayed patch or executable effect needs explicit resolution", async () => {
  const f = await fixture();
  const input = {
    approval: f.approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
    change: f.change,
  };
  f.change.diff!.patch = "different displayed patch";
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "DISPLAYED_CHANGE_MISMATCH",
  );
  f.change.diff!.patch =
    compareModelSources(f.base.sources, f.candidate.sources).patch;
  f.after.configuration.builder.mandateRevision = 4;
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "CHANGE_EFFECT_MISMATCH",
  );
});

Deno.test("activation requires same contract and the exact active catalog candidate", async () => {
  const f = await fixture();
  const draft = {
    name: "Tool",
    description: "read",
    kind: "read_web_page" as const,
    code: "export default () => ({title: '', text: ''});",
  };
  const candidateDigest = await toolDraftDigest(draft);
  f.after.version.digest = digest;
  f.after.configuration.revision = 2;
  f.after.configuration.builder.mandateRevision = 2;
  f.after.policy.urlSelectionMode = "user-provided";
  f.after.catalog = [{
    nativeId: "n1",
    candidateId: "candidate-1",
    digest: candidateDigest,
    contractId: "tool",
    name: "Tool",
    kind: "read_web_page",
    status: "active",
  }] as ExecutableModel["catalog"];
  f.after.contracts = [{
    nativeId: "tool",
    kind: "read_web_page",
    module: "default({url,html}) => {title,text}",
    acceptanceCriteria: [],
  }];
  const approval: CandidateActivationPublication = {
    type: "candidate-activation",
    changeId: "activation-1",
    systemId,
    builderId: "builder",
    candidateId: "candidate-1",
    candidateDigest,
    admission: {
      candidateId: "candidate-1",
      candidateDigest,
      configurationRevision: 2,
      mandateRevision: 2,
      authority: "human",
      actorId: "owner",
      reason: "approved",
      at: "2026-01-02T00:00:00.000Z",
    },
    baseModelDigest: digest,
    baseRevision: 2,
    adoptedPin: { digest, repositoryVersion: f.base.version },
    decidedAt: "2026-01-02T00:00:00.000Z",
    edits: [],
  };
  const activationCandidate: Candidate = {
    id: "candidate-1",
    digest: candidateDigest,
    ...draft,
    stage: "activating",
    createdAt: "2026-01-01T00:00:00.000Z",
    baseCatalogRevision: 0,
    activationModelDigest: digest,
    tests: {
      passed: true,
      checks: [{ name: "native", passed: true, detail: "ok" }],
    },
    admission: structuredClone(approval.admission),
  };
  const input = {
    approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
    activationCandidate,
  };
  assertEquals(
    (await f.revalidator.revalidate(input)).authorityStillValid,
    true,
  );
  f.after.catalog = [];
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "ACTIVATION_CANDIDATE_MISMATCH",
  );
  f.after.catalog = [{
    nativeId: "n1",
    candidateId: "candidate-1",
    digest: candidateDigest,
    contractId: "tool",
    name: "Tool",
    kind: "read_web_page",
    status: "active",
  }];
  await assertRejects(
    () =>
      f.revalidator.revalidate({ ...input, activationCandidate: undefined }),
    "ModelPublicationError",
    "DURABLE_ACTIVATION_CANDIDATE_MISSING",
  );
  activationCandidate.tests!.passed = false;
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "ACTIVATION_CANDIDATE_PROOF_MISMATCH",
  );
  activationCandidate.tests!.passed = true;
  activationCandidate.name = "Other";
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "ACTIVATION_CANDIDATE_PROOF_MISMATCH",
  );
  activationCandidate.name = "Tool";
  activationCandidate.admission!.reason = "different decision";
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "ACTIVATION_CANDIDATE_PROOF_MISMATCH",
  );
  activationCandidate.admission = structuredClone(approval.admission);
  activationCandidate.requiredAuthority = "human";
  await assertRejects(
    () => f.revalidator.revalidate(input),
    "ModelPublicationError",
    "ACTIVATION_NATIVE_BINDING_MISMATCH",
  );
});

async function delegatedActivationFixture() {
  const f = await fixture();
  f.before.ownerAuthority = {
    ...legacyOwnerAuthority(systemId),
    ownerSource: "modeled",
  };
  f.before.contracts = [{
    nativeId: "tool",
    kind: "read_web_page",
    module: "default({url,html}) => {title,text}",
    acceptanceCriteria: ["Extract the exact page title and text"],
  }];
  f.before.toolAdmissionPolicies = [{
    id: "tool-admission",
    revision: 1,
    elementId: "tool-admission-policy",
    sourceIds: ["tool-admission-policy"],
    rootAuthority: structuredClone(f.before.ownerAuthority),
    holderNativeId: "main-builder",
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    enabled: true,
    recipients: ["builder"],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
  }];
  Object.assign(f.after, structuredClone(f.before));
  const draft = {
    name: "Tool",
    description: "read",
    kind: "read_web_page" as const,
    code: "export default () => ({title: '', text: ''});",
  };
  const candidateDigest = await toolDraftDigest(draft);
  const activationCandidate: Candidate = {
    ...draft,
    id: "delegated-candidate",
    digest: candidateDigest,
    stage: "activating",
    createdAt: "2026-01-01T00:00:00.000Z",
    baseCatalogRevision: 0,
    caseId: "request-case",
    requiredAuthority: "human",
    proposedConfigurationRevision: 2,
    promotionModelDigest: digest,
    activationModelDigest: digest,
    toolAdmissionPolicyPins: toolAdmissionPreparation(
      f.before,
      draft.kind,
      mainExecutionSpace(f.before.identity),
    ),
    toolAdmissionContract: structuredClone(f.before.contracts[0]),
    tests: {
      passed: true,
      checks: [{ name: "native", passed: true, detail: "exact page" }],
    },
  };
  const authorityExercise = delegatedCandidateAuthorityExercise(
    f.before,
    activationCandidate,
    { actorId: "main-builder", policyId: "tool-admission", policyRevision: 1 },
    mainExecutionSpace(f.before.identity),
  );
  activationCandidate.admissionDecision = {
    candidateDigest,
    verdict: "approve",
    reason: "Exact tested tool",
    authorityExercise: structuredClone(authorityExercise),
  };
  activationCandidate.admission = {
    candidateId: activationCandidate.id,
    candidateDigest,
    configurationRevision: 2,
    mandateRevision: 2,
    authority: "delegate",
    actorId: "main-builder",
    reason: "Exact tested tool",
    at: "2026-01-02T00:00:00.000Z",
    authorityExercise,
  };
  f.after.catalog = [{
    nativeId: "n1",
    candidateId: activationCandidate.id,
    digest: candidateDigest,
    contractId: "tool",
    name: draft.name,
    kind: draft.kind,
    status: "active",
  }];
  f.candidate.elements = [
    ["requiredAuthority", "LiteralString", "human"],
    ["configurationRevision", "LiteralInteger", 2],
  ].flatMap(([name, kind, value]) => [{
    "@id": `${name}-attribute`,
    "@type": "AttributeUsage",
    declaredName: name,
    owner: { "@id": "n1" },
  }, {
    "@id": `${name}-assignment`,
    "@type": "FeatureValue",
    featureWithValue: { "@id": `${name}-attribute` },
    value: { "@id": `${name}-literal` },
  }, {
    "@id": `${name}-literal`,
    "@type": kind,
    value,
  }]);
  const approval: CandidateActivationPublication = {
    type: "candidate-activation",
    changeId: "delegated-activation",
    systemId,
    builderId: "builder",
    candidateId: activationCandidate.id,
    candidateDigest,
    admission: structuredClone(activationCandidate.admission),
    baseModelDigest: digest,
    baseRevision: 2,
    adoptedPin: { digest, repositoryVersion: f.base.version },
    decidedAt: activationCandidate.admission.at,
    edits: [],
  };
  const input = {
    approval,
    executionBase: f.base,
    candidate: f.candidate,
    edits: [edit],
    activationCandidate,
  };
  return { ...f, input, activationCandidate, approval };
}

type DelegatedActivationFixture = Awaited<
  ReturnType<typeof delegatedActivationFixture>
>;

Deno.test("local activation preserves human, builder and reviewer admissions under their own mandates", async (t) => {
  for (const authority of ["human", "builder", "reviewer"] as const) {
    await t.step(authority, async () => {
      const f = await delegatedActivationFixture();
      const configuration = structuredClone(f.before.configuration);
      configuration.builder.admissionAuthority = authority;
      if (authority === "reviewer") {
        configuration.reviewer = {
          id: "local-reviewer",
          name: "Exact candidate reviewer",
          mandateRevision: 4,
        };
      }
      const localModel = executableFixture({
        projectId: "project",
        editingContextId: "editing-context",
        rootId: "root",
        systemId,
        catalogId: "catalog",
        builderId: "builder",
        ...(authority === "reviewer" ? { reviewerId: "local-reviewer" } : {}),
      }, configuration);
      localModel.version.digest = digest;
      localModel.version.repositoryVersion = f.base.version;
      const activeCatalog = f.after.catalog;
      activeCatalog[0].contractId = localModel.contracts.find((contract) =>
        contract.kind === f.activationCandidate.kind
      )!.nativeId;
      delete f.before.toolAdmissionPolicies;
      delete f.after.toolAdmissionPolicies;
      Object.assign(f.before, localModel);
      Object.assign(f.after, structuredClone(localModel), {
        catalog: activeCatalog,
      });
      const candidate = f.activationCandidate;
      candidate.requiredAuthority = authority;
      candidate.stage = authority === "human"
        ? "awaiting-admission"
        : "reviewing";
      delete candidate.admission;
      delete candidate.admissionDecision;
      delete candidate.toolAdmissionPolicyPins;
      delete candidate.toolAdmissionContract;
      if (authority === "builder") {
        candidate.admissionDecision = {
          candidateDigest: candidate.digest,
          verdict: "approve",
          reason: "Builder accepted the exact tested candidate",
        };
      } else if (authority === "reviewer") {
        candidate.review = {
          candidateDigest: candidate.digest,
          verdict: "approve",
          reason: "Reviewer accepted the exact tested candidate",
        };
      }
      candidate.admission = SystemGovernance.fromExecutable(f.before).admission(
        candidate,
        authority,
        "Exact tested local candidate",
        f.approval.decidedAt,
      );
      assertEquals(
        candidate.admission.actorId,
        authority === "reviewer" ? "local-reviewer" : authority,
      );
      assertEquals(
        candidate.admission.mandateRevision,
        authority === "reviewer" ? 4 : configuration.builder.mandateRevision,
      );
      candidate.stage = "activating";
      f.approval.admission = structuredClone(candidate.admission);
      f.candidate.elements.find((element) =>
        element["@id"] === "requiredAuthority-literal"
      )!.value = authority;
      assertEquals(
        (await f.revalidator.revalidate(f.input)).authorityStillValid,
        true,
      );
    });
  }
});

async function assertDelegationRefused(f: DelegatedActivationFixture) {
  // Keep the publication receipt consistent with the durable admission so the
  // delegation check, rather than their common equality guard, is exercised.
  f.approval.admission = structuredClone(f.activationCandidate.admission!);
  await assert.rejects(
    () => f.revalidator.revalidate(f.input),
    (error: unknown) =>
      error instanceof ModelPublicationError && error.code === "REFUSED" &&
      error.context.reason === "ACTIVATION_ADMISSION_MISMATCH" &&
      error.context.changeId === f.approval.changeId,
  );
}

Deno.test("a delegated activation revalidates its exact prior grant and immutable decision", async () => {
  const f = await delegatedActivationFixture();
  const before = structuredClone({
    approval: f.approval,
    candidate: f.activationCandidate,
  });
  const evidence = await f.revalidator.revalidate(f.input);
  assertEquals(evidence.authorityStillValid, true);
  assertEquals(evidence.baseUnchanged, true);
  assertEquals(evidence.scopeDigest.length, 64);
  assert.deepEqual(f.approval, before.approval);
  assert.deepEqual(f.activationCandidate, before.candidate);
});

Deno.test("delegated activation refuses missing or tampered authority receipts", async (t) => {
  const cases: [string, (f: DelegatedActivationFixture) => void][] = [
    ["missing decision", (f) => delete f.activationCandidate.admissionDecision],
    [
      "missing decision exercise",
      (f) => delete f.activationCandidate.admissionDecision!.authorityExercise,
    ],
    [
      "missing decision proof",
      (f) =>
        delete f.activationCandidate.admissionDecision!.authorityExercise!
          .candidateDelegation,
    ],
    [
      "missing admission proof",
      (f) =>
        delete f.activationCandidate.admission!.authorityExercise!
          .candidateDelegation,
    ],
    [
      "changed actor",
      (f) => f.activationCandidate.admission!.actorId = "other-builder",
    ],
    [
      "changed mandate revision",
      (f) => f.activationCandidate.admission!.mandateRevision = 3,
    ],
    [
      "changed decision reason",
      (f) =>
        f.activationCandidate.admissionDecision!.reason = "Another decision",
    ],
    [
      "refused decision",
      (f) => f.activationCandidate.admissionDecision!.verdict = "refuse",
    ],
    [
      "changed proof candidate digest",
      (f) =>
        f.activationCandidate.admissionDecision!.authorityExercise!
          .candidateDelegation!.candidateDigest = "b".repeat(64),
    ],
    [
      "changed proof issuer",
      (f) =>
        f.activationCandidate.admissionDecision!.authorityExercise!
          .candidateDelegation!.policyIssuer.rootGrantId = "other-grant",
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const f = await delegatedActivationFixture();
      mutate(f);
      await assertDelegationRefused(f);
    });
  }
});

Deno.test("delegation in either receipt cannot be relabelled as local authority", async (t) => {
  for (const authority of ["human", "builder", "reviewer"] as const) {
    await t.step(`${authority} label with both proofs`, async () => {
      const f = await delegatedActivationFixture();
      f.activationCandidate.admission!.authority = authority;
      await assertDelegationRefused(f);
    });
  }
  for (const proof of ["decision", "admission"] as const) {
    await t.step(`human label with only the ${proof} proof`, async () => {
      const f = await delegatedActivationFixture();
      f.activationCandidate.admission!.authority = "human";
      if (proof === "decision") {
        delete f.activationCandidate.admission!.authorityExercise!
          .candidateDelegation;
      } else {
        delete f.activationCandidate.admissionDecision!.authorityExercise!
          .candidateDelegation;
      }
      await assertDelegationRefused(f);
    });
    await t.step(`human label with malformed ${proof} proof`, async () => {
      const f = await delegatedActivationFixture();
      const decisionExercise = f.activationCandidate.admissionDecision!
        .authorityExercise!;
      const admissionExercise = f.activationCandidate.admission!
        .authorityExercise!;
      f.activationCandidate.admission!.authority = "human";
      delete decisionExercise.candidateDelegation;
      delete admissionExercise.candidateDelegation;
      Object.assign(
        proof === "decision" ? decisionExercise : admissionExercise,
        {
          candidateDelegation: null,
        },
      );
      await assertDelegationRefused(f);
    });
  }
});

Deno.test("delegated activation checks policy validity against the approved base", async (t) => {
  const cases: [string, (f: DelegatedActivationFixture) => void][] = [
    ["missing policy", (f) => delete f.before.toolAdmissionPolicies],
    [
      "revoked policy",
      (f) => f.before.toolAdmissionPolicies![0].enabled = false,
    ],
    ["superseded policy", (f) => f.before.toolAdmissionPolicies![0].revision++],
    [
      "wrong recipient",
      (f) =>
        f.before.toolAdmissionPolicies![0].recipients = ["another-builder"],
    ],
    [
      "wrong tool kind",
      (f) =>
        f.before.toolAdmissionPolicies![0].toolKinds = [
          "read_web_page_outline",
        ],
    ],
    [
      "wrong holder",
      (f) =>
        f.before.toolAdmissionPolicies![0].holderNativeId = "another-builder",
    ],
    [
      "wrong native policy",
      (f) => f.before.toolAdmissionPolicies![0].elementId = "another-policy",
    ],
    [
      "changed tested contract",
      (f) => f.before.contracts[0].acceptanceCriteria = ["Different output"],
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const f = await delegatedActivationFixture();
      mutate(f);
      await assertDelegationRefused(f);
    });
  }
});

Deno.test("delegated activation binds preparation pins, tests, Case and contract", async (t) => {
  const cases: [string, (f: DelegatedActivationFixture) => void][] = [
    [
      "missing preparation pins",
      (f) => delete f.activationCandidate.toolAdmissionPolicyPins,
    ],
    [
      "wrong pinned revision",
      (f) => f.activationCandidate.toolAdmissionPolicyPins![0].policyRevision++,
    ],
    [
      "wrong pinned holder",
      (f) =>
        f.activationCandidate.toolAdmissionPolicyPins![0].holderNativeId =
          "other",
    ],
    [
      "wrong pinned native policy",
      (f) =>
        f.activationCandidate.toolAdmissionPolicyPins![0].policyElementId =
          "other",
    ],
    [
      "changed tests",
      (f) =>
        f.activationCandidate.tests!.checks[0].detail = "Different evidence",
    ],
    ["empty checks", (f) => f.activationCandidate.tests!.checks = []],
    ["missing Case", (f) => delete f.activationCandidate.caseId],
    ["another Case", (f) => f.activationCandidate.caseId = "other-request"],
    [
      "designer scope",
      (f) => f.activationCandidate.designerScopeId = "designer",
    ],
    [
      "stale model pin",
      (f) => f.activationCandidate.promotionModelDigest = "b".repeat(64),
    ],
    [
      "stale configuration pin",
      (f) => f.activationCandidate.proposedConfigurationRevision = 1,
    ],
    [
      "missing tested contract",
      (f) => delete f.activationCandidate.toolAdmissionContract,
    ],
    [
      "changed candidate contract",
      (f) =>
        f.activationCandidate.toolAdmissionContract!.acceptanceCriteria = [
          "Different output",
        ],
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const f = await delegatedActivationFixture();
      mutate(f);
      await assertDelegationRefused(f);
    });
  }
});

Deno.test("a team creation persisted before provision existed is refused with a code, never read through", async () => {
  const f = await fixture();
  const change: PendingChange = {
    ...f.change,
    kind: "operator-creation",
    role: "operator",
    name: "Legacy member",
    requestedRights: undefined,
    requestedBy: "builder",
    caseId: "request-1",
    teamOrigin: { operatorId: "builder", requestId: "request-1" },
    // Pre-E2 shape: hosts at the spec root, no provision.
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
      networkHosts: [],
    } as never,
  };
  const executionBase = { ...f.base, elements: conversationElements(1) };
  const candidate = { ...f.candidate, elements: conversationElements(2) };
  const revalidator = new NativeModelPublicationRevalidator(
    unitProjectId,
    async (revision) => revision === executionBase ? f.before : f.after,
    sourceCompilation,
  );
  await assert.rejects(
    () =>
      revalidator.revalidate({
        approval: changePublication(change, f.before.version),
        executionBase,
        candidate,
        edits: [edit],
        change,
      }),
    (error: unknown) =>
      error instanceof ModelPublicationError &&
      error.code === "NEEDS_DECISION" &&
      error.context.reason === "APPROVAL_AUTHORITY_INVALID" &&
      error.recovery === "refuse",
  );
});

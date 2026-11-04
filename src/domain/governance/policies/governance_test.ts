import {
  assertApprovable,
  ChangeApprovabilityError,
} from "./change-approvability.ts";
import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { SystemGovernance } from "./governance.ts";
import { networkScopeFor } from "./network-policy.ts";
import type { Candidate } from "../../work/candidates.ts";
import type { ChatDecision } from "../../work/dialogue.ts";
import { AuthorityInvariantError, legacyOwnerAuthority } from "../authority.ts";

const origin = { requestedBy: "builder", designerScopeId: "scope" };

const mandate: Extract<ChatDecision, { kind: "propose_mandate_change" }> = {
  kind: "propose_mandate_change",
  text: "Proposition",
  reason: "Autonomie d’admission bornée",
  requestedRights: { mayAdmitOwnCandidates: true },
};
const reviewer: Extract<ChatDecision, { kind: "propose_agent_creation" }> = {
  kind: "propose_agent_creation",
  text: "Proposition",
  name: "Reviewer",
  role: "reviewer",
  reason: "Revue et admission indépendantes",
  mandate: { mayReviewExactCandidate: true, mayAdmitReviewedCandidates: true },
};
const network: typeof mandate = {
  kind: "propose_mandate_change",
  text: "Proposition de portée réseau",
  reason: "Lire l’URL fournie nécessite cet hôte exact.",
  requestedRights: { addNetworkHosts: ["example.net"] },
};
Deno.test("normal governance starts with one builder, human admission and only the conversational envelope", () => {
  const governance = SystemGovernance.fresh("system");
  const initial = governance.snapshot;
  equal(initial.reviewer, undefined);
  equal(initial.builder.admissionAuthority, "human");
  deepStrictEqual(initial.network, { allowedHosts: [] });
  deepStrictEqual(initial.envelope, {
    kind: "conversational-case-management",
    pattern: "1.3",
    revision: 1,
  });
  equal(governance.builderMandate.mayActivate, false);
  equal(governance.builderMandate.mayAdmitOwnCandidates, false);
  for (
    const envelope of [
      { kind: "deterministic-envelope", pattern: "1.1", revision: 1 },
      { kind: "event-triggered-reassessment", pattern: "1.2", revision: 1 },
    ] as const
  ) {
    const unsupported = structuredClone(initial);
    unsupported.envelope = envelope;
    throws(() => SystemGovernance.restore(unsupported), /incohérente/);
  }
  initial.builder.admissionAuthority = "builder";
  throws(
    () => SystemGovernance.restore(initial),
    /révision de mandat approuvée/,
  );
});
Deno.test("governance rejects fabricated extra rights and pending or stale approvals cannot widen authority", () => {
  const governance = SystemGovernance.fresh();
  throws(
    () =>
      governance.propose(
        {
          ...mandate,
          requestedRights: { mayAdmitOwnCandidates: true, mayActivate: true },
        } as typeof mandate,
        "bad",
        "now",
        origin,
      ),
    /Droits demandés/,
  );
  governance.propose(mandate, "request", "now", origin);
  equal(governance.snapshot.builder.admissionAuthority, "human");
  throws(
    () => governance.propose(reviewer, "parallel", "now", origin),
    /attend déjà/,
  );
  throws(() => governance.decideChange("request", 4, true, "later"), /changé/);
  equal(governance.snapshot.changes[0]!.status, "pending");
  governance.decideChange("request", 0, true, "later");
  equal(governance.builderMandate.mayAdmitOwnCandidates, true);
  equal(governance.builderMandate.mayActivate, false);
  equal(governance.snapshot.builder.mandateRevision, 2);
  equal(governance.snapshot.changes[0]!.authority, "human");
  throws(
    () => governance.decideChange("request", 1, true, "again"),
    /n’attend pas/,
  );
});
Deno.test("reviewer creation is a distinct proposal and approval; the execution envelope is preserved", () => {
  const governance = SystemGovernance.fresh();
  const envelope = governance.snapshot.envelope;
  governance.propose(reviewer, "reviewer", "now", origin);
  equal(governance.snapshot.reviewer, undefined);
  governance.decideChange("reviewer", 0, true, "later");
  equal(governance.snapshot.reviewer!.id, "reviewer");
  equal(governance.snapshot.builder.admissionAuthority, "reviewer");
  equal(governance.builderMandate.mayAdmitOwnCandidates, false);
  equal(governance.builderMandate.mayActivate, false);
  deepStrictEqual(governance.snapshot.envelope, envelope);
  throws(
    () => governance.propose(reviewer, "duplicate", "again", origin),
    /ne permet pas/,
  );
});
Deno.test("admission requires nonempty passing test evidence and explicit exact builder decision", () => {
  const governance = SystemGovernance.fresh();
  governance.propose(mandate, "grant", "now", origin);
  governance.decideChange("grant", 0, true, "later");
  const candidate: Candidate = {
    id: "candidate",
    name: "reader",
    description: "reader",
    kind: "read_web_page",
    code: "export default () => ({title:'x',text:'y'})",
    digest: "digest",
    stage: "reviewing",
    createdAt: "now",
    baseCatalogRevision: 0,
    requiredAuthority: "builder",
    proposedConfigurationRevision: 1,
    tests: { passed: true, checks: [] },
  };
  throws(
    () => governance.admission(candidate, "builder", "Accept", "later"),
    /Tous les essais/,
  );
  candidate.tests!.checks.push({
    name: "extraction",
    passed: true,
    detail: "verified",
  });
  throws(
    () => governance.admission(candidate, "builder", "Accept", "later"),
    /décision du constructeur/,
  );
  candidate.admissionDecision = {
    candidateDigest: "other",
    verdict: "approve",
    reason: "Accept",
  };
  throws(
    () => governance.admission(candidate, "builder", "Accept", "later"),
    /candidat exact/,
  );
  candidate.admissionDecision.candidateDigest = "digest";
  const admission = governance.admission(
    candidate,
    "builder",
    "Accept",
    "later",
  );
  equal(admission.mandateRevision, 2);
  equal(admission.configurationRevision, 1);
  equal(admission.candidateDigest, "digest");
  throws(
    () => governance.admission(candidate, "human", "Accept", "later"),
    /mandat d’admission/,
  );
});

Deno.test("network scope is readable and an exact pending patch grants no authority until human admission", () => {
  const governance = SystemGovernance.fresh();
  const baseline = { allowedHosts: [] };
  deepStrictEqual(governance.builderMandate.network, baseline);
  equal(
    governance.builderMandate.supportedChanges.some((change) =>
      change.kind === "propose_mandate_change" &&
      change.requestedRights === "addNetworkHosts" &&
      change.description.includes("human")
    ),
    true,
  );
  const request = structuredClone(network);
  const proposed = governance.propose(request, "network", "now", origin);
  deepStrictEqual(proposed.requestedRights, network.requestedRights);
  if ("addNetworkHosts" in request.requestedRights) {
    request.requestedRights.addNetworkHosts.push("other.example.net");
  }
  deepStrictEqual(governance.snapshot.changes[0]!.requestedRights, {
    addNetworkHosts: ["example.net"],
  });
  deepStrictEqual(governance.builderMandate.network, baseline);
  equal(governance.snapshot.revision, 0);
  throws(() => governance.decideChange("network", 1, true, "later"), /changé/);
  deepStrictEqual(governance.builderMandate.network, baseline);
  const decided = governance.decideChange("network", 0, true, "later");
  equal(decided.authority, "human");
  deepStrictEqual(decided.requestedRights, {
    addNetworkHosts: ["example.net"],
  });
  deepStrictEqual(governance.builderMandate.network.allowedHosts, [
    ...baseline.allowedHosts,
    "example.net",
  ]);
  equal(governance.builderMandate.mayAdmitOwnCandidates, false);
  equal(governance.snapshot.builder.admissionAuthority, "human");
  equal(governance.snapshot.builder.mandateRevision, 2);
  equal(governance.snapshot.revision, 1);
  const restored = SystemGovernance.restore(governance.snapshot);
  deepStrictEqual(
    restored.builderMandate.network,
    governance.builderMandate.network,
  );
  restored.propose(mandate, "admission", "later", origin);
  restored.decideChange("admission", 1, true, "later");
  equal(restored.builderMandate.mayAdmitOwnCandidates, true);
  deepStrictEqual(
    restored.builderMandate.network,
    governance.builderMandate.network,
  );
});

Deno.test("refusal records the network patch without changing permissions and stale saved proposals cannot be admitted", () => {
  const governance = SystemGovernance.fresh();
  const before = governance.snapshot;
  governance.propose(network, "network", "now", origin);
  const pending = governance.snapshot;
  const stale = structuredClone(pending);
  stale.revision = 1;
  const restoredStale = SystemGovernance.restore(stale);
  throws(
    () => restoredStale.decideChange("network", 1, true, "later"),
    /changé/,
  );
  deepStrictEqual(restoredStale.snapshot.network, before.network);
  const restored = SystemGovernance.restore(pending);
  const refused = restored.decideChange("network", 0, false, "later");
  equal(refused.status, "refused");
  deepStrictEqual(refused.requestedRights, network.requestedRights);
  equal(restored.snapshot.revision, 1);
  equal(
    restored.snapshot.builder.mandateRevision,
    before.builder.mandateRevision,
  );
  deepStrictEqual(restored.snapshot.network, before.network);
  restored.propose(network, "retry", "later", origin);
  restored.decideChange("retry", 1, true, "later");
  equal(restored.snapshot.builder.mandateRevision, 2);
});

Deno.test("network revisions preserve reviewer admission and cannot serve as evidence for builder admission", () => {
  const governance = SystemGovernance.fresh();
  governance.propose(reviewer, "reviewer", "now", origin);
  governance.decideChange("reviewer", 0, true, "later");
  governance.propose(network, "network", "later", origin);
  governance.decideChange("network", 1, true, "later");
  equal(governance.snapshot.builder.admissionAuthority, "reviewer");
  equal(governance.snapshot.reviewer!.id, "reviewer");
  equal(governance.builderMandate.mayAdmitOwnCandidates, false);
  const fabricated = SystemGovernance.fresh();
  fabricated.propose(network, "network", "now", origin);
  fabricated.decideChange("network", 0, true, "later");
  const snapshot = fabricated.snapshot;
  snapshot.builder.admissionAuthority = "builder";
  throws(
    () => SystemGovernance.restore(snapshot),
    /révision de mandat approuvée/,
  );
});

Deno.test("network revisions remain available after a separate self-admission grant", () => {
  const governance = SystemGovernance.fresh();
  governance.propose(mandate, "self-admission", "now", origin);
  governance.decideChange("self-admission", 0, true, "later");
  governance.propose(network, "network", "later", origin);
  governance.decideChange("network", 1, true, "later");
  const restored = SystemGovernance.restore(governance.snapshot);
  equal(restored.builderMandate.mayAdmitOwnCandidates, true);
  equal(restored.snapshot.builder.admissionAuthority, "builder");
  equal(restored.snapshot.builder.mandateRevision, 3);
  deepStrictEqual(restored.builderMandate.network.allowedHosts, [
    "example.net",
  ]);
  equal(restored.builderMandate.supportedChanges.length, 1);
  equal(
    restored.builderMandate.supportedChanges[0]!.requestedRights,
    "addNetworkHosts",
  );
});

Deno.test("network requests reject extra rights, duplicates, already allowed hosts and overly broad patches", () => {
  const malformed: unknown[] = [
    {},
    { addNetworkHosts: [] },
    { addNetworkHosts: ["example.net", "example.net"] },
    { addNetworkHosts: ["EXAMPLE.NET"] },
    { addNetworkHosts: ["example.net."] },
    { addNetworkHosts: ["*.example.net"] },
    { addNetworkHosts: ["127.0.0.1"] },
    { addNetworkHosts: ["other.internal"] },
    { addNetworkHosts: ["example.net"], mayAdmitOwnCandidates: true },
    { addNetworkHosts: ["example.net"], mayActivate: true },
    {
      addNetworkHosts: Array.from(
        { length: 9 },
        (_, index) => `host${index}.example.net`,
      ),
    },
  ];
  for (const requestedRights of malformed) {
    const governance = SystemGovernance.fresh();
    throws(() =>
      governance.propose(
        { ...network, requestedRights } as typeof network,
        "bad",
        "now",
        origin,
      )
    );
    equal(governance.snapshot.changes.length, 0);
  }
  const full = SystemGovernance.fresh().snapshot;
  full.network = {
    allowedHosts: Array.from(
      { length: 32 },
      (_, index) => `host${index}.example.net`,
    ),
  };
  const governance = SystemGovernance.restore(full);
  throws(
    () => governance.propose(network, "overflow", "now", origin),
    /trop large/,
  );
  const alreadyAllowed = SystemGovernance.fresh();
  alreadyAllowed.propose(network, "network", "now", origin);
  alreadyAllowed.decideChange("network", 0, true, "later");
  throws(
    () => alreadyAllowed.propose(network, "duplicate", "later", origin),
    /appartient déjà/,
  );
});

Deno.test("legacy configuration restores only the old baseline and rejects malformed persisted authority", () => {
  const legacy = SystemGovernance.fresh().snapshot;
  delete legacy.network;
  deepStrictEqual(
    SystemGovernance.restore(legacy).snapshot.network,
    networkScopeFor(),
  );
  deepStrictEqual(
    SystemGovernance.importLegacy("legacy", "reviewer").snapshot.network,
    networkScopeFor(),
  );
  const governance = SystemGovernance.fresh();
  governance.propose(network, "network", "now", origin);
  const malformed = governance.snapshot;
  malformed.changes[0]!.requestedRights = {
    addNetworkHosts: ["example.net"],
    mayActivate: true,
  } as typeof network.requestedRights;
  throws(() => SystemGovernance.restore(malformed), /Droits demandés/);
});

// Governance consumes an already compiled contract; flow interpretation is tested separately.
function executableFixture(): import("../../model/execution/executable-model.ts").ExecutableModel {
  const legacy = SystemGovernance.fresh("compiled");
  const flow = {
    rootNativeId: "flow",
    rootOccurrenceId: "flow-use",
    name: "fixture",
    source: { file: "fixture.sysml", line: 1 },
    startNodeId: "start",
    maxSteps: 2,
    nodes: [],
    edges: [],
    bindings: [],
  };
  return {
    identity: {
      projectId: "p",
      editingContextId: "e",
      rootId: "r",
      systemId: "s",
      catalogId: "c",
      builderId: "b",
    },
    version: {
      digest: "compiled-v1",
      rootId: "r",
      configurationId: "cfg",
      configurationRevision: 0,
      sourceIds: ["fixture.sysml"],
    },
    configuration: legacy.snapshot,
    mandate: {
      ...legacy.builderMandate,
      id: "source-mandate",
      mayPropose: [],
      supportedChanges: [],
    },
    policy: {
      maxAgentDecisions: 2,
      maxToolProposals: 1,
      maxFlowSteps: 2,
      urlSelectionMode: "user-provided",
      mayAddNetworkHosts: false,
      mayDelegateOwnAdmission: false,
      mayCreateReviewer: false,
      mayChangeUrlSelection: false,
    },
    contracts: [],
    flows: { conversation: flow, promotion: flow },
    catalog: [],
  };
}

Deno.test("compiled mandate and native builder authority require no host grant history", () => {
  const model = executableFixture();
  model.configuration.builder.admissionAuthority = "builder";
  model.mandate.mayAdmitOwnCandidates = true;
  const governance = SystemGovernance.fromExecutable(model);
  deepStrictEqual(governance.builderMandate, model.mandate);
  equal(governance.snapshot.changes.length, 0);
  model.mandate.mayPropose = ["read_web_page"];
  deepStrictEqual(governance.builderMandate.mayPropose, []);
  const invalid = executableFixture();
  invalid.configuration.revision = -1;
  throws(() => SystemGovernance.fromExecutable(invalid), /incohérente/);
});

Deno.test("compiled policy disables each change independently of host defaults", () => {
  const url: typeof mandate = {
    ...mandate,
    requestedRights: { setUrlSelectionMode: "authorized-host" },
  };
  for (const decision of [mandate, network, reviewer, url]) {
    const governance = SystemGovernance.fromExecutable(executableFixture());
    throws(
      () => governance.propose(decision, "denied", "now", origin),
      /modèle|ne permet pas/,
    );
    equal(governance.snapshot.changes.length, 0);
  }
});

Deno.test("compiled-model approval is audit only until a new compiled version grants authority", () => {
  const model = executableFixture();
  model.policy.mayDelegateOwnAdmission = true;
  model.policy.mayAddNetworkHosts = true;
  model.policy.mayCreateReviewer = true;
  model.policy.mayChangeUrlSelection = true;
  for (
    const decision of [mandate, network, reviewer, {
      ...mandate,
      requestedRights: { setUrlSelectionMode: "authorized-host" as const },
    }]
  ) {
    const governance = SystemGovernance.fromExecutable(model);
    const before = governance.snapshot;
    governance.propose(decision, "change", "now", origin);
    deepStrictEqual(governance.builderMandate, model.mandate);
    const audit = governance.decideChange("change", 0, true, "later");
    equal(audit.status, "approved");
    equal(audit.authority, "human");
    const after = governance.snapshot;
    deepStrictEqual({ ...after, changes: [] }, before);
    deepStrictEqual(governance.builderMandate, model.mandate);
    equal(
      SystemGovernance.fromExecutable(model, [audit]).builderMandate
        .mayAdmitOwnCandidates,
      false,
    );
  }
  const compiledNext = structuredClone(model);
  compiledNext.version.digest = "compiled-v2";
  compiledNext.configuration.revision = 1;
  compiledNext.configuration.builder.admissionAuthority = "builder";
  compiledNext.mandate.mayAdmitOwnCandidates = true;
  equal(
    SystemGovernance.fromExecutable(compiledNext).builderMandate
      .mayAdmitOwnCandidates,
    true,
  );
});

Deno.test("compiled admission leaves test outcomes and business stages to native assertions", () => {
  const model = executableFixture();
  model.configuration.builder.admissionAuthority = "builder";
  model.mandate.mayAdmitOwnCandidates = true;
  const governance = SystemGovernance.fromExecutable(model);
  const candidate: Candidate = {
    id: "failed-tests-with-no-native-test-assertion",
    name: "reader",
    description: "reader",
    kind: "read_web_page",
    code: "export default () => ({title:'x',text:'y'})",
    digest: "immutable-digest",
    stage: "failed",
    createdAt: "now",
    baseCatalogRevision: 0,
    requiredAuthority: "builder",
    proposedConfigurationRevision: 0,
    tests: {
      passed: false,
      checks: [{ name: "fixture", passed: false, detail: "failure" }],
    },
    admissionDecision: {
      candidateDigest: "immutable-digest",
      verdict: "approve",
      reason: "Fixture without test assertion",
    },
  };
  equal(
    governance.admission(candidate, "builder", "Native flow admitted", "later")
      .candidateDigest,
    candidate.digest,
  );
  candidate.admissionDecision!.candidateDigest = "different";
  throws(
    () =>
      governance.admission(
        candidate,
        "builder",
        "Native flow admitted",
        "later",
      ),
    /candidat exact/,
  );
  candidate.admissionDecision!.candidateDigest = candidate.digest;
  candidate.proposedConfigurationRevision = 1;
  throws(
    () =>
      governance.admission(
        candidate,
        "builder",
        "Native flow admitted",
        "later",
      ),
    /mandat a changé/,
  );
  candidate.proposedConfigurationRevision = 0;
  throws(
    () =>
      governance.admission(candidate, "human", "Native flow admitted", "later"),
    /mandat d’admission/,
  );
  const human = executableFixture();
  candidate.requiredAuthority = "human";
  equal(
    SystemGovernance.fromExecutable(human).admission(
      candidate,
      "human",
      "Native flow admitted",
      "later",
    ).authority,
    "human",
  );
});

Deno.test("owner decisions retain root provenance and cannot use a different base contract", () => {
  const model = executableFixture();
  model.ownerAuthority = {
    ...legacyOwnerAuthority(model.identity.systemId),
    ownerSource: "modeled",
    mandateId: "owner-mandate",
    rootAuthorityId: "root",
    rootGrantId: "root-grant",
  };
  model.policy.mayDelegateOwnAdmission = true;
  const governance = SystemGovernance.fromExecutable(model);
  const proposal = governance.propose(mandate, "change", "before", origin);
  equal(proposal.baseModelDigest, model.version.digest);
  const approved = governance.decideChange("change", 0, true, "after");
  equal(approved.authorityExercise?.operatorId, "owner");
  equal(approved.authorityExercise?.mandateId, "owner-mandate");
  equal(approved.authorityExercise?.rootGrantId, "root-grant");
  equal(approved.authorityExercise?.ownerSource, "modeled");
  equal(approved.authorityExercise?.outOfMandate, false);
  equal(governance.builderMandate.mayAdmitOwnCandidates, false);
  const changed = structuredClone(model);
  changed.version.digest = "another-contract-at-same-configuration-revision";
  const stale = SystemGovernance.fromExecutable(changed, [proposal]);
  throws(() => stale.decideChange("change", 0, true, "after"), (error) => {
    return error instanceof AuthorityInvariantError &&
      error.code === "AUTHORITY_INVARIANT" && error.invariant === 3;
  });
  equal(stale.snapshot.changes[0]!.status, "pending");
});

Deno.test("legacy human admission explicitly identifies the derived owner", () => {
  const model = executableFixture();
  const governance = SystemGovernance.fromExecutable(model);
  const admission = governance.admission(
    {
      id: "candidate",
      digest: "digest",
      name: "Candidate",
      description: "Test",
      kind: "read_web_page",
      code: "",
      stage: "awaiting-admission",
      createdAt: "before",
      baseCatalogRevision: 0,
    },
    "human",
    "Exact local decision",
    "now",
  );
  equal(admission.authorityExercise?.ownerSource, "implicit-legacy");
  equal(admission.authorityExercise?.operatorId, "owner");
  equal(admission.authorityExercise?.baseModelDigest, model.version.digest);
  equal(admission.authorityExercise?.outOfMandate, false);
});

Deno.test("model approval requires human admission authority and stale proposals remain refusable", () => {
  const base = executableFixture();
  base.policy.mayDelegateOwnAdmission = true;
  const proposed = SystemGovernance.fromExecutable(base).propose(
    mandate,
    "second",
    "now",
    origin,
  );
  const delegated = structuredClone(base);
  delegated.configuration.builder.admissionAuthority = "builder";
  const governance = SystemGovernance.fromExecutable(delegated, [proposed]);
  throws(
    () => governance.decideChange("second", 0, true, "later"),
    (error: unknown) => {
      if (!(error instanceof ChangeApprovabilityError)) return false;
      equal(error.reason, "PROPOSAL_NOT_AUTHORIZED");
      equal(error.context.changeId, "second");
      equal(error.recovery.action, "refuse-and-repropose");
      return true;
    },
  );
  equal(governance.snapshot.changes[0].status, "pending");
  equal(governance.snapshot.changes[0].authorityExercise, undefined);
  equal(governance.decideChange("second", 0, false, "later").status, "refused");
  throws(
    () =>
      SystemGovernance.fromExecutable(delegated).propose(
        mandate,
        "new",
        "now",
        origin,
      ),
    ChangeApprovabilityError,
  );
  delegated.configuration.revision++;
  delegated.version.digest = "changed";
  const stale = SystemGovernance.fromExecutable(delegated, [proposed]);
  throws(
    () => stale.decideChange("second", 0, true, "later"),
    AuthorityInvariantError,
  );
  equal(stale.decideChange("second", 0, false, "later").status, "refused");
});

Deno.test("deciding a superseded proposal fails by name for both verdicts", () => {
  const governance = SystemGovernance.fresh("system");
  const change = governance.propose(network, "overtaken", "now", origin);
  const snapshot = governance.snapshot;
  snapshot.changes[0].status = "superseded";
  const overtaken = SystemGovernance.restore(snapshot);
  for (const approve of [true, false]) {
    throws(
      () => overtaken.decideChange(change.id, 0, approve, "later"),
      (error: unknown) => {
        if (!(error instanceof ChangeApprovabilityError)) return false;
        equal(error.reason, "SUPERSEDED_PROPOSAL");
        equal(error.context.changeId, "overtaken");
        return true;
      },
    );
  }
  equal(overtaken.snapshot.changes[0].status, "superseded");
  equal(
    overtaken.propose(network, "next", "later", origin).status,
    "pending",
  );
});

Deno.test("pending refusal ignores a stale base and grants no authority", () => {
  const initial = SystemGovernance.fresh("system");
  const change = initial.propose(network, "stale", "now", origin);
  const adopted = initial.snapshot;
  adopted.revision++;
  const governance = SystemGovernance.restore(adopted);
  const refused = governance.decideChange(
    change.id,
    adopted.revision,
    false,
    "later",
  );
  equal(refused.status, "refused");
  equal(refused.authorityExercise, undefined);
  deepStrictEqual(governance.snapshot.network, adopted.network);
  deepStrictEqual(governance.snapshot.builder, adopted.builder);
  equal(governance.propose(network, "next", "later", origin).status, "pending");
});

Deno.test("change locking retains the requesting operator and original exclusive scope", () => {
  const governance = SystemGovernance.fresh("system");
  const change = governance.propose(network, "exact", "now", {
    requestedBy: "builder",
    caseId: "request-1",
  });
  equal(change.requestedBy, "builder");
  equal(change.caseId, "request-1");
  equal(change.designerScopeId, undefined);
  throws(
    () =>
      governance.propose(network, "parallel", "later", {
        requestedBy: "builder",
        designerScopeId: "designer",
      }),
    {
      code: "CHANGE_PENDING",
      context: {
        requestedBy: "builder",
        changeId: "exact",
        caseId: "request-1",
      },
      recovery: { action: "await-decision" },
    },
  );
});

Deno.test("missing proposal origin cannot be invented by governance", () => {
  const governance = SystemGovernance.fresh("system");
  throws(() => governance.propose(network, "missing", "now"), {
    code: "CHANGE_SCOPE_MISSING",
    context: { changeId: "missing" },
    recovery: { action: "restore-recorded-scope" },
  });
  const snapshot = governance.snapshot;
  snapshot.changes.push({
    id: "legacy",
    kind: "mandate-change",
    status: "pending",
    baseRevision: 0,
    reason: "Legacy request",
    requestedAt: "then",
    requestedRights: { addNetworkHosts: ["example.org"] },
  });
  const restored = SystemGovernance.restore(snapshot);
  throws(() => restored.decideChange("legacy", 0, true, "now"), {
    code: "CHANGE_SCOPE_MISSING",
  });
  equal(restored.snapshot.changes[0].status, "pending");
  equal(restored.decideChange("legacy", 0, false, "now").status, "refused");
});

Deno.test("operator name bound counts code points under a creation model", () => {
  const operator = (
    name: string,
  ): Extract<ChatDecision, { kind: "propose_agent_creation" }> => ({
    kind: "propose_agent_creation",
    role: "operator",
    name,
    text: "Proposition",
    reason: "Process a Request",
    operator: {
      instruction: "Answer bounded requests.",
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Ask." },
    },
  });
  const model = executableFixture();
  model.policy.mayCreateReviewer = true;
  SystemGovernance.fromExecutable(model).propose(
    operator("😀".repeat(80)),
    "emoji-operator",
    "now",
    origin,
  );
  throws(
    () =>
      SystemGovernance.fromExecutable(model).propose(
        operator("😀".repeat(81)),
        "too-long-operator",
        "now",
        origin,
      ),
    /does not authorize this operator request/,
  );
});

Deno.test("a Request cannot use mayCreateReviewer as an operator creation grant", () => {
  const model = executableFixture();
  model.policy.mayCreateReviewer = true;
  const scope = {
    space: { projectId: "p", systemId: "s", executionSpaceId: "branch" },
    branchTeamSize: 0,
    currentCaseId: "request",
  };
  const legacy: Extract<ChatDecision, { kind: "propose_agent_creation" }> = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Helper",
    text: "Waiting for acceptance",
    reason: "Help this Request",
    operator: {
      instruction: "Answer bounded requests.",
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Ask." },
    },
  };
  for (const proposal of [legacy, reviewer]) {
    throws(
      () => assertApprovable(model, proposal, scope),
      (error) =>
        error instanceof ChangeApprovabilityError &&
        error.reason === "PROPOSAL_NOT_AUTHORIZED",
    );
  }
});

Deno.test("a BO grant proposal and human approval record no creation authority before adoption", () => {
  const model = executableFixture();
  model.ownerAuthority = {
    ...legacyOwnerAuthority(model.identity.systemId),
    ownerSource: "modeled",
  };
  const scope = {
    space: {
      projectId: model.identity.projectId,
      systemId: model.identity.systemId,
      executionSpaceId: "branch",
    },
    branchTeamSize: 0,
    currentCaseId: "request",
  };
  const decision: typeof mandate = {
    kind: "propose_mandate_change",
    text: "Grant request",
    reason: "Create bounded helpers",
    requestedRights: {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 3,
        mode: "autonomous",
      },
    },
  };
  throws(
    () => SystemGovernance.fresh().propose(decision, "grant", "now", origin),
    { code: "AUTHORITY_POLICY_FORBIDDEN" },
  );
  const governance = SystemGovernance.fromExecutable(model, [], scope);
  const proposed = governance.propose(decision, "grant", "now", {
    requestedBy: model.identity.builderId,
    caseId: "request",
  });
  equal(proposed.status, "pending");
  deepStrictEqual(proposed.requestedRights, decision.requestedRights);
  const restored = SystemGovernance.fromExecutable(
    model,
    governance.snapshot.changes,
    scope,
  );
  const approved = restored.decideChange("grant", 0, true, "later");
  equal(approved.status, "approved");
  equal(approved.authority, "human");
  equal(approved.authorityExercise?.creationDelegation, undefined);
  equal(model.operatorCreationPolicies, undefined);
  deepStrictEqual(restored.snapshot.network, model.configuration.network);
});

import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  compareNetworkImpactFrames,
  matchNetworkImpactEvidence,
  NetworkImpactService,
  validateNetworkImpactRequest,
} from "./analysis.ts";
import {
  DEFAULT_NETWORK_IMPACT_LIMITS,
  type NetworkImpactEvidence,
  type NetworkImpactFrame,
  type NetworkImpactPath,
} from "../../../domain/model/consultation/network-impact.ts";
const version = (n: number) => `commit:${String(n).repeat(40)}`;
const input = {
  operatorId: "native-operator",
  host: "example.org",
  fromVersion: version(1),
  toVersion: version(4),
};
function frame(n: number, web = true, skills = true): NetworkImpactFrame {
  const path = (
    channel: NetworkImpactPath["channel"],
    allowed: boolean,
  ): NetworkImpactPath => ({
    id: channel,
    channel,
    hostPermission: allowed ? "allowed" : "denied",
    state: allowed ? "conditional" : "blocked",
    guards: [{
      code: "HOST",
      state: allowed ? "pass" : "fail",
      explanation: "Exact source host",
      witnesses: [{ role: "scope", elementId: `native-${channel}` }],
    }],
    witnesses: [],
    consumer: { symbol: channel, source: "adapter.ts" },
  });
  return {
    version: version(n),
    operatorId: input.operatorId,
    contractDigest: String(n).repeat(64),
    state: "known",
    paths: [path("web", web), path("skill-install", skills)],
    issues: [],
    indirectAccess: "not-covered",
  };
}
const proof = (n = 1): NetworkImpactEvidence => ({
  id: "message-1",
  source: "message",
  kind: "page-received",
  modelVersion: version(n),
  contractDigest: String(n).repeat(64),
  operatorId: input.operatorId,
  host: input.host,
  startOrder: "unknown",
  issues: [],
});

Deno.test("interval analysis preserves temporary and partial withdrawals with exact historical evidence", async () => {
  const states = [frame(1), frame(2, false), frame(3, false, false), frame(4)];
  const calls: string[] = [];
  const service = new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () =>
        Promise.resolve({
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          versions: states.map((entry, i) => ({
            version: entry.version,
            parents: i ? [states[i - 1].version] : [],
          })),
          complete: true,
        }),
    },
    models: {
      read: (v) => {
        calls.push(v);
        return Promise.resolve(states.find((entry) => entry.version === v)!);
      },
    },
    evidence: {
      read: () =>
        Promise.resolve({
          evidence: [proof(), proof(2)],
          complete: true,
          snapshotsRead: 2,
          recordsRead: 2,
          bytesRead: 50,
          issues: [],
        }),
    },
  });
  const report = await service.analyze(input);
  deepStrictEqual(calls, states.map((entry) => entry.version));
  deepStrictEqual(
    report.transitions.map((entry) =>
      entry.changes.map((change) => change.kind)
    ),
    [["permission-revoked", "unchanged"], ["unchanged", "permission-revoked"], [
      "permission-granted",
      "permission-granted",
    ]],
  );
  deepStrictEqual(report.transitions.map((entry) => entry.directAccessAfter), [
    "possible",
    "blocked",
    "possible",
  ]);
  deepStrictEqual(
    report.evidence.map((
      entry,
    ) => [entry.match, entry.policyAtRecordedVersion, entry.startOrder]),
    [["exact-version", "allowed", "unknown"], [
      "exact-version",
      "denied",
      "unknown",
    ]],
  );
  equal(report.coverage.calculationComplete, true);
  equal(report.coverage.networkObservationComplete, false);
  equal(report.coverage.indirectAccess, "not-covered");
});

Deno.test("unknown recipes, missing paths and failed builds never establish a withdrawal", () => {
  for (
    const unknown of [
      { ...frame(2, false, false), state: "unknown" as const },
      { ...frame(2, false, false), paths: [] },
      {
        ...frame(2, false, false),
        issues: [{
          code: "BUILD_RECIPE_UNKNOWN",
          message: "Recipe unavailable",
        }],
      },
    ]
  ) {
    const comparison = compareNetworkImpactFrames(frame(1), unknown);
    equal(comparison.directAccessAfter, "unknown");
    ok(comparison.changes.every((entry) => entry.kind === "indeterminate"));
  }
  const conditional = frame(2);
  conditional.paths[0].guards.push({
    code: "URL_POLICY",
    state: "conditional",
    explanation: "User-selected URL only",
    witnesses: [],
  });
  equal(
    compareNetworkImpactFrames(frame(1), conditional).changes[0].kind,
    "route-changed",
  );
});

Deno.test("evidence joins fail closed on missing actors, mismatched versions and contract-only provenance", () => {
  const states = [frame(1), frame(2, false)];
  const join = (evidence: NetworkImpactEvidence) =>
    matchNetworkImpactEvidence(evidence, states, input.operatorId, input.host);
  equal(join({ ...proof(), operatorId: undefined }).match, "unresolved");
  equal(join({ ...proof(), contractDigest: "wrong" }).match, "unresolved");
  equal(join({ ...proof(), modelVersion: version(8) }).match, "unresolved");
  const historical = join({ ...proof(), modelVersion: undefined });
  equal(historical.match, "contract-only");
  deepStrictEqual(historical.relatedVersions, [version(1)]);
  equal(historical.policyAtRecordedVersion, "unknown");
  equal(
    join({ ...proof(), kind: "context-only" }).policyAtRecordedVersion,
    "unknown",
  );
  equal(
    join({
      ...proof(),
      kind: "skill-operation-unattributed",
      source: "skill-operation",
      host: undefined,
    }).policyAtRecordedVersion,
    "unknown",
  );
});

Deno.test("source-line shifts preserve route semantics while retaining before and after witnesses", () => {
  const before = frame(1);
  const after = frame(2);
  before.paths[0].guards[0].witnesses[0] = {
    role: "scope",
    elementId: "native-web",
    path: "before.sysml",
    line: 10,
    column: 5,
    qualifiedName: "OldName",
  };
  after.paths[0].guards[0].witnesses[0] = {
    role: "scope",
    elementId: "native-web",
    path: "after.sysml",
    line: 44,
    column: 8,
    qualifiedName: "NewName",
  };
  const transition = compareNetworkImpactFrames(before, after);
  equal(transition.changes[0].kind, "unchanged");
  equal(transition.changes[0].before?.guards[0].witnesses[0].line, 10);
  equal(transition.changes[0].after?.guards[0].witnesses[0].line, 44);
  after.paths[0].guards[0].witnesses[0].elementId = "different-native-scope";
  equal(
    compareNetworkImpactFrames(before, after).changes[0].kind,
    "route-changed",
  );
});

Deno.test("exact skill evidence selects the recorded skill host policy independently of web policy", () => {
  const skillProof: NetworkImpactEvidence = {
    ...proof(),
    source: "skill-operation",
    kind: "skill-downloaded",
  };
  for (const [webAllowed, skillAllowed] of [[false, true], [true, false]]) {
    const recorded = frame(1, webAllowed, skillAllowed);
    const result = matchNetworkImpactEvidence(
      skillProof,
      [recorded],
      input.operatorId,
      input.host,
    );
    equal(result.match, "exact-version");
    deepStrictEqual(result.relatedVersions, [version(1)]);
    equal(result.policyAtRecordedVersion, skillAllowed ? "allowed" : "denied");
  }
});

Deno.test("shared composition deadline retains timeout classification in the application service", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("Composition deadline", "TimeoutError"));
  const service = new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () => {
        throw new Error("Must not open");
      },
    },
    models: {
      read: () => {
        throw new Error("Must not read");
      },
    },
  });
  const report = await service.analyze(input, controller.signal);
  ok(report.issues.some((issue) => issue.code === "ANALYSIS_TIMEOUT"));
  ok(!report.issues.some((issue) => issue.code === "ANALYSIS_ABORTED"));
});

Deno.test("partial lineage and absent evidence report separate incomplete coverages", async () => {
  const service = new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () =>
        Promise.resolve({
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          versions: [{ version: version(3), parents: [version(2)] }, {
            version: version(4),
            parents: [version(3), version(8)],
          }],
          complete: false,
          reason: "version-limit",
        }),
    },
    models: { read: (v) => Promise.resolve(frame(Number(v.at(-1)))) },
  });
  const report = await service.analyze(input);
  equal(report.transitions.length, 1);
  equal(report.coverage.calculationComplete, false);
  equal(report.coverage.versionsComplete, false);
  equal(report.coverage.modelReadComplete, true);
  equal(report.coverage.recordsReadComplete, false);
  ok(
    report.issues.some((issue) => issue.code === "SIDE_BRANCHES_NOT_TRAVERSED"),
  );
  equal(report.evidenceRead.complete, false);
});

Deno.test("analysis deadline bounds a non-cooperative reader and preserves unknown frames", async () => {
  const service = new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () =>
        Promise.resolve({
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
          versions: [{ version: version(1), parents: [] }, {
            version: version(4),
            parents: [version(1)],
          }],
          complete: true,
        }),
    },
    models: { read: () => new Promise(() => {}) },
  });
  const report = await service.analyze({ ...input, limits: { timeoutMs: 10 } });
  equal(report.frames.length, 2);
  ok(report.frames.every((entry) => entry.state === "unknown"));
  equal(report.coverage.calculationComplete, false);
  ok(report.issues.some((issue) => issue.code === "ANALYSIS_TIMEOUT"));
});

Deno.test("strict service identities and technical limit ceilings reject ambiguous input", async () => {
  deepStrictEqual(
    validateNetworkImpactRequest(input),
    DEFAULT_NETWORK_IMPACT_LIMITS,
  );
  for (
    const host of [
      "https://example.org",
      "EXAMPLE.org",
      "*.example.org",
      "example.org:443",
      "a..org",
      "x.org/",
      "-bad.org",
      "example.org.",
    ]
  ) throws(() => validateNetworkImpactRequest({ ...input, host }));
  for (const fromVersion of ["HEAD", "admitted", "commit:abcd"]) {
    throws(() => validateNetworkImpactRequest({ ...input, fromVersion }));
  }
  for (const maxVersions of [0, -1, 129, NaN, 1.5]) {
    throws(() =>
      validateNetworkImpactRequest({ ...input, limits: { maxVersions } })
    );
  }
  throws(() =>
    validateNetworkImpactRequest({ ...input, limits: { bogus: 1 } as never })
  );
  const service = new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () => {
        throw new Error("Must not execute");
      },
    },
    models: {
      read: () => {
        throw new Error("Must not execute");
      },
    },
  });
  await rejects(() => service.analyze({ ...input, host: "*" }));
});

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { BoundedNetworkImpactEvidenceRead } from "./evidence-sources.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../../domain/model/consultation/network-impact.ts";
import { LiveNetworkImpactEvidenceReader } from "./live-evidence-reader.ts";

const refs = {
  digest: "contract-1",
  repositoryVersion: "version-1",
  runtime: { digest: "runtime-1" },
  actionId: "observe",
};
const request = {
  operatorId: "operator",
  host: "example.org",
  limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
};
const observation = (id: string, kind: string, value: unknown) => ({
  id,
  role: "tool",
  text: "RAW_MESSAGE_SECRET",
  at: "2026-10-26T00:00:00Z",
  caseId: "delegated-case",
  execution: refs,
  observation: {
    kind,
    value: kind === "tool-result" && value !== null && typeof value === "object"
      ? { title: "Page", text: "PAGE_BODY_SECRET", ...value }
      : value,
  },
});
function snapshot(
  revision: number,
  messages: unknown[],
  events: unknown[] = [],
) {
  return {
    id: "system",
    revision,
    messages,
    events,
    cases: [{
      id: "delegated-case",
      owner: "another-operator",
      modelPin: { digest: "birth-pin", repositoryVersion: "birth-version" },
    }],
    executionModel: {
      version: {
        digest: refs.digest,
        repositoryVersion: refs.repositoryVersion,
      },
      identity: { builderId: "operator" },
      flows: {
        conversation: {
          nodes: [{ nativeId: "observe", performerId: "catalog-gate" }],
        },
      },
    },
  };
}
function skillsCatalog() {
  const version = {
    digest: refs.digest,
    repositoryVersion: refs.repositoryVersion,
  };
  const at = "2026-10-26T00:00:00Z";
  const source = {
    kind: "https",
    location: "https://example.org/SKILL.md?token=URL_SECRET",
    requestedUrl: "https://example.org/SKILL.md?token=URL_SECRET",
    finalUrl: "https://example.org/SKILL.md?token=URL_SECRET",
    acquiredAt: at,
    modelVersion: version,
  };
  const op = {
    kind: "install",
    skillId: "skill-1",
    skillDigest: "skill-digest",
    callerId: "operator",
    behaviorId: "skill-install",
    invocationId: "install-1",
    requestDigest: "request-1",
    policyId: "policy-1",
    modelVersion: version,
    at,
    revision: 1,
  };
  return {
    ownerId: "operator",
    revision: 4,
    skills: [{
      id: "skill-1",
      digest: "skill-digest",
      installedAt: at,
      content: "RAW_SKILL_SECRET",
      source,
    }, {
      id: "bundled",
      digest: "bundle-digest",
      source: { kind: "bundled", location: "bundled:local" },
    }],
    operations: [op, {
      ...op,
      kind: "load",
      invocationId: "load-1",
      revision: 2,
    }, {
      ...op,
      invocationId: "install-2",
      at: "2026-10-26T01:00:00Z",
      revision: 3,
      modelVersion: { digest: "contract-2", repositoryVersion: "version-2" },
    }, {
      ...op,
      skillId: "bundled",
      skillDigest: "bundle-digest",
      invocationId: "bundle-1",
      revision: 4,
    }],
  };
}

function firstAcquisition() {
  const catalog = skillsCatalog();
  catalog.operations = catalog.operations.slice(0, 1);
  catalog.revision = 1;
  return catalog;
}

/** Immutable captures supplied by already-authorized owners. Storage decoding and
 * budgets are covered by the PostgreSQL adapters and live-reader tests. */
function fixture() {
  const captures = new Map<
    string,
    {
      state: BoundedNetworkImpactEvidenceRead;
      skills: BoundedNetworkImpactEvidenceRead;
    }
  >();
  const identities = new Map<string, string>();
  const identity = (owner: string, kind: string) => {
    const key = `${owner}:${kind}`;
    if (!identities.has(key)) identities.set(key, `source-${identities.size}`);
    return identities.get(key)!;
  };
  const captured = (
    values: unknown[],
    revision?: number,
  ): BoundedNetworkImpactEvidenceRead => {
    const snapshots = values.map((value, index) => ({
      revision: revision ?? index,
      payload: typeof value === "string" ? value : JSON.stringify(value),
    }));
    return {
      snapshots,
      complete: true,
      snapshotsRead: snapshots.length,
      bytesRead: snapshots.reduce(
        (sum, entry) => sum + new TextEncoder().encode(entry.payload).length,
        0,
      ),
      revisionBounds: {
        from: snapshots[0]?.revision ?? null,
        to: snapshots.at(-1)?.revision ?? null,
      },
      issues: [],
    };
  };
  return {
    capture(
      owner: string,
      states: unknown[] = [],
      catalog?: { revision: number },
      storedCatalogRevision?: number,
    ) {
      captures.set(owner, {
        state: captured(states),
        skills: captured(
          catalog ? [catalog] : [],
          storedCatalogRevision ?? catalog?.revision,
        ),
      });
    },
    recorded: (owner: string) => structuredClone(captures.get(owner)),
    reader(options: { stateOwners: string[]; skillsOwners: string[] }) {
      return new LiveNetworkImpactEvidenceReader({
        resolveSources: () =>
          Promise.resolve([
            ...options.stateOwners.map((owner) => ({
              owner,
              kind: "state" as const,
            })),
            ...options.skillsOwners.map((owner) => ({
              owner,
              kind: "skills" as const,
            })),
          ].map(({ owner, kind }) => ({
            id: identity(owner, kind),
            kind,
            read: () => {
              const capture = captures.get(owner);
              if (!capture) {
                return Promise.reject(new Error("Unavailable owner"));
              }
              return Promise.resolve(structuredClone(capture[kind]));
            },
          }))),
      });
    },
  };
}

Deno.test("network evidence requires a complete PageResult before claiming a received page", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  const malformed = [
    { url: "https://example.org/?secret=DO_NOT_EXPOSE" },
    { url: "https://example.org/", title: "Page", text: 42 },
    {
      url: "https://example.org/",
      title: { secret: "RAW_TITLE_SECRET" },
      text: "",
    },
  ].map((value, index) => ({
    ...observation(`malformed-${index}`, "tool-result", value),
    observation: { kind: "tool-result", value },
  }));
  capture(path, [snapshot(0, [
    ...malformed,
    observation("valid", "tool-result", {
      url: "https://example.org/",
      title: "",
      text: "",
    }),
  ])], firstAcquisition());
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  const messages = result.evidence.filter((entry) =>
    entry.source === "message"
  );
  deepStrictEqual(messages.map((entry) => entry.kind), [
    "context-only",
    "context-only",
    "context-only",
    "page-received",
  ]);
  for (const entry of messages.slice(0, 3)) {
    equal(entry.host, request.host);
    ok(entry.issues.some((issue) => issue.code === "PAGE_RESULT_INVALID"));
  }
  equal(result.complete, false);
  ok(!JSON.stringify(result).includes("DO_NOT_EXPOSE"));
  ok(!JSON.stringify(result).includes("RAW_TITLE_SECRET"));
});

Deno.test("network evidence only proves a refusal from consistent native permission metadata", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  const permission = { kind: "network-host", host: "example.org" };
  const failures = [
    {
      code: "NETWORK_SCOPE_DENIED",
      missingPermission: permission,
      url: "https://initial.org/",
    },
    {
      code: "REPEATED_FAILURE",
      missingPermission: permission,
      url: "https://initial.org/",
    },
    {
      code: "FETCH_FAILED",
      missingPermission: permission,
      url: "https://initial.org/",
    },
    {
      code: "NETWORK_SCOPE_DENIED",
      missingPermission: { kind: "other", host: "example.org" },
      url: "https://example.org/",
    },
    { code: "NETWORK_SCOPE_DENIED", url: "https://example.org/" },
    {
      code: "NETWORK_SCOPE_DENIED",
      missingPermission: { kind: "network-host", host: "other.org" },
      url: "https://example.org/",
    },
    {
      code: "NETWORK_SCOPE_DENIED",
      missingPermission: permission,
      allowedHosts: ["example.org"],
      url: "https://example.org/",
    },
  ];
  capture(path, [
    snapshot(
      0,
      failures.map((failure, index) =>
        observation(`failure-${index}`, "tool-failure", failure)
      ),
    ),
  ], firstAcquisition());
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  deepStrictEqual(
    result.evidence.filter((entry) => entry.source === "message").map((
      entry,
    ) => entry.kind),
    [
      "network-refused",
      "network-refused",
      "context-only",
      "attempt-unconfirmed",
      "attempt-unconfirmed",
      "attempt-unconfirmed",
      "attempt-unconfirmed",
    ],
  );
  equal(result.complete, false);
  equal(
    result.issues.filter((issue) => issue.code === "NETWORK_REFUSAL_INVALID")
      .length,
    4,
  );
});

Deno.test("network evidence informational tool-called context does not make a complete bounded read incomplete", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  capture(path, [
    snapshot(0, [], [{ id: "call", kind: "tool-called", execution: refs }]),
  ], firstAcquisition());
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  equal(result.complete, true);
  equal(result.evidence[0]?.kind, "context-only");
  ok(
    result.issues.some((issue) => issue.code === "CONTEXT_IS_NOT_NETWORK_USE"),
  );
});

Deno.test("network evidence continues after a corrupt JSON row and reports its opaque source", async () => {
  const { capture, reader, recorded } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  capture(path, [
    snapshot(0, [
      observation("before", "tool-result", { url: "https://example.org/" }),
    ]),
    "{ RAW_CORRUPT_SECRET",
    snapshot(2, [
      observation("after", "tool-result", { url: "https://example.org/" }),
    ]),
  ], firstAcquisition());
  const before = recorded(path);
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  equal(
    result.evidence.filter((entry) => entry.kind === "page-received").length,
    2,
  );
  equal(result.snapshotsRead, 4);
  equal(result.complete, false);
  equal(
    result.issues.find((issue) => issue.code === "EVIDENCE_PAYLOAD_INVALID")
      ?.sourceId,
    result.sources?.find((source) => source.kind === "state")?.id,
  );
  ok(!JSON.stringify(result).includes("RAW_CORRUPT_SECRET"));
  deepStrictEqual(recorded(path), before);
});

Deno.test("network evidence rejects a skill payload whose persisted revision column disagrees", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  capture(path, [snapshot(0, [])], firstAcquisition(), 999);
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  equal(result.evidence.length, 0);
  equal(result.complete, false);
  equal(
    result.issues.find((issue) =>
      issue.code === "EVIDENCE_SKILL_REVISION_INVALID"
    )?.sourceId,
    result.sources?.find((source) => source.kind === "skills")?.id,
  );
});

Deno.test("network evidence merges opaque origins for duplicates and identifies the source of a conflicting copy", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const one = `${directory}/private-one`;
  const two = `${directory}/private-two`;
  const missing = `${directory}/missing`;
  const shared = observation("shared", "tool-result", {
    url: "https://example.org/",
  });
  const conflict = observation("conflict", "tool-result", {
    url: "https://example.org/",
  });
  capture(one, [snapshot(0, [shared, conflict])], firstAcquisition());
  capture(two, [
    snapshot(0, [
      shared,
      observation("conflict", "tool-result", { url: "https://other.org/" }),
    ]),
  ]);
  const ownerReader = reader({
    stateOwners: [one, two, missing],
    skillsOwners: [one],
  });
  const result = await ownerReader.read(request);
  const stateSources =
    result.sources?.filter((source) => source.kind === "state") ?? [];
  equal(stateSources.length, 3);
  deepStrictEqual(stateSources.map((source) => source.inputIndex), [0, 1, 2]);
  const sharedEvidence = result.evidence.find((entry) =>
    entry.id.includes('"shared"')
  );
  const conflictEvidence = result.evidence.find((entry) =>
    entry.id.includes('"conflict"')
  );
  deepStrictEqual(sharedEvidence?.sourceIds, [
    stateSources[0]!.id,
    stateSources[1]!.id,
  ]);
  deepStrictEqual(conflictEvidence?.sourceIds, [
    stateSources[0]!.id,
    stateSources[1]!.id,
  ]);
  equal(conflictEvidence?.kind, "context-only");
  const divergence = result.issues.find((issue) =>
    issue.code === "EVIDENCE_RECORD_DIVERGED"
  );
  equal(divergence?.recordId, conflictEvidence?.id);
  equal(divergence?.sourceId, stateSources[1]!.id);
  equal(
    result.issues.find((issue) => issue.code === "EVIDENCE_SOURCE_UNAVAILABLE")
      ?.sourceId,
    stateSources[2]!.id,
  );
  ok(!JSON.stringify(result).includes(directory));
  const reordered = await reader({
    stateOwners: [two, one],
    skillsOwners: [one],
  }).read(request);
  equal(
    reordered.sources?.find((source) =>
      source.kind === "state" && source.inputIndex === 1
    )?.id,
    stateSources[0]!.id,
  );
  equal(
    reordered.sources?.find((source) =>
      source.kind === "state" && source.inputIndex === 0
    )?.id,
    stateSources[1]!.id,
  );
});

Deno.test("live network evidence reads immutable captures and emits metadata without raw content or URLs", async () => {
  const { capture, reader, recorded } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  const messages = [
    observation("received", "tool-result", {
      url: "https://example.org/private?token=URL_SECRET",
      title: "TITLE_SECRET",
      text: "PAGE_SECRET",
    }),
    observation("denied", "tool-failure", {
      code: "NETWORK_SCOPE_DENIED",
      toolId: "tool",
      missingPermission: { kind: "network-host", host: "example.org" },
      url: "https://other.org/",
      allowedHosts: ["other.org"],
    }),
    observation("failed", "tool-failure", {
      code: "FETCH_FAILED",
      url: "https://example.org/private?token=URL_SECRET",
    }),
  ];
  const events = [{
    id: "called",
    kind: "tool-called",
    label: "EVENT_SECRET",
    execution: refs,
    candidateId: "tool",
  }];
  capture(path, [
    snapshot(0, messages, events),
    snapshot(1, messages, events),
  ], skillsCatalog());
  const before = recorded(path);
  const ownerReader = reader({
    stateOwners: [path],
    skillsOwners: [path],
  });
  const result = await ownerReader.read(request);
  equal(result.snapshotsRead, 3);
  equal(result.recordsRead, 12);
  equal(result.evidence.length, 6);
  deepStrictEqual(
    result.evidence.filter((entry) => entry.source === "message").map((
      entry,
    ) => entry.kind),
    ["page-received", "network-refused", "attempt-unconfirmed"],
  );
  equal(
    result.evidence.find((entry) => entry.kind === "page-received")
      ?.operatorId,
    "operator",
  );
  equal(
    result.evidence.find((entry) => entry.kind === "page-received")
      ?.runtimeDigest,
    "runtime-1",
  );
  equal(
    result.evidence.find((entry) => entry.kind === "skill-downloaded")?.host,
    "example.org",
  );
  equal(
    result.evidence.find((entry) =>
      entry.kind === "skill-operation-unattributed"
    )?.modelVersion,
    "version-2",
  );
  equal(
    result.evidence.find((entry) =>
      entry.kind === "skill-operation-unattributed"
    )?.host,
    undefined,
  );
  ok(!result.issues.some((entry) => entry.code === "EVIDENCE_ACTOR_UNKNOWN"));
  const output = JSON.stringify(result);
  for (
    const secret of [
      "RAW_MESSAGE_SECRET",
      "RAW_SKILL_SECRET",
      "PAGE_SECRET",
      "EVENT_SECRET",
      "TITLE_SECRET",
      "URL_SECRET",
      "https://",
    ]
  ) ok(!output.includes(secret));
  deepStrictEqual(recorded(path), before);
});

Deno.test("network evidence detects divergent immutable records and retracts a host claim", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  capture(path, [
    snapshot(0, [
      observation("same", "tool-result", { url: "https://example.org/" }),
    ]),
    snapshot(1, [
      observation("same", "tool-result", { url: "https://other.org/" }),
    ]),
  ]);
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  equal(result.evidence.length, 1);
  equal(result.evidence[0]?.kind, "context-only");
  equal(result.evidence[0]?.host, undefined);
  equal(result.complete, false);
  ok(
    result.issues.some((entry) => entry.code === "EVIDENCE_RECORD_DIVERGED"),
  );
});

Deno.test("network evidence deduplicates a first acquisition across catalogs without calling a same-time reinstall a download", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const earlier = skillsCatalog();
  earlier.operations = earlier.operations.slice(0, 1);
  earlier.revision = 1;
  const later = structuredClone(earlier);
  later.operations.push({
    ...later.operations[0]!,
    invocationId: "reinstall-at-same-time",
    revision: 2,
  });
  later.revision = 2;
  const one = `${directory}/earlier`;
  const two = `${directory}/later`;
  capture(one, [snapshot(0, [])], earlier);
  capture(two, [], later);
  const result = await reader({
    stateOwners: [one],
    skillsOwners: [one, two],
  }).read(request);
  deepStrictEqual(result.evidence.map((entry) => entry.kind), [
    "skill-downloaded",
    "skill-operation-unattributed",
  ]);
  equal(result.evidence[1]?.host, undefined);
});

Deno.test("network evidence resolves each exact contract across snapshots and never uses a Case birth pin or owner", async () => {
  const { capture, reader } = fixture();
  const directory = "private-owner-scope";
  const path = `${directory}/state`;
  const historical = observation("historic", "tool-result", {
    url: "https://example.org/",
  });
  const legacy = {
    ...observation("legacy", "tool-result", { url: "https://example.org/" }),
    // Even a known digest is insufficient without the record's source version.
    execution: { digest: refs.digest },
  };
  const first = snapshot(0, []);
  const second = {
    ...snapshot(1, [historical, legacy]),
    executionModel: {
      version: { digest: "later", repositoryVersion: "later-version" },
      identity: { builderId: "unrelated" },
    },
  };
  capture(path, [first, second]);
  const result = await reader({
    stateOwners: [path],
    skillsOwners: [path],
  }).read(request);
  equal(result.evidence[0]?.operatorId, "operator");
  equal(result.evidence[0]?.modelVersion, "version-1");
  equal(result.evidence[1]?.operatorId, undefined);
  equal(result.evidence[1]?.modelVersion, undefined);
  equal(result.evidence[1]?.contractDigest, refs.digest);
  equal(result.complete, false);
  ok(result.issues.some((entry) => entry.code === "EVIDENCE_ACTOR_UNKNOWN"));
});

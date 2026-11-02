import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { BoundedNetworkImpactEvidenceRead } from "./evidence-sources.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../../domain/model/consultation/network-impact.ts";
import {
  LiveNetworkImpactEvidenceReader,
  type LiveNetworkImpactEvidenceSource,
} from "./live-evidence-reader.ts";

const request = {
  operatorId: "operator",
  host: "example.org",
  limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
};
function state(revision: number, text = "private message and page contents") {
  return {
    id: "system",
    revision,
    executionModel: {
      identity: { builderId: "operator" },
      version: { digest: "contract", repositoryVersion: "version-1" },
    },
    messages: [{
      id: "page",
      role: "tool",
      content: text,
      execution: { digest: "contract", repositoryVersion: "version-1" },
      observation: {
        kind: "tool-result",
        value: {
          url: "https://example.org/private",
          title: "private title",
          text,
        },
      },
    }],
    events: [],
  };
}
function captured(...values: unknown[]): BoundedNetworkImpactEvidenceRead {
  const snapshots = values.map((value) => ({
    revision: (value as { revision: number }).revision,
    payload: JSON.stringify(value),
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
}

Deno.test("live network evidence shares metadata extraction and deduplicates independent owner captures", async () => {
  const reads: string[] = [];
  const sources: LiveNetworkImpactEvidenceSource[] = [
    {
      id: "state-one",
      kind: "state",
      read: () => {
        reads.push("state-one");
        return Promise.resolve(captured(state(1)));
      },
    },
    {
      id: "state-two",
      kind: "state",
      read: () => {
        reads.push("state-two");
        return Promise.resolve(captured(state(2)));
      },
    },
    {
      id: "skills",
      kind: "skills",
      read: () => {
        reads.push("skills");
        return Promise.resolve(
          captured({
            ownerId: "operator",
            revision: 0,
            operations: [],
            skills: [],
          }),
        );
      },
    },
  ];
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () => Promise.resolve(sources),
  }).read(request);
  deepStrictEqual(reads, ["state-one", "state-two", "skills"]);
  equal(result.complete, true);
  equal(result.evidence.length, 1);
  equal(result.evidence[0]?.kind, "page-received");
  equal(result.evidence[0]?.operatorId, "operator");
  deepStrictEqual(result.evidence[0]?.sourceIds, ["state-one", "state-two"]);
  deepStrictEqual(result.sources?.map((entry) => entry.revisionBounds), [
    { from: 1, to: 1 },
    { from: 2, to: 2 },
    { from: 0, to: 0 },
  ]);
  const serialized = JSON.stringify(result);
  for (
    const secret of ["private message", "private title", "/private", "payload"]
  ) equal(serialized.includes(secret), false);
});

Deno.test("live network evidence refuses invalid scope and cancellation before resolving owners", async () => {
  let resolutions = 0;
  const reader = new LiveNetworkImpactEvidenceReader({
    resolveSources: () => {
      resolutions++;
      return Promise.resolve([]);
    },
  });
  const invalid = await reader.read({
    ...request,
    host: "https://example.org",
  });
  equal(resolutions, 0);
  ok(invalid.issues.some((entry) => entry.code === "INVALID_EVIDENCE_SCOPE"));
  const controller = new AbortController();
  controller.abort();
  const aborted = await reader.read({ ...request, signal: controller.signal });
  equal(resolutions, 0);
  ok(aborted.issues.some((entry) => entry.code === "EVIDENCE_ABORTED"));
});

Deno.test("live network evidence enforces aggregate budgets before reading another owner", async () => {
  let secondReads = 0;
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "state",
          kind: "state",
          read: () => Promise.resolve(captured(state(1))),
        },
        {
          id: "skills",
          kind: "skills",
          read: () => {
            secondReads++;
            return Promise.resolve(captured());
          },
        },
      ]),
  }).read({ ...request, limits: { ...request.limits, maxSnapshots: 1 } });
  equal(secondReads, 0);
  equal(result.snapshotsRead, 1);
  equal(result.complete, false);
  ok(result.issues.some((entry) => entry.code === "EVIDENCE_SNAPSHOT_LIMIT"));
});

Deno.test("live network evidence preserves owner bounds and coverage when a payload is skipped", async () => {
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "state",
          kind: "state",
          read: () =>
            Promise.resolve({
              ...captured(),
              complete: false,
              snapshotsRead: 1,
              revisionBounds: { from: 1, to: 9 },
              issues: [{
                code: "EVIDENCE_PAYLOAD_LIMIT",
                message: "Payload too large",
              }],
            }),
        },
      ]),
  }).read(request);
  equal(result.complete, false);
  equal(result.evidence.length, 0);
  deepStrictEqual(result.sources?.[0]?.revisionBounds, { from: 1, to: 9 });
  equal(result.sources?.[0]?.complete, false);
  ok(
    result.issues.some((entry) =>
      entry.sourceId === "state" && entry.code === "EVIDENCE_PAYLOAD_LIMIT"
    ),
  );
  ok(result.issues.some((entry) => entry.code === "ABSENCE_IS_NOT_NO_ACCESS"));
  ok(
    result.issues.some((entry) =>
      entry.code === "SKILL_EVIDENCE_NOT_CONFIGURED"
    ),
  );
});

function emptySkills() {
  return captured({
    ownerId: "operator",
    revision: 0,
    operations: [],
    skills: [],
  });
}
function downloadedSkill() {
  const at = "2026-10-26T00:00:00Z";
  const modelVersion = { digest: "contract", repositoryVersion: "version-1" };
  const url = "https://example.org/skill";
  return captured({
    ownerId: "operator",
    revision: 1,
    operations: [{
      kind: "install",
      revision: 1,
      skillId: "skill",
      skillDigest: "digest",
      callerId: "operator",
      invocationId: "install",
      at,
      modelVersion,
    }],
    skills: [{
      id: "skill",
      digest: "digest",
      installedAt: at,
      source: {
        kind: "https",
        location: url,
        requestedUrl: url,
        finalUrl: url,
        acquiredAt: at,
        modelVersion,
      },
    }],
  });
}

Deno.test("live network evidence reserves a skills snapshot after a long state-first history", async () => {
  const budgets: number[] = [];
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "state",
          kind: "state",
          read: (budget) => {
            budgets.push(budget.maxSnapshots);
            const snapshots = Array.from(
              { length: 70 },
              (_, index) => ({ ...state(index + 1), messages: [] }),
            );
            return Promise.resolve({
              ...captured(...snapshots.slice(0, budget.maxSnapshots)),
              complete: budget.maxSnapshots >= snapshots.length,
              revisionBounds: { from: 1, to: 70 },
              issues: budget.maxSnapshots >= snapshots.length ? [] : [{
                code: "EVIDENCE_SNAPSHOT_LIMIT",
                message: "History bounded",
              }],
            });
          },
        },
        {
          id: "skills",
          kind: "skills",
          read: (budget) => {
            budgets.push(budget.maxSnapshots);
            return Promise.resolve(downloadedSkill());
          },
        },
      ]),
  }).read(request);
  deepStrictEqual(budgets, [63, 1]);
  equal(result.snapshotsRead, 64);
  equal(result.complete, false);
  equal(result.evidence[0]?.kind, "skill-downloaded");
  deepStrictEqual(result.sources?.map((source) => source.complete), [
    false,
    true,
  ]);
});

Deno.test("live network evidence completes at an exact record boundary and flags only unprocessed records", async () => {
  for (const extra of [false, true]) {
    const snapshot = state(1);
    if (extra) {
      snapshot.messages.push({ ...snapshot.messages[0]!, id: "extra" });
    }
    const result = await new LiveNetworkImpactEvidenceReader({
      resolveSources: () =>
        Promise.resolve([
          {
            id: "state",
            kind: "state",
            read: () => Promise.resolve(captured(snapshot)),
          },
          {
            id: "skills",
            kind: "skills",
            read: () => Promise.resolve(emptySkills()),
          },
        ]),
    }).read({ ...request, limits: { ...request.limits, maxRecords: 1 } });
    equal(result.recordsRead, 1);
    equal(result.complete, !extra);
    equal(
      result.issues.some((entry) => entry.code === "EVIDENCE_RECORD_LIMIT"),
      extra,
    );
    deepStrictEqual(result.sources?.map((source) => source.complete), [
      !extra,
      true,
    ]);
  }
});

Deno.test("live network evidence source flags include JSON errors, revision mismatch and finish attribution", async () => {
  const unattributed = { ...state(1), executionModel: undefined };
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "json",
          kind: "state",
          read: () =>
            Promise.resolve({
              ...captured(),
              snapshots: [{ revision: 1, payload: "{" }],
              snapshotsRead: 1,
            }),
        },
        {
          id: "revision",
          kind: "state",
          read: () =>
            Promise.resolve({
              ...captured(state(1)),
              snapshots: [{ revision: 2, payload: JSON.stringify(state(1)) }],
            }),
        },
        {
          id: "unknown-actor",
          kind: "state",
          read: () => Promise.resolve(captured(unattributed)),
        },
        {
          id: "skills",
          kind: "skills",
          read: () => Promise.resolve(emptySkills()),
        },
      ]),
  }).read(request);
  deepStrictEqual(result.sources?.map((source) => source.complete), [
    false,
    false,
    false,
    true,
  ]);
  for (
    const [sourceId, code] of [["json", "EVIDENCE_PAYLOAD_INVALID"], [
      "revision",
      "EVIDENCE_REVISION_INVALID",
    ], ["unknown-actor", "EVIDENCE_ACTOR_UNKNOWN"]]
  ) {
    ok(
      result.issues.some((entry) =>
        entry.sourceId === sourceId && entry.code === code
      ),
    );
  }
  // Observation limitations stay informational and do not taint a fully read owner.
  ok(result.issues.some((entry) => entry.code === "HTTP_START_ORDER_UNKNOWN"));
  equal(result.sources?.at(-1)?.complete, true);
});

Deno.test("live network evidence keeps every configured source visible on budget exhaustion and cancellation", async () => {
  let unreadCalls = 0;
  const sources: LiveNetworkImpactEvidenceSource[] = [
    {
      id: "state",
      kind: "state",
      read: () => Promise.resolve(captured(state(1))),
    },
    {
      id: "skills",
      kind: "skills",
      read: () => {
        unreadCalls++;
        return Promise.resolve(emptySkills());
      },
    },
    {
      id: "another",
      kind: "state",
      read: () => {
        unreadCalls++;
        return Promise.resolve(captured());
      },
    },
  ];
  const bounded = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () => Promise.resolve(sources),
  }).read({ ...request, limits: { ...request.limits, maxSnapshots: 1 } });
  equal(unreadCalls, 0);
  deepStrictEqual(bounded.sources?.map((source) => source.complete), [
    true,
    false,
    false,
  ]);
  for (const sourceId of ["skills", "another"]) {
    ok(
      bounded.issues.some((entry) =>
        entry.sourceId === sourceId && entry.code === "EVIDENCE_SNAPSHOT_LIMIT"
      ),
    );
  }
  const controller = new AbortController();
  sources[0] = {
    id: "state",
    kind: "state",
    read: () => {
      controller.abort();
      return Promise.resolve(captured(state(1)));
    },
  };
  const aborted = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () => Promise.resolve(sources),
  }).read({ ...request, signal: controller.signal });
  equal(unreadCalls, 0);
  deepStrictEqual(aborted.sources?.map((source) => source.complete), [
    false,
    false,
    false,
  ]);
  for (const sourceId of ["state", "skills", "another"]) {
    ok(
      aborted.issues.some((entry) =>
        entry.sourceId === sourceId && entry.code === "EVIDENCE_ABORTED"
      ),
    );
  }
});

Deno.test("live network evidence marks every divergent origin incomplete during finish", async () => {
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "first",
          kind: "state",
          read: () => Promise.resolve(captured(state(1, "first"))),
        },
        {
          id: "second",
          kind: "state",
          read: () => Promise.resolve(captured(state(2, "divergent"))),
        },
        {
          id: "skills",
          kind: "skills",
          read: () => Promise.resolve(emptySkills()),
        },
      ]),
  }).read(request);
  deepStrictEqual(result.sources?.map((source) => source.complete), [
    false,
    false,
    true,
  ]);
  equal(result.evidence[0]?.kind, "context-only");
  for (const sourceId of ["first", "second"]) {
    ok(
      result.issues.some((entry) =>
        entry.sourceId === sourceId && entry.code === "EVIDENCE_RECORD_DIVERGED"
      ),
    );
  }
});

Deno.test("live network evidence marks a timed-out source incomplete after its owner returns", async () => {
  const result = await new LiveNetworkImpactEvidenceReader({
    resolveSources: () =>
      Promise.resolve([
        {
          id: "state",
          kind: "state",
          read: (budget) =>
            new Promise((resolve) => {
              budget.signal!.addEventListener(
                "abort",
                () => resolve(captured()),
                { once: true },
              );
            }),
        },
        {
          id: "skills",
          kind: "skills",
          read: () => Promise.resolve(emptySkills()),
        },
      ]),
  }).read({ ...request, limits: { ...request.limits, timeoutMs: 1 } });
  deepStrictEqual(result.sources?.map((source) => source.complete), [
    false,
    false,
  ]);
  for (const sourceId of ["state", "skills"]) {
    ok(
      result.issues.some((entry) =>
        entry.sourceId === sourceId && entry.code === "EVIDENCE_TIMEOUT"
      ),
    );
  }
});

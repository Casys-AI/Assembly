import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { NetworkImpactConsultationQuery } from "../../../domain/model/consultation/context.ts";
import {
  DEFAULT_NETWORK_IMPACT_LIMITS,
  type NetworkImpactEvidence,
  type NetworkImpactFrame,
  type NetworkImpactReport,
} from "../../../domain/model/consultation/network-impact.ts";
import { NetworkImpactService } from "./analysis.ts";
import {
  NetworkImpactConsultation,
  type NetworkImpactConsultationPage,
  type NetworkImpactConsultationSummary,
} from "./consultation.ts";
import type { NetworkImpactConsultationBinding } from "./queries/inputs.ts";

const version = (n: number) => `commit:${String(n).repeat(40)}`;
const binding: NetworkImpactConsultationBinding = {
  projectId: "project",
  callerId: "operator",
  contractDigest: "admitted-contract",
  admittedVersion: version(4),
  consultationVersion: version(4),
  requestKey: "request-1",
  evidenceScopeId: "host-scope-own-history",
};
const query: NetworkImpactConsultationQuery = {
  operation: "network_impact",
  action: "compare",
  version: version(4),
  operatorId: "operator",
  host: "example.org",
  fromVersion: version(1),
  toVersion: version(4),
};

function frame(n: number): NetworkImpactFrame {
  return {
    version: version(n),
    state: "known",
    contractDigest: `contract-${n}`,
    operatorId: "operator",
    paths: (["web", "skill-install"] as const).map((channel) => {
      const allowed = n === 1 || n === 4 ||
        channel === "skill-install" && n === 2;
      return {
        id: channel,
        channel,
        hostPermission: allowed ? "allowed" : "denied",
        state: allowed ? "conditional" : "blocked",
        guards: [{
          code: "HOST",
          state: allowed ? "pass" : "fail",
          explanation: "Exact host permission",
          witnesses: [{ role: "scope", elementId: `scope-${channel}` }],
        }],
        witnesses: [{ role: "operator", elementId: "operator" }],
        consumer: { symbol: channel, source: "network-consumer.ts" },
      };
    }),
    issues: [],
    indirectAccess: "not-covered",
  };
}

function evidence(id: string, n = 1): NetworkImpactEvidence {
  return {
    id,
    source: "message",
    kind: "page-received",
    operatorId: "operator",
    modelVersion: version(n),
    contractDigest: `contract-${n}`,
    host: "example.org",
    startOrder: "unknown",
    issues: [],
  };
}

async function report(): Promise<NetworkImpactReport> {
  return await new NetworkImpactService({
    lineage: {
      readFirstParentInterval: () =>
        Promise.resolve({
          fromVersion: version(1),
          toVersion: version(4),
          versions: [1, 2, 3, 4].map((n) => ({
            version: version(n),
            parents: n === 1 ? [] : [version(n - 1)],
          })),
          complete: true,
        }),
    },
    models: { read: (v) => Promise.resolve(frame(Number(v.slice(-1)))) },
    evidence: {
      read: () =>
        Promise.resolve({
          evidence: [evidence("observed"), {
            ...evidence("contract-only", 2),
            modelVersion: undefined,
            kind: "attempt-unconfirmed",
          }, {
            ...evidence("unknown"),
            operatorId: undefined,
            kind: "context-only",
          }],
          complete: false,
          snapshotsRead: 4,
          recordsRead: 3,
          bytesRead: 500,
          issues: [{
            code: "MISSING_SOURCE",
            message: "Unknown source coverage",
          }],
          sources: [{ id: "state:1", kind: "state", inputIndex: 0 }],
        }),
    },
  }).analyze(
    query as Extract<NetworkImpactConsultationQuery, { action: "compare" }>,
  );
}

const details = (
  summary: NetworkImpactConsultationSummary,
  view: "versions" | "transitions" | "witnesses" | "evidence" | "issues",
  extras: { cursor?: string; limit?: number } = {},
): Extract<NetworkImpactConsultationQuery, { action: "details" }> => ({
  operation: "network_impact",
  version: version(4),
  action: "details",
  analysisRef: summary.analysisRef,
  view,
  ...extras,
});

Deno.test("consultation retains every temporary withdrawal transition and independent route with bounded metadata views", async () => {
  const captured = await report();
  const service = new NetworkImpactConsultation({
    analyze: () => Promise.resolve(captured),
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxPageSize: 2,
  });
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  equal(summary.counts.versions, 4);
  equal(summary.counts.transitions, 3);
  equal(summary.counts.evidence, 3);
  equal(summary.coverage.recordsReadComplete, false);
  equal(summary.coverage.networkObservationComplete, false);
  equal("issues" in summary.evidenceRead, false);
  equal("frames" in summary, false);
  deepStrictEqual(summary.evidenceRead.sources, captured.evidenceRead.sources);
  const all: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.consult(
      binding,
      details(summary, "transitions", { cursor }),
    ) as NetworkImpactConsultationPage;
    ok(page.items.length <= 2);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const transitions = all as NetworkImpactReport["transitions"];
  deepStrictEqual(
    transitions.map((entry) => entry.changes.map((change) => change.kind)),
    [
      ["permission-revoked", "unchanged"],
      ["unchanged", "permission-revoked"],
      ["permission-granted", "permission-granted"],
    ],
  );
  const page = await service.consult(
    binding,
    details(summary, "witnesses"),
  ) as NetworkImpactConsultationPage;
  ok(summary.counts.witnesses > 4);
  equal(page.total, summary.counts.witnesses);
});

Deno.test("consultation refuses another target and agent-selected source/ceiling parameters before analysis", async () => {
  let reads = 0;
  const service = new NetworkImpactConsultation({
    analyze: async () => {
      reads++;
      return await report();
    },
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
  });
  await rejects(
    () =>
      service.consult(
        binding,
        { ...query, operatorId: "other" } as NetworkImpactConsultationQuery,
      ),
    { code: "NETWORK_IMPACT_SCOPE" },
  );
  await rejects(
    () => service.consult({ ...binding, callerId: "Main" }, query),
    { code: "NETWORK_IMPACT_SCOPE" },
  );
  await rejects(
    () =>
      service.consult(
        binding,
        {
          ...query,
          statePath: "/foreign.db",
        } as NetworkImpactConsultationQuery,
      ),
    { code: "NETWORK_IMPACT_INPUT" },
  );
  await rejects(
    () =>
      service.consult(
        binding,
        {
          ...query,
          limits: { maxRecords: 5 },
        } as NetworkImpactConsultationQuery,
      ),
    { code: "NETWORK_IMPACT_INPUT" },
  );
  equal(reads, 0);
});

Deno.test("analysis references are isolated by admitted contract, request, pin and host evidence scope and expire", async () => {
  let now = 100;
  let reads = 0;
  const service = new NetworkImpactConsultation({
    analyze: async () => {
      reads++;
      return await report();
    },
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    now: () => now,
    ttlMs: 50,
  });
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
    const changed = { ...binding, [key]: `${binding[key]}-changed` };
    await rejects(
      () =>
        service.consult(changed, {
          ...details(summary, "evidence"),
          version: changed.consultationVersion,
        }),
      { code: "NETWORK_IMPACT_REFERENCE" },
    );
  }
  now = 150;
  await rejects(() => service.consult(binding, details(summary, "evidence")), {
    code: "NETWORK_IMPACT_REFERENCE",
  });
  equal(reads, 1);
});

Deno.test("captured pages and source bounds stay stable after subsequent writes and cannot leak mutable references", async () => {
  const captured = await report();
  let reads = 0;
  const service = new NetworkImpactConsultation({
    analyze: () => {
      reads++;
      return Promise.resolve(captured);
    },
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
  });
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  const before = await service.consult(
    binding,
    details(summary, "evidence", { limit: 1 }),
  ) as NetworkImpactConsultationPage;
  captured.evidence.length = 0;
  captured.evidenceRead.recordsRead = 99;
  captured.evidenceRead.sources!.length = 0;
  const after = await service.consult(
    binding,
    details(summary, "evidence", { limit: 1 }),
  ) as NetworkImpactConsultationPage;
  deepStrictEqual(after, before);
  after.items.length = 0;
  after.evidenceRead.recordsRead = 55;
  deepStrictEqual(
    await service.consult(binding, details(summary, "evidence", { limit: 1 })),
    before,
  );
  await rejects(
    () =>
      service.consult(
        binding,
        details(summary, "witnesses", { cursor: before.nextCursor }),
      ),
    { code: "NETWORK_IMPACT_CURSOR" },
  );
  equal(reads, 1);
});

Deno.test("pages adapt to effective response budget including transport overhead and refuse indivisible oversized metadata", async () => {
  const captured = await report();
  captured.evidence = [
    ...captured.evidence,
    ...Array.from(
      { length: 20 },
      (_, i) => ({ ...captured.evidence[0], id: `extra-${i}` }),
    ),
  ];
  const service = new NetworkImpactConsultation({
    analyze: () => Promise.resolve(captured),
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxResponseCharacters: 20_000,
  });
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  const budget = {
    maxResponseCharacters: 2_500,
    responseOverheadCharacters: 100,
  };
  const page = await service.consult(
    binding,
    details(summary, "evidence"),
    budget,
  ) as NetworkImpactConsultationPage;
  ok(page.truncated);
  ok(page.items.length > 0 && page.items.length < 23);
  ok(JSON.stringify(page).length + 100 <= 2500);
  await rejects(
    () =>
      service.consult(binding, details(summary, "evidence"), {
        maxResponseCharacters: 20,
      }),
    { code: "NETWORK_IMPACT_RESPONSE_LIMIT" },
  );
  await rejects(
    () =>
      service.consult(binding, query, {
        maxResponseCharacters: 20,
        responseOverheadCharacters: 20,
      }),
    { code: "NETWORK_IMPACT_RESPONSE_LIMIT" },
  );
});

Deno.test("composition supplies calculation ceilings, and active captures and pending calculations share a fixed capacity", async () => {
  const captured = await report();
  const limits = { ...DEFAULT_NETWORK_IMPACT_LIMITS, maxRecords: 10 };
  let start: (() => void) | undefined;
  let finish: ((value: NetworkImpactReport) => void) | undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const service = new NetworkImpactConsultation({
    analyze: (request) => {
      deepStrictEqual(request.limits, limits);
      start!();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    limits,
    maxAnalyses: 1,
  });
  const first = service.consult(binding, query);
  await started;
  await rejects(() => service.consult(binding, query), {
    code: "NETWORK_IMPACT_CAPACITY",
  });
  finish!(captured);
  await first;
  await rejects(() => service.consult(binding, query), {
    code: "NETWORK_IMPACT_CAPACITY",
  });
});

Deno.test("result retention budget fails explicitly without retaining a partial analysis", async () => {
  const service = new NetworkImpactConsultation({
    analyze: report,
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxRetainedCharacters: 10,
  });
  await rejects(() => service.consult(binding, query), {
    code: "NETWORK_IMPACT_RESULT_LIMIT",
  });
});

Deno.test("effective advertised ceilings are detached from configuration and enforce detail page limits", async () => {
  const limits = { ...DEFAULT_NETWORK_IMPACT_LIMITS, maxRecords: 20 };
  const service = new NetworkImpactConsultation({
    analyze: report,
    limits,
    maxPageSize: 2,
    maxResponseCharacters: 8_000,
  });
  limits.maxRecords = 99;
  const capability = service.capability;
  equal(capability.scope, "own-history");
  equal(capability.maxPageSize, 2);
  equal(capability.maxResponseCharacters, 8_000);
  equal(capability.limits.maxRecords, 20);
  capability.limits.maxRecords = 100;
  equal(service.capability.limits.maxRecords, 20);
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  await rejects(
    () => service.consult(binding, details(summary, "evidence", { limit: 3 })),
    {
      code: "NETWORK_IMPACT_INPUT",
    },
  );
});

Deno.test("rejected pages allocate no cursors and accepted cursor metadata shares the retained result ceiling", async () => {
  const captured = await report();
  captured.frames = [];
  captured.transitions = [];
  captured.lineage.versions = [];
  captured.evidence = Array.from({ length: 30 }, (_, index) => ({
    id: `record-${index}`,
    source: "message",
    kind: "context-only",
    startOrder: "unknown",
    issues: [],
    match: "unresolved",
    relatedVersions: [],
    policyAtRecordedVersion: "unknown",
  }));
  let references = 0;
  const service = new NetworkImpactConsultation({
    analyze: () => Promise.resolve(captured),
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxRetainedCharacters: 10_000,
    newReference: () => {
      references++;
      return references === 1
        ? "analysis"
        : `cursor-${"x".repeat(200)}-${references}`;
    },
  });
  const summary = await service.consult(
    binding,
    query,
  ) as NetworkImpactConsultationSummary;
  equal(references, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    await rejects(
      () =>
        service.consult(binding, details(summary, "evidence"), {
          maxResponseCharacters: 20,
        }),
      {
        code: "NETWORK_IMPACT_RESPONSE_LIMIT",
      },
    );
  }
  equal(references, 1);
  const first = await service.consult(
    binding,
    details(summary, "evidence", { limit: 1 }),
  ) as NetworkImpactConsultationPage;
  let cursor = first.nextCursor;
  let accepted = 1;
  let exhausted = false;
  while (cursor && accepted < summary.counts.evidence) {
    try {
      const page = await service.consult(
        binding,
        details(summary, "evidence", { cursor, limit: 1 }),
      ) as NetworkImpactConsultationPage;
      cursor = page.nextCursor;
      accepted++;
    } catch (error) {
      equal((error as { code: string }).code, "NETWORK_IMPACT_RESULT_LIMIT");
      exhausted = true;
      break;
    }
  }
  ok(exhausted);
  ok(accepted > 1 && accepted < summary.counts.evidence);
  const beforeRetry = references;
  deepStrictEqual(
    await service.consult(binding, details(summary, "evidence", { limit: 1 })),
    first,
  );
  equal(references, beforeRetry);
});

Deno.test("superseding a caller binding releases only that caller's captures across more requests than global capacity", async () => {
  const captured = await report();
  const service = new NetworkImpactConsultation({
    analyze: (input) =>
      Promise.resolve({
        ...captured,
        request: {
          operatorId: input.operatorId,
          host: input.host,
          fromVersion: input.fromVersion,
          toVersion: input.toVersion,
        },
      }),
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxAnalyses: 2,
  });
  const other = { ...binding, callerId: "other-operator" };
  const otherSummary = await service.consult(other, {
    ...query,
    operatorId: other.callerId,
  }) as NetworkImpactConsultationSummary;
  let previous: NetworkImpactConsultationSummary | undefined;
  let previousBinding = binding;
  for (let index = 0; index < 8; index++) {
    const current = {
      ...binding,
      requestKey: `request-${index}`,
      contractDigest: `contract-${index}`,
    };
    const summary = await service.consult(
      current,
      query,
    ) as NetworkImpactConsultationSummary;
    if (previous) {
      await rejects(
        () => service.consult(current, details(previous!, "evidence")),
        { code: "NETWORK_IMPACT_REFERENCE" },
      );
    }
    const page = await service.consult(
      other,
      details(otherSummary, "evidence"),
    ) as NetworkImpactConsultationPage;
    equal(page.total, otherSummary.counts.evidence);
    previous = summary;
    previousBinding = current;
  }
  const last = await service.consult(
    previousBinding,
    details(previous!, "evidence"),
  ) as NetworkImpactConsultationPage;
  equal(last.total, previous!.counts.evidence);
});

import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  type CurrentProviderExecution,
  CurrentProviderResources,
} from "./current-provider-resources.ts";
import {
  ProviderResourceAggregation,
  type ProviderResourceQuery,
} from "./provider-resource-readout.ts";
import {
  RequestSpaceError,
  type SpaceController,
} from "../../domain/work/request-spaces.ts";
import {
  type ProviderCallObservation,
  UNKNOWN_PROVIDER_CALL_CORRELATION,
} from "./provider-call.ts";

function fixture(observations: readonly ProviderCallObservation[] = []) {
  const scope = { projectId: "host-project", systemId: "host-system" };
  const pin: CurrentProviderExecution = {
    operatorId: "native-operator",
    runtimeRevision: 7,
    modelVersion: {
      digest: "a".repeat(64),
      repositoryVersion: `commit:${"b".repeat(40)}`,
    },
  };
  let valid = true,
    mainReads = 0,
    caseReads = 0,
    afterRead: (() => void) | undefined;
  const queries: ProviderResourceQuery[] = [];
  const cases = {
    execution(secret: string, caseId: string) {
      caseReads++;
      if (!valid || secret !== "session" || caseId !== "caseA") {
        return Promise.reject(
          new RequestSpaceError("FORBIDDEN", "private ownership failure"),
        );
      }
      return Promise.resolve({
        ...pin,
        scope,
        caseId,
        executionSpaceId: "case-space-A",
      });
    },
  };
  const current = new CurrentProviderResources({
    scope,
    mainExecutionSpaceId: "main",
    main() {
      mainReads++;
      return pin;
    },
    cases,
    control: {
      authenticateSession(secret) {
        if (!valid || secret !== "session") {
          return Promise.reject(
            new RequestSpaceError(
              "FORBIDDEN",
              "private credential failure",
            ),
          );
        }
        return Promise.resolve({ ownerId: "owner" } as SpaceController);
      },
      revalidate() {
        if (!valid) {
          return Promise.reject(
            new RequestSpaceError("FORBIDDEN", "private revocation"),
          );
        }
        return Promise.resolve();
      },
    },
    reader: {
      read(query) {
        queries.push(query);
        afterRead?.();
        const aggregate = new ProviderResourceAggregation(query);
        for (const observation of observations) aggregate.add(observation);
        return Promise.resolve(aggregate.finish(
          "2026-10-30T00:00:01.000Z",
        ));
      },
    },
    clock: { now: () => "2026-10-30T00:00:00.000Z" },
  });
  return {
    current,
    pin,
    scope,
    cases,
    queries,
    mainReads: () => mainReads,
    caseReads: () => caseReads,
    revoke: () => {
      valid = false;
    },
    afterRead: (run: () => void) => {
      afterRead = run;
    },
  };
}

Deno.test("current resource reads capture trusted host Main execution and return the exact snapshot pin", async () => {
  const f = fixture();
  const expected = f.pin.modelVersion.repositoryVersion;
  f.afterRead(() =>
    Object.assign(f.pin, {
      runtimeRevision: 8,
      modelVersion: {
        digest: "c".repeat(64),
        repositoryVersion: `commit:${"d".repeat(40)}`,
      },
    })
  );
  await rejects(
    () => f.current.read("session", { expectedVersion: expected }),
    {
      code: "PROVIDER_RESOURCE_VERSION_MISMATCH",
    },
  );
  equal(f.queries.length, 1);
  equal(f.queries[0].modelDigest, "a".repeat(64));
  equal(f.caseReads(), 0);
});

Deno.test("explicit Case resource reads keep the controller-owned Case and never consult Main", async () => {
  const f = fixture();
  const result = await f.current.read("session", {
    caseId: "caseA",
    expectedVersion: f.pin.modelVersion.repositoryVersion,
  });
  equal(result.execution.kind, "case");
  equal(result.execution.caseId, "caseA");
  equal(f.queries[0].executionSpaceId, "case-space-A");
  equal(f.queries[0].caseId, "caseA");
  equal(f.mainReads(), 0);
  await rejects(() => f.current.read("session", { caseId: "foreignCase" }), {
    code: "PROVIDER_RESOURCE_FORBIDDEN",
  });
  equal(f.mainReads(), 0);
  equal(f.queries.length, 1);
});

Deno.test("missing session and other inspected versions refuse before aggregation", async () => {
  const f = fixture();
  await rejects(() => f.current.read("bad"), {
    code: "PROVIDER_RESOURCE_FORBIDDEN",
  });
  equal(f.mainReads(), 0);
  for (const caseId of [undefined, "caseA"]) {
    await rejects(
      () =>
        f.current.read("session", {
          caseId,
          expectedVersion: `commit:${"c".repeat(40)}`,
        }),
      {
        code: "PROVIDER_RESOURCE_VERSION_MISMATCH",
      },
    );
  }
  await rejects(() => f.current.read("session", { expectedVersion: "HEAD" }), {
    code: "PROVIDER_RESOURCE_INVALID_SELECTION",
  });
  deepStrictEqual(f.queries, []);
});

Deno.test("revocation during aggregation suppresses data and raw storage errors never escape", async () => {
  const f = fixture();
  f.afterRead(f.revoke);
  await rejects(() => f.current.read("session"), {
    code: "PROVIDER_RESOURCE_FORBIDDEN",
    message: "A current authorized local session is required.",
  });
  const failed = fixture();
  failed.afterRead(() => {
    throw new Error("private SQL and secret");
  });
  await rejects(() => failed.current.read("session"), {
    code: "PROVIDER_RESOURCE_UNAVAILABLE",
    message: "Observed provider resources are unavailable.",
  });
});

Deno.test("Case scope mismatch and absent actual model identity fail closed", async () => {
  const f = fixture();
  const original = f.cases.execution;
  f.cases.execution = async (secret, caseId) => ({
    ...await original(secret, caseId),
    scope: { ...f.scope, systemId: "foreign" },
  });
  await rejects(() => f.current.read("session", { caseId: "caseA" }), {
    code: "PROVIDER_RESOURCE_UNAVAILABLE",
  });
  equal(f.mainReads(), 0);
  equal(f.queries.length, 0);
  const missing = fixture();
  Object.assign(missing.pin, {
    modelVersion: { digest: "board-digest", repositoryVersion: undefined },
  });
  await rejects(() => missing.current.read("session"), {
    code: "PROVIDER_RESOURCE_UNAVAILABLE",
  });
  equal(missing.queries.length, 0);
});

Deno.test("adoption during Case aggregation refuses the old actual pin", async () => {
  const f = fixture();
  f.afterRead(() =>
    Object.assign(f.pin, {
      modelVersion: {
        digest: "d".repeat(64),
        repositoryVersion: `commit:${"e".repeat(40)}`,
      },
    })
  );
  await rejects(() => f.current.read("session", { caseId: "caseA" }), {
    code: "PROVIDER_RESOURCE_VERSION_MISMATCH",
  });
  equal(f.queries.length, 1);
  equal(f.queries[0].modelDigest, "a".repeat(64));
  equal(f.caseReads(), 2);
});

Deno.test("authorized Case readout preserves actual operator partitions within its exact retained pin", async () => {
  const call: ProviderCallObservation = {
    schemaVersion: 1,
    observationId: "00000000-0000-4000-8000-000000000001",
    provider: "anthropic",
    configuredModel: "model",
    startedAt: "2026-10-29T23:59:58.000Z",
    endedAt: "2026-10-29T23:59:59.000Z",
    elapsedMs: 1,
    outcome: "returned",
    correlation: {
      ...UNKNOWN_PROVIDER_CALL_CORRELATION,
      executionScope: {
        projectId: "host-project",
        systemId: "host-system",
        executionSpaceId: "case-space-A",
      },
      caseId: "caseA",
      operatorId: "native-operator",
      modelDigest: "a".repeat(64),
      repositoryVersion: `commit:${"b".repeat(40)}`,
    },
    usage: { input_tokens: 3 },
  };
  const observations = [
    call,
    {
      ...call,
      correlation: { ...call.correlation, operatorId: "peer" },
      usage: { input_tokens: 7 },
    },
    {
      ...call,
      correlation: { ...call.correlation, operatorId: null },
      usage: undefined,
    },
    // The same operator/native identity cannot substitute for Case or version.
    ...[
      { caseId: "caseB" },
      { modelDigest: "c".repeat(64) },
      { repositoryVersion: `commit:${"d".repeat(40)}` },
    ].map((correlation) => ({
      ...call,
      correlation: { ...call.correlation, ...correlation },
      usage: { input_tokens: 1000 },
    })),
    { ...call, endedAt: "2026-10-30T00:00:00.001Z" },
  ].map((observation, index) => ({
    ...observation,
    observationId: `00000000-0000-4000-8000-${
      String(index + 1).padStart(12, "0")
    }`,
  }));
  const f = fixture(observations);
  const result = await f.current.read("session", { caseId: "caseA" });
  equal(result.execution.operatorId, "native-operator");
  equal(result.resources.calls, 3);
  deepStrictEqual(
    result.resources.operatorGroups!.map((group) => [
      group.operatorId,
      group.calls,
      group.units.input_tokens.observedSubtotal,
    ]),
    [["native-operator", 1, 3], ["peer", 1, 7], [null, 1, null]],
  );
  equal(result.resources.units.input_tokens.observedSubtotal, 10);
  equal(result.resources.units.input_tokens.state, "partial");
  equal(result.resources.units.input_tokens.missingCalls, 1);
  equal(f.mainReads(), 0);
  equal(f.caseReads(), 2);
});

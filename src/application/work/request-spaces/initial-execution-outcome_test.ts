import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { invocationKey } from "../operators/journal.ts";
import type { NativeExecutionSnapshot } from "../native-execution/contract.ts";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
} from "../operators/execution.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  readRequestInitialExecutionOutcome,
  type RequestInitialExecutionReader,
} from "./initial-execution-outcome.ts";
function fixture() {
  const record = {
    scope: {
      projectId: "git:45a0a316-1773-4c47-80a5-b1688a28ab6c",
      systemId: "host-system",
    },
    caseId: "caseA",
    executionSpaceId: "independent-space",
    initialContributionId: "initial-input",
    base: { requestOwner: { operatorId: "Assembly::Primary" } },
  } as unknown as OpeningRecord;
  const version = {
    digest: "a".repeat(64),
    repositoryVersion: `commit:${"b".repeat(40)}`,
  };
  const state = {
    id: "native-id-is-not-host",
    busy: false,
    activeInputMessageId: record.initialContributionId,
    executionModel: { identity: { builderId: "Assembly::Primary" }, version },
    messages: [{
      id: record.initialContributionId,
      role: "user",
      caseId: record.caseId,
    }],
    cases: [{ id: record.caseId, status: "waiting" }],
  } as unknown as SystemRuntimeState;
  const delivery: OperatorExecutionDelivery = {
    id: record.initialContributionId,
    kind: "contribution",
    identity: {
      operatorId: "Assembly::Primary",
      invocationKey: invocationKey({ kind: "local", caseId: record.caseId }),
      scope: {
        kind: "request",
        scopeId: record.caseId,
        rootRequestId: record.caseId,
      },
      purpose: "conversation",
      subjectId: record.initialContributionId,
    },
    modelPin: {
      modelDigest: version.digest,
      repositoryVersion: version.repositoryVersion,
    },
  };
  const accepted = {
    receipt: {
      id: record.initialContributionId,
      threadId: "exact-thread",
      jobId: "job",
      status: "completed" as OperatorDeliveryReceipt["status"],
    },
    delivery,
  };
  const snapshot: NativeExecutionSnapshot = {
    identity: structuredClone(delivery.identity),
    contributionId: record.initialContributionId,
    threadId: "exact-thread",
    modelDigest: version.digest,
    repositoryVersion: version.repositoryVersion,
    flowRootId: "flow",
    status: "refused",
    refusal: {
      code: "NATIVE_EXECUTION_ADMISSION_REFUSED",
      nodeId: "private-node",
      message: "PRIVATE DIAGNOSTIC",
    },
    waits: [],
    unsettledEffects: [],
    pendingContributions: [],
  };
  const reads: unknown[] = [];
  let rows = [snapshot];
  const native: RequestInitialExecutionReader = {
    forCaseSpace: (space, caseId) => {
      reads.push({ space, caseId });
      return Promise.resolve({
        scope: { ...record.scope, executionSpaceId: space, caseId },
        dispatch: {
          inspectAccepted: (operator, id) => {
            reads.push({ operator, id });
            return Promise.resolve(accepted);
          },
        },
        execution: {
          inspect: (operator, selection) => {
            reads.push({ operator, selection });
            return Promise.resolve(rows);
          },
        },
      });
    },
  };
  return {
    record,
    state,
    snapshot,
    delivery,
    accepted,
    native,
    reads,
    rows: (value: NativeExecutionSnapshot[]) => {
      rows = value;
    },
    read: () => readRequestInitialExecutionOutcome(native, record, state),
  };
}
Deno.test("initial native refusal reads one owned accepted thread/contribution and returns only a static public value without mutation", async () => {
  const f = fixture(),
    before = structuredClone({
      record: f.record,
      state: f.state,
      snapshot: f.snapshot,
    });
  equal(await f.read(), "refused");
  deepStrictEqual(f.reads, [
    { space: "independent-space", caseId: "caseA" },
    { operator: "Assembly::Primary", id: "initial-input" },
    {
      operator: "Assembly::Primary",
      selection: { threadId: "exact-thread", contributionId: "initial-input" },
    },
  ]);
  deepStrictEqual(
    { record: f.record, state: f.state, snapshot: f.snapshot },
    before,
  );
  equal(JSON.stringify(await f.read()).includes("PRIVATE"), false);
});
Deno.test("completed delivery alone and non-refused, mismatched or unsettled native snapshots never become public refusal", async () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.rows([]);
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.status = "completed";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.status = "failed";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.status = "uncertain";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.threadId = "other-thread";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.contributionId = "later-input";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.identity.scope = {
          kind: "request",
          scopeId: "caseB",
          rootRequestId: "caseB",
        };
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.modelDigest = "other-model";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.refusal!.code = "OTHER_FAILURE";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.unsettledEffects = ["unknown-effect"];
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    equal(await f.read(), undefined);
  }
});
Deno.test("busy, closed, noninitial active input and absent canonical message skip native lookup rather than display stale opening refusal", async () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.state.busy = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.activeInputMessageId = "later-input";
      },
      (f: ReturnType<typeof fixture>) => {
        delete f.state.activeInputMessageId;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.cases![0].status = "closed-done";
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.messages = [];
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.messages[0].caseId = "caseB";
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    equal(await f.read(), undefined);
    deepStrictEqual(f.reads, []);
  }
});
Deno.test("wrong accepted Case, operator, subject, invocation, model or nonterminal receipt cannot supply refusal evidence", async () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.accepted.receipt.status = "queued";
      },
      (f: ReturnType<typeof fixture>) => {
        f.accepted.receipt.id = "other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.delivery.identity.operatorId = "other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.delivery.identity.scope = {
          kind: "request",
          scopeId: "caseB",
          rootRequestId: "caseB",
        };
      },
      (f: ReturnType<typeof fixture>) => {
        f.delivery.identity.subjectId = "other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.delivery.identity.invocationKey = "other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.delivery.modelPin.modelDigest = "other";
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    equal(await f.read(), undefined);
    equal(f.reads.length, 2);
  }
});

Deno.test("known closed execution scope skips active-only native view in a mixed historical read list", async () => {
  const closed = fixture(), active = fixture();
  closed.record.caseId = "closed-scope-case";
  closed.state.cases![0].id = closed.record.caseId;
  closed.state.messages[0].caseId = closed.record.caseId;
  const outcomes = await Promise.all([
    readRequestInitialExecutionOutcome(
      closed.native,
      closed.record,
      closed.state,
      () => Promise.resolve("closed"),
    ),
    readRequestInitialExecutionOutcome(
      active.native,
      active.record,
      active.state,
      () => Promise.resolve("active"),
    ),
  ]);
  deepStrictEqual(outcomes, [undefined, "refused"]);
  deepStrictEqual(closed.reads, []);
  equal(closed.state.cases![0].status, "waiting");
});
Deno.test("concurrent exact space closure suppresses only the active-view scope refusal and unrelated native errors propagate", async () => {
  const closed = fixture();
  closed.native.forCaseSpace = () =>
    Promise.reject(new Error("Case execution space is unavailable"));
  let reads = 0;
  equal(
    await readRequestInitialExecutionOutcome(
      closed.native,
      closed.record,
      closed.state,
      () => Promise.resolve(++reads === 1 ? "active" : "closed"),
    ),
    undefined,
  );
  equal(reads, 2);
  const corrupt = fixture();
  corrupt.native.forCaseSpace = () =>
    Promise.reject(new Error("UNRELATED_CORRUPTION"));
  await rejects(
    () =>
      readRequestInitialExecutionOutcome(
        corrupt.native,
        corrupt.record,
        corrupt.state,
        () => Promise.resolve("active"),
      ),
    /UNRELATED_CORRUPTION/,
  );
  const afterInspection = fixture();
  reads = 0;
  equal(
    await readRequestInitialExecutionOutcome(
      afterInspection.native,
      afterInspection.record,
      afterInspection.state,
      () => Promise.resolve(++reads === 1 ? "active" : "closed"),
    ),
    undefined,
  );
});

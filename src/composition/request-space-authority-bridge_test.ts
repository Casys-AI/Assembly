import { requestAuthorityLifecycleBindings } from "./request-space-authority-bridge.ts";
import type { OperatorAuthorityLifecycle } from "../application/work/runtime/ports/out/operator-authority-lifecycle.port.ts";
import type { RequestSpaceAuthorityBridge } from "../application/governance/request-space-authority-bridge.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import type { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import type { RequestExecutionBindingPort } from "../application/model/evolution/request-adoption-ports.ts";
import type { SystemRuntime } from "../application/work/runtime/system.ts";
import type { SystemRuntimeState } from "../domain/work/dialogue.ts";
import type { OperatorNotice } from "../domain/governance/operator-authority.ts";
import type { Case } from "../domain/work/entities/cases.ts";
import { branchAuthorityFixture } from "../../test/support/branch-authority-fixture.ts";
import { requestSpaceScope } from "../../test/support/request-space-fixture.ts";
import { eventually } from "../../test/support/eventually.ts";
import { OperatorAuthorityError } from "../domain/governance/operator-authority.ts";
import {
  bindMainAuthorityReplay,
  createRequestSpaceAuthorityBridge,
} from "./request-space-authority-bridge.ts";

/** The registered Main as the bridge reads it: a state, its listeners and the
 * notices it receives. Nothing here starts a turn. */
async function fixture(
  delegated?: Parameters<
    typeof createRequestSpaceAuthorityBridge
  >[0]["delegated"],
) {
  const { snapshot, mandate, teamProposal } = await branchAuthorityFixture();
  const main = snapshot.main!;
  delete main.designer;
  const listeners = new Set<(state: SystemRuntimeState) => void>();
  const delivered: Array<{
    notice: OperatorNotice;
    origin: Case["openedFrom"];
  }> = [];
  let replays = 0;
  const runtime = {
    get snapshot() {
      return main;
    },
    onState(listener: (state: SystemRuntimeState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resumeNoticeWakes: () => Promise.resolve(),
    receiveOperatorNotice(notice: OperatorNotice, origin: Case["openedFrom"]) {
      delivered.push({ notice, origin });
      return Promise.resolve();
    },
  } as unknown as SystemRuntime;
  const bridge = createRequestSpaceAuthorityBridge({
    storage: {
      scope: requestSpaceScope,
      client: {
        executionSpace: {
          findUnique: () => Promise.resolve(snapshot.space),
        },
      },
    } as unknown as PostgresHostStorage,
    openings: {
      forCase: () => Promise.resolve(snapshot.opening),
      openCaseIds: () => {
        replays++;
        return Promise.resolve(["case"]);
      },
    } as unknown as Pick<PostgresRequestSpaceStore, "forCase" | "openCaseIds">,
    bindings: {
      read: () =>
        Promise.resolve({
          admission: snapshot.admission,
          state: snapshot.request,
        }),
    } as unknown as RequestExecutionBindingPort,
    main: () => runtime,
    delegated,
  });
  return {
    bridge,
    runtime,
    main,
    mandate,
    delivered,
    snapshot,
    teamProposal,
    /** Replays that ran: each one lists the open Cases once. */
    replays: () => replays,
    /** What the runtime does after any persisted change. */
    emit() {
      for (const listener of listeners) listener(main);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("settlement boundary composition: an unbound creation executor routes the pending creation normally", async () => {
  const f = await fixture(() => undefined);
  const change = f.teamProposal();
  equal((await f.bridge.proposed("case", change.id)).status, "human-decision");
  equal(f.delivered.length, 1);
  equal(f.delivered[0].notice.kind, "authority-escalation");
  if (f.delivered[0].notice.kind === "authority-escalation") {
    equal(f.delivered[0].notice.changeId, change.id);
    equal(f.delivered[0].notice.decisionAuthority, "human");
  }
});

Deno.test("settlement boundary composition: late-bound creation defers source capture until settlement and preserves coded errors", async () => {
  let bound = false;
  let sourceReads = 0;
  const sourceError = new OperatorAuthorityError(
    "AUTHORITY_REQUEST_STALE",
    "The current source changed before publication",
    { caseId: "case" },
  );
  const delegated = {
    decision: {
      decide: () => {
        throw new Error("A failed source capture cannot decide a creation");
      },
      resume: () => {
        throw new Error("There is no recorded creation to resume");
      },
    } as never,
    sourceContext: () => {
      sourceReads++;
      return Promise.reject(sourceError);
    },
    now: () => "2026-11-02T00:00:00Z",
  };
  const f = await fixture(() => bound ? delegated : undefined);
  const change = f.teamProposal();
  await f.bridge.proposed("case", change.id);
  equal(sourceReads, 0);
  equal(f.delivered.length, 1);
  bound = true;
  await f.bridge.proposed("case", change.id);
  equal(sourceReads, 0);
  equal(f.delivered.length, 1);
  await rejects(() => f.bridge.settled("case"), (error) => {
    equal(error, sourceError);
    equal(sourceError.code, "AUTHORITY_REQUEST_STALE");
    return true;
  });
  equal(sourceReads, 1);
  equal(f.delivered.length, 1);
});

Deno.test("startup delivers a pending BO request to a Main the person never spoke with", async () => {
  const f = await fixture();
  equal(f.main.designer, undefined);
  equal(f.main.messages.length, 0);
  await bindMainAuthorityReplay(f.bridge, f.runtime);
  equal(f.delivered.length, 1, "the MO hears of the request at startup");
  deepStrictEqual(f.delivered[0].origin, {
    conversationId: "primary-runtime",
    designerScopeId: "primary-runtime:designer",
  });
  equal(f.delivered[0].notice.kind, "authority-escalation");
});

Deno.test("a Main whose model is absent waits, then the same request is replayed when it appears", async () => {
  const f = await fixture();
  const model = f.main.executionModel!;
  // No admitted policies at all: the model's appearance alone must be seen.
  delete model.operatorAuthorityPolicies;
  delete f.main.executionModel;
  await bindMainAuthorityReplay(f.bridge, f.runtime);
  equal(f.delivered.length, 0, "an unavailable Main receives nothing");
  f.main.executionModel = model;
  f.emit();
  await eventually(() => f.delivered.length === 1 || undefined, {
    timeoutMs: 5_000,
    label: "the request reaches the MO once it is back",
  });
});

Deno.test("a policy or a design scope change replays; any other state change does not", async () => {
  const f = await fixture();
  await bindMainAuthorityReplay(f.bridge, f.runtime);
  const startup = f.replays();
  equal(startup, 1);
  f.main.messages.push({
    id: "hello",
    role: "user",
    text: "Hello",
    at: "2026-10-31T00:00:00Z",
  });
  f.emit();
  await settle();
  equal(f.replays(), startup, "a message alone does not replay");
  // The scope the first designer turn persists is the one already derived.
  f.main.designer = { scopeId: "primary-runtime:designer" };
  f.emit();
  await settle();
  equal(f.replays(), startup, "the derived scope appearing does not replay");
  f.mandate("branch");
  f.emit();
  await eventually(() => f.replays() === startup + 1 || undefined, {
    timeoutMs: 5_000,
    label: "a new mandate may flip the route",
  });
  f.main.designer = { scopeId: "legacy:designer" };
  f.emit();
  await eventually(() => f.replays() === startup + 2 || undefined, {
    timeoutMs: 5_000,
    label: "another design scope is routed again",
  });
});

const empty = {
  policies: [],
  requests: [],
  awaitingPerson: [],
  awaitingPersonTruncated: false,
};
function lifecycleFixture(
  policies: unknown[],
  ids = ["bo", "member"],
  fail = false,
  owner = "bo",
) {
  let lifecycle!: OperatorAuthorityLifecycle;
  let views = 0;
  let reads = 0;
  const record = {
    caseId: "case",
    executionSpaceId: "space",
    base: { requestOwner: { operatorId: owner } },
  };
  const target = {
    snapshot: {
      executionModel: {
        identity: { builderId: "bo" },
        operatorAuthorityPolicies: policies,
      },
    },
    bindOperatorAuthorityLifecycle(value: OperatorAuthorityLifecycle) {
      lifecycle = value;
    },
  } as unknown as SystemRuntime;
  const bridge = {
    branchView() {
      views++;
      if (fail) throw new Error("binding missing");
      return Promise.resolve({ ...empty, policies });
    },
    decideInBranch() {
      throw new Error("revalidation attempted");
    },
  } as unknown as RequestSpaceAuthorityBridge;
  const bindings = requestAuthorityLifecycleBindings(
    bridge,
    undefined,
    undefined,
    () => {
      reads++;
      return Promise.resolve(ids);
    },
  );
  bindings.bindRequestAuthority!(record as never, target);
  return {
    lifecycle,
    get views() {
      return views;
    },
    get reads() {
      return reads;
    },
  };
}
const policy = { enabled: true, holderNativeId: "bo", recipients: ["member"] };
Deno.test("branch decision context avoids bridge unless enabled holder policy names an admitted member in this space", async () => {
  for (
    const policies of [
      [],
      [{ ...policy, enabled: false }],
      [{ ...policy, holderNativeId: "other" }],
      [{ ...policy, recipients: ["bo"] }],
      [{ ...policy, recipients: ["unrelated"] }],
      [{ ...policy, recipientExecutionSpaceId: "foreign" }],
    ]
  ) {
    const f = lifecycleFixture(policies);
    equal(await f.lifecycle.decisionContext!(), undefined);
    equal(f.views, 0);
    if (!policies.length) equal(f.reads, 0);
  }
  const nonOwner = lifecycleFixture([policy], ["bo", "member"], false, "other");
  equal(await nonOwner.lifecycle.decisionContext!(), undefined);
  equal(nonOwner.views, 0);
  equal(nonOwner.reads, 0);
  const f = lifecycleFixture([policy]);
  deepStrictEqual(await f.lifecycle.decisionContext!(), {
    ...empty,
    policies: [policy],
  });
  equal(f.views, 1);
});
Deno.test("branch context proof failure is coded and does not grant a decision; decision revalidates", async () => {
  const f = lifecycleFixture([policy], ["bo", "member"], true);
  const result = await f.lifecycle.decisionContext!();
  equal(result?.policies.length, 0);
  equal(result?.requests.length, 0);
  equal(result?.error?.code, "AUTHORITY_CONTEXT_UNAVAILABLE");
  equal(result?.error?.context.caseId, "case");
  equal(typeof result?.error?.recovery, "string");
  await rejects(
    () => f.lifecycle.decide!({ changeId: "change" } as never, {} as never),
    /revalidation attempted/,
  );
});

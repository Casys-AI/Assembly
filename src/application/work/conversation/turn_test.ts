import { equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { selectDesignerInvocation } from "../cases/runtime.ts";
import { runTurn } from "./turn.ts";
import type { ConversationTurnHost } from "./turn-context.ts";

function fixture() {
  const current = executableFixture({
    projectId: "turn-project",
    editingContextId: "turn-context",
    rootId: "turn-root",
    systemId: "turn-system",
    catalogId: "turn-catalog",
    builderId: "operator",
  });
  current.version.repositoryVersion = "commit:exact";
  const state: SystemRuntimeState = {
    id: "turn-test",
    revision: 1,
    catalogRevision: 0,
    executionModel: current,
    model: current.identity,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "fixture",
  };
  selectDesignerInvocation(state);
  let reads = 0;
  const host = {
    state,
    get snapshot() {
      return structuredClone(state);
    },
    ports: { clock: { now: () => "2026-11-03T00:00:00.000Z" } },
    update: (change: (state: SystemRuntimeState) => void) => {
      change(state);
      return Promise.resolve();
    },
    currentModel: () => {
      reads++;
      return Promise.resolve(current);
    },
  } as unknown as ConversationTurnHost;
  return { current, state, host, reads: () => reads };
}

Deno.test("runTurn pins the admitted model before requiring its native ports", async () => {
  const f = fixture();
  await rejects(
    () =>
      runTurn.call(f.host, undefined, {
        id: "turn:input-1",
        kind: "resume",
        inputMessageId: "input-1",
      }),
    /Native execution and immutable state history ports are required/,
  );
  // The admitted pin is read before the port guard rejects the turn.
  equal(f.reads(), 1);
});

for (const failure of [false, true]) {
  Deno.test(`runTurn flushes native events after ${failure ? "failure" : "success"} and deduplicates replay`, async () => {
    const f = fixture();
    let updates = 0;
    f.host.update = (change) => {
      updates++;
      change(f.state);
      return Promise.resolve();
    };
    f.host.executionReference = (model, element) => ({
      ...element,
      digest: model.version.digest,
      sourceIds: model.version.sourceIds,
      repositoryVersion: model.version.repositoryVersion,
    });
    const stopped = new Error("native failed");
    const execution: Pick<
      NonNullable<ConversationTurnHost["ports"]["execution"]>,
      "run"
    > = {
      run: async (_request, handlers) => {
        const before = updates;
        await handlers.recoverEvents!([{
          event: {
            kind: "action",
            actionId: "action-1",
            step: 1,
            modelDigest: "observed-digest",
            modelSourceIds: ["observed-source"],
            repositoryVersion: "commit:observed",
            source: { file: "fixture.sysml", line: 1 },
          } as Parameters<typeof handlers.onEvent>[0],
          firstRecordedAt: "2026-11-02T00:00:00.000Z",
        }]);
        equal(
          updates,
          before,
          "recovery only buffers authoritative observations",
        );
        for (const step of [1, 2]) {
          await handlers.onEvent(
            {
              kind: "action",
              actionId: `action-${step}`,
              step,
              modelDigest: "observed-digest",
              modelSourceIds: ["observed-source"],
              repositoryVersion: "commit:observed",
              source: { file: "fixture.sysml", line: 1 },
            } as Parameters<typeof handlers.onEvent>[0],
          );
          equal(updates, before, "observations do not rewrite state per event");
        }
        if (failure) throw stopped;
        return {} as Awaited<ReturnType<typeof execution.run>>;
      },
    };
    Object.assign(f.host.ports, { execution, stateHistory: {} });
    const run = () =>
      runTurn.call(f.host, undefined, {
        id: "input",
        kind: "resume",
        inputMessageId: "input",
      });
    if (failure) await rejects(run, (error) => error === stopped);
    else await run();
    equal(f.state.events.length, 2);
    equal(f.state.events[0].at, "2026-11-02T00:00:00.000Z");
    equal(f.state.events[0].execution?.digest, "observed-digest");
    equal(f.state.events[0].execution?.sourceIds?.[0], "observed-source");
    equal(f.state.events[0].execution?.repositoryVersion, "commit:observed");
    equal(f.state.events[0].execution?.actionId, "action-1");
    equal(f.state.events[1].execution?.actionId, "action-2");
    if (failure) await rejects(run, (error) => error === stopped);
    else await run();
    equal(f.state.events.length, 2, "replayed native IDs remain unique");
  });
}

Deno.test("native actions reuse the exact model checked at their authority boundary", async () => {
  const f = fixture();
  let effects = 0;
  f.host.action = (_node, effect, verified) => {
    equal(verified, f.current, "action receives its boundary-checked model");
    effects++;
    return effect(verified!);
  };
  const node = f.current.flows.conversation.nodes.find((n) =>
    n.mechanism === "read_case"
  )!;
  Object.assign(f.host.ports, {
    stateHistory: {},
    execution: {
      run: async (
        _request: unknown,
        handlers:
          import("../native-execution/contract.ts").NativeExecutionHandlers,
      ) => {
        await handlers.assertBoundary(node);
        await handlers.handle(node, {}, {}, {
          localState: {},
          effectKey: "effect",
          contributionId: "input",
          inputMessageId: "input",
          resumed: false,
        });
        f.host.currentModel = () =>
          Promise.resolve({
            ...f.current,
            version: { ...f.current.version, digest: "unauthorized-head" },
          });
        await rejects(
          () => handlers.assertBoundary(node),
          /exact admitted model pin/,
        );
        return {};
      },
    },
  });
  await runTurn.call(f.host, undefined, {
    id: "input",
    kind: "resume",
    inputMessageId: "input",
  });
  equal(effects, 1);
  equal(f.reads(), 2, "one initial pin read and one action boundary read");
});

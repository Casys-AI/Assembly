import { deepStrictEqual, equal } from "node:assert/strict";
import { act } from "preact/test-utils";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import { board, item, tool, unit } from "../../test/support/board-fixture.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import {
  type AppearanceTimer,
  TOOL_APPEARANCE_MS,
  useToolAppearance,
} from "./useToolAppearance.ts";

const model = (tools: readonly string[], label = "search"): ModelBoard =>
  board({
    team: [unit({ id: "u", title: "u" })],
    cando: [
      ...tools.map((id) => tool(id, "u", label)),
      item("skill", "skill", "Same name", { scope: "u" }),
    ],
  });

async function withAppearance(
  run: (probe: {
    show(board: ModelBoard, historical?: boolean): Promise<void>;
    ids(): readonly string[];
    timers: Map<number, { callback: () => void; delay: number }>;
    fire(id: number): Promise<void>;
    hide(): Promise<void>;
  }) => Promise<void>,
) {
  const root = probeRoot();
  let latest: ReadonlySet<string> = new Set();
  let next = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const clock: AppearanceTimer = {
    after(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, delay });
      return () => void timers.delete(id);
    },
  };
  function Probe(
    { board, historical }: { board: ModelBoard; historical: boolean },
  ) {
    latest = useToolAppearance(board, historical, clock);
    return null;
  }
  try {
    await run({
      show: (board, historical = false) =>
        root.show(Probe, { board, historical }),
      ids: () => [...latest],
      timers,
      fire: (id) =>
        act(() => {
          const callback = timers.get(id)?.callback;
          timers.delete(id);
          callback?.();
        }),
      hide: root.unmount,
    });
  } finally {
    await root.restore();
  }
}

Deno.test("the actual appearance hook only signals tools added after a current baseline and expires them", async () => {
  await withAppearance(async ({ show, ids, timers, fire }) => {
    const first = model(["existing"]);
    await show(first);
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
    // A new board whose labels changed is still the same native declaration.
    await show(model(["existing"], "renamed"));
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
    await show(model(["existing", "new"]));
    deepStrictEqual(ids(), ["new"]);
    equal(timers.size, 1);
    equal([...timers.values()][0].delay, TOOL_APPEARANCE_MS);
    await fire([...timers.keys()][0]);
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
  });
});

Deno.test("a later board cancels the earlier timer and a late callback cannot hide the new indication", async () => {
  await withAppearance(async ({ show, ids, timers }) => {
    await show(model([]));
    await show(model(["first"]));
    const earlier = [...timers.values()][0].callback;
    const earlierId = [...timers.keys()][0];
    await show(model(["first", "second"]));
    equal(timers.has(earlierId), false);
    equal(timers.size, 1);
    deepStrictEqual(ids(), ["second"]);
    await act(earlier);
    deepStrictEqual(ids(), ["second"]);
  });
});

Deno.test("history neither borrows current appearances nor supplies a baseline when returning to the present", async () => {
  await withAppearance(async ({ show, ids, timers }) => {
    await show(model(["current"]));
    await show(model(["current", "added"]));
    deepStrictEqual(ids(), ["added"]);
    await show(model(["old"]), true);
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
    await show(model(["old", "historical-change"]), true);
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
    await show(model(["current", "added", "while-away"]));
    deepStrictEqual(ids(), []);
    equal(timers.size, 0);
    await show(model(["current", "added", "while-away", "fresh"]));
    deepStrictEqual(ids(), ["fresh"]);
  });
});

Deno.test("unmounting the appearance hook cleans its pending timer", async () => {
  await withAppearance(async ({ show, timers, hide }) => {
    await show(model([]));
    await show(model(["new"]));
    equal(timers.size, 1);
    await hide();
    equal(timers.size, 0);
  });
});

Deno.test("a real published catalogue part signals its existing Explore unit without a new contract", async () => {
  const projected = (candidates: string[], title = "u"): ModelBoard => {
    const root = unit({ id: "u", title, operator: "native-owner" });
    return board({
      team: [{
        ...root,
        children: root.children!.map((child) =>
          child.id === "u.catalog"
            ? {
              ...child,
              children: candidates.map((id) =>
                item(id, "machine", "tool_same", {
                  type: {
                    title: "ToolCandidate",
                    qname: "ASELiveBuilder::ToolCandidate",
                  },
                })
              ),
            }
            : child
        ),
      }],
      cando: [tool("existing-contract", "u", "read_web_page")],
    });
  };
  await withAppearance(async ({ show, ids, timers, fire }) => {
    await show(projected([]));
    deepStrictEqual(ids(), []);
    await show(projected(["native-candidate-one"]));
    deepStrictEqual(ids(), ["u"]);
    equal(timers.size, 1);
    await fire([...timers.keys()][0]);
    deepStrictEqual(ids(), []);
    // Another admission in the same unit is a different occurrence, not a
    // duplicate of the container's first appearance.
    await show(projected(["native-candidate-one", "native-candidate-two"]));
    deepStrictEqual(ids(), ["u"]);
    await show(
      projected(["native-candidate-one", "native-candidate-two"], "renamed"),
    );
    deepStrictEqual(ids(), []);
    await show(projected(["historical"]), true);
    equal(timers.size, 0);
    deepStrictEqual(ids(), []);
    await show(
      projected(["native-candidate-one", "native-candidate-two", "while-away"]),
    );
    deepStrictEqual(ids(), []);
  });
});

import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  blockedWorkTasks,
  MAX_WORK_TASKS,
  parseWorkTasks,
  readyWorkTasks,
  validateWorkGraph,
  type WorkTaskDraft,
  type WorkTaskRecord,
  type WorkTaskState,
} from "./plans.ts";

function draft(id: string, dependsOn: string[] = []): WorkTaskDraft {
  return {
    id,
    behaviorId: `behavior:${id}`,
    input: { text: id, facts: { value: 1 } },
    dependsOn,
  };
}

function task(
  id: string,
  state: WorkTaskState = "pending",
  dependsOn: string[] = [],
): WorkTaskRecord {
  return {
    id,
    dependsOn,
    resourceId: `resource:${id}`,
    inputDigest: `digest:${id}`,
    state,
    invocation: {
      invocationId: `plan:task:${id}`,
      callerId: "coordinator",
      modelVersion: { digest: "model", repositoryVersion: "commit:pinned" },
      behavior: {
        id: `behavior:${id}`,
        name: id,
        description: id,
        targetNativeId: `inbox:${id}`,
        targetTypeId: "work-inbox-type",
        inputTypeId: "request-type",
        callerNativeId: "coordinator",
        sourceIds: [`source:${id}`],
        inputSchema: { type: "object" },
      },
      input: { text: id },
    },
  };
}

Deno.test("work task parsing keeps declared identifiers, inputs and future dependencies without aliases", () => {
  const source = [draft("last", ["first"]), draft("first")];
  const before = structuredClone(source);
  const parsed = parseWorkTasks(source);
  deepStrictEqual(parsed, source);
  deepStrictEqual(source, before);
  (parsed[0]!.input.facts as { value: number }).value = 99;
  parsed[0]!.dependsOn.push("another");
  deepStrictEqual(source, before);
});

Deno.test("work task parsing rejects malformed representation and undeclared routing fields", () => {
  const good = draft("task");
  for (
    const input of [
      null,
      {},
      "[]",
      [],
      [null],
      [[good]],
      [{ ...good, id: "" }],
      [{ ...good, id: "   " }],
      [{ ...good, id: "x".repeat(129) }],
      [{ ...good, behaviorId: 42 }],
      [{ ...good, behaviorId: "" }],
      [{ ...good, input: null }],
      [{ ...good, input: [] }],
      [{ ...good, input: new Date() }],
      [{ ...good, dependsOn: "first" }],
      [{ ...good, dependsOn: [42] }],
      [{ ...good, agentId: "unadmitted-target" }],
      [{ id: "task", behaviorId: "behavior", input: {} }],
    ]
  ) {
    throws(() => parseWorkTasks(input), /Invalid work plan/);
  }
});

Deno.test("the task graph is closed, unique, bounded and acyclic across every component", () => {
  for (
    const graph of [
      [],
      [draft("one"), draft("one")],
      [draft("one", ["missing"])],
      [draft("one", ["one"])],
      [draft("one"), draft("two", ["one", "one"])],
      [draft("a", ["b"]), draft("b", ["a"])],
      [draft("independent"), draft("a", ["b"]), draft("b", ["a"])],
      Array.from({ length: MAX_WORK_TASKS + 1 }, (_, i) => draft(`t${i}`)),
    ]
  ) {
    throws(() => validateWorkGraph(graph), /Invalid work plan/);
    throws(() => parseWorkTasks(graph), /Invalid work plan/);
  }
  const maximum = Array.from(
    { length: MAX_WORK_TASKS },
    (_, i) => draft(`t${i}`, i ? [`t${i - 1}`] : []),
  );
  equal(parseWorkTasks(maximum).length, MAX_WORK_TASKS);
});

Deno.test("graph identities are map keys rather than JavaScript object properties", () => {
  const source = [
    draft("toString", ["constructor"]),
    draft("__proto__"),
    draft("constructor", ["__proto__"]),
  ];
  deepStrictEqual(parseWorkTasks(source), source);
  validateWorkGraph(source);
});

Deno.test("only completed dependencies release pending work, in declaration order", () => {
  const source = [
    task("after-running", "pending", ["running"]),
    task("independent"),
    task("after-completed", "pending", ["complete"]),
    task("after-waiting", "pending", ["waiting"]),
    task("running", "running"),
    task("waiting", "waiting"),
    task("complete", "completed"),
    task("already-blocked", "blocked"),
  ];
  const before = structuredClone(source);
  deepStrictEqual(
    readyWorkTasks(source).map((item) => item.id),
    ["independent", "after-completed"],
  );
  deepStrictEqual(source, before);
});

Deno.test("failure and interruption block direct dependents while waiting stays pending", () => {
  const source = [
    task("after-failure", "pending", ["failed"]),
    task("after-block", "pending", ["blocked"]),
    task("after-interruption", "pending", ["interrupted"]),
    task("after-waiting", "pending", ["waiting"]),
    task("next-generation", "pending", ["after-failure"]),
    task("failed", "failed"),
    task("blocked", "blocked"),
    task("interrupted", "interrupted"),
    task("waiting", "waiting"),
  ];
  const before = structuredClone(source);
  deepStrictEqual(
    blockedWorkTasks(source).map((item) => item.id),
    ["after-failure", "after-block", "after-interruption"],
  );
  deepStrictEqual(source, before);
  source.find((item) => item.id === "after-failure")!.state = "blocked";
  deepStrictEqual(
    blockedWorkTasks(source).map((item) => item.id),
    ["after-block", "after-interruption", "next-generation"],
  );
});

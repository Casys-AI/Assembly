import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  ANALYST,
  board,
  COORDINATOR,
  item,
  link,
  port,
  structuredBoard,
  unit,
  watchBoard,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import { partsOf } from "./parts.ts";

const OPERATOR = `${COORDINATOR}.operator`;
const SANDBOX = `${COORDINATOR}.sandbox`;
const CATALOG = `${COORDINATOR}.catalog`;

Deno.test("each unit lists its operators first and then the platform they rely on", () => {
  const units = partsOf(structuredBoard());
  deepStrictEqual(units.map((entry) => entry.unit.id), [
    COORDINATOR,
    ANALYST,
    "unit-collector",
  ]);
  const coordinator = units[0];
  deepStrictEqual(coordinator.operators.map((part) => part.item.id), [
    OPERATOR,
  ]);
  deepStrictEqual(coordinator.platform.map((part) => part.item.id), [
    SANDBOX,
    CATALOG,
  ]);
});

Deno.test("parts nest as the model nests them, each with its ports", () => {
  const [coordinator] = partsOf(structuredBoard());
  const sandbox = coordinator.platform[0];
  deepStrictEqual(sandbox.ports.map((line) => line.port.title), [
    "proposals",
    "results",
  ]);
  deepStrictEqual(sandbox.parts.map((part) => part.item.id), [
    `${SANDBOX}.runner`,
  ]);
  deepStrictEqual(sandbox.parts[0].ports.map((line) => line.port.title), [
    "runs",
  ]);
  // The ports the unit declares itself are its own.
  const ported = board({
    team: [{ ...unit({ id: "u", title: "u" }), ports: [port("u.p", "p")] }],
  });
  deepStrictEqual(partsOf(ported)[0].ports.map((line) => line.port.id), [
    "u.p",
  ]);
});

Deno.test("a port is connected when the board counts a connection or a connect of the model ends at it; otherwise it is open", () => {
  const [coordinator] = partsOf(structuredBoard());
  const state = (id: string) =>
    [...coordinator.operators, ...coordinator.platform]
      .flatMap(
        function lines(part): ReturnType<typeof partsOf>[0]["ports"][number][] {
          return [...part.ports, ...part.parts.flatMap(lines)];
        },
      )
      .find((line) => line.port.id === id)?.connected;
  // The board counts one.
  equal(state(`${OPERATOR}.proposals`), true);
  // The model connects it, the board does not count it.
  equal(state(`${SANDBOX}.runner.runs`), true);
  equal(state(`${CATALOG}.candidates`), true);
  // Nothing reaches it.
  equal(state(`${SANDBOX}.results`), false);
  // A count of zero is not a connection.
  const zero = board({
    team: [{
      ...unit({ id: "u", title: "u" }),
      ports: [port("u.p", "p", { linked: 0 })],
    }],
  });
  equal(partsOf(zero)[0].ports[0].connected, false);
});

Deno.test("a unit lists the connections that start inside it, with their ends resolved", () => {
  const units = partsOf(structuredBoard());
  deepStrictEqual(
    units[0].connections.map(({ from, to }) => [from, to]),
    [
      [`${OPERATOR}.proposals`, `${SANDBOX}.proposals`],
      [`${SANDBOX}.runner.runs`, `${CATALOG}.candidates`],
    ],
  );
  equal(units[1].connections.length, 0);
  // A connection starting in one unit and ending in another is the first one's.
  const across = withLinks(watchBoard(), [
    link("connect", `${COORDINATOR}.sandbox`, `${ANALYST}.sandbox`),
    // Not a connection.
    link("allocate", `${ANALYST}.sandbox`, `${COORDINATOR}.sandbox`),
  ]);
  const [first, second] = partsOf(across);
  equal(first.connections.length, 1);
  equal(second.connections.length, 0);
});

Deno.test("a connection the board holds only by its end is the unit's that holds that end; one it holds by neither end is nobody's", () => {
  const model = withLinks(structuredBoard(), [
    // The start is unknown: the page would say a port is reached with nothing reaching it.
    link("connect", "ghost.start", `${SANDBOX}.results`),
    link("connect", `${OPERATOR}.proposals`, "ghost.end"),
    link("connect", "ghost.a", "ghost.b"),
  ]);
  const ends = (index: number) =>
    partsOf(model)[index].connections.map(({ from, to }) => [from, to]);
  deepStrictEqual(ends(0), [
    ["ghost.start", `${SANDBOX}.results`],
    [`${OPERATOR}.proposals`, "ghost.end"],
  ]);
  // The other units list none of them, and nothing lists the one nobody holds.
  deepStrictEqual(ends(1), []);
  equal(
    partsOf(model).flatMap((entry) => entry.connections).filter((entry) =>
      entry.from === "ghost.a"
    ).length,
    0,
  );
  // The port it reaches is connected, and the page lists the connection that says so.
  const [coordinator] = partsOf(model);
  const results = coordinator.platform[0].ports.find((line) =>
    line.port.id === `${SANDBOX}.results`
  );
  equal(results?.connected, true);
});

Deno.test("a model without a unit has no structure; a unit without parts is still a unit", () => {
  deepStrictEqual(partsOf(board({})), []);
  const bare = board({
    team: [{ ...unit({ id: "u", title: "u" }), children: undefined }],
  });
  const [only] = partsOf(bare);
  deepStrictEqual([only.operators, only.platform, only.connections], [
    [],
    [],
    [],
  ]);
  // A part that is not an operator is the platform, whatever its kind.
  const odd = board({
    team: [{
      ...unit({ id: "u", title: "u" }),
      children: [item("u.x", "tool", "x"), item("u.y", "operator", "y")],
    }],
  });
  const [oddUnit] = partsOf(odd);
  ok(oddUnit.platform.some((part) => part.item.id === "u.x"));
  deepStrictEqual(oddUnit.operators.map((part) => part.item.id), ["u.y"]);
});

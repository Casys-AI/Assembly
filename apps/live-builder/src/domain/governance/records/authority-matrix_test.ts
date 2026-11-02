import assert from "node:assert/strict";
import {
  BY_HUMAN,
  isMatrixCellCode,
  MATRIX_BEHAVIOR_KINDS,
  MATRIX_FIXED_COLUMN_IDS,
  type MatrixColumnKey,
  type MatrixEnforcementAnchor,
  parseMatrixColumnId,
  UNUSABLE,
} from "./authority-matrix.ts";
import {
  fixtureCellCodes,
  fixtureColumnIds,
  fixtureOwners,
} from "../../../../test/support/authority-matrix-fixtures.ts";
import type { BoardGrant } from "../../model/records/board.ts";
import type { MatrixScope } from "./authority-matrix.ts";

Deno.test("matrix ids and codes cover typed prototype fixtures at runtime", () => {
  for (const id of fixtureColumnIds) {
    assert.equal(parseMatrixColumnId(id).id, id);
  }
  for (const id of MATRIX_FIXED_COLUMN_IDS) {
    assert.equal(parseMatrixColumnId(id).kind, "fixed");
  }
  for (const kind of MATRIX_BEHAVIOR_KINDS) {
    assert.equal(
      parseMatrixColumnId(`behavior:${kind}@Example::unit`).kind,
      "behavior",
    );
  }
  for (const code of [...fixtureCellCodes, ...UNUSABLE, ...BY_HUMAN]) {
    assert.ok(isMatrixCellCode(code), code);
  }
  assert.equal(isMatrixCellCode("UNKNOWN_CODE"), false);
});

Deno.test("matrix column parsing refuses unknown capabilities and malformed units", () => {
  for (
    const id of [
      "model.destroy",
      "tool.build:arbitrary",
      "mandate.change:arbitrary",
      "behavior:unknown@A::unit",
      "behavior:inbox@",
      "behavior:inbox@A::",
      "behavior:inbox@A\n::unit",
      "behavior:memory-arbitrary@A::unit",
      "behavior:skill-arbitrary@A::unit",
      "tool.invoke@A::unit",
    ]
  ) {
    assert.throws(
      () => parseMatrixColumnId(id),
      /Invalid authority matrix column/,
    );
  }
});

Deno.test("matrix owner fixtures preserve implicit versus modeled authority", () => {
  const [legacy, , modeled] = fixtureOwners;
  assert.equal(legacy.authoritySchema, "legacy-v1");
  assert.equal(legacy.row.declared, false);
  assert.equal("element" in legacy.row, false);
  assert.deepEqual(legacy.cell.codes, ["OWNER_IMPLICIT"]);
  assert.equal(legacy.cell.via.kind, "host-rule");
  assert.equal(modeled.authoritySchema, "owner-modeled");
  assert.equal(modeled.row.declared, true);
  assert.ok(modeled.row.element.elementId);
  assert.equal(modeled.cell.via.kind, "root-grant");
});

Deno.test("matrix columns discriminate ids and host references are symbolic", () => {
  const key = {
    kind: "behavior",
    id: "behavior:inbox@Example::unit",
  } as const satisfies MatrixColumnKey;
  assert.deepEqual(parseMatrixColumnId(key.id), key);
  // @ts-expect-error A behavior id cannot inhabit a fixed column.
  const wrong: MatrixColumnKey = {
    kind: "fixed",
    id: "behavior:inbox@Example::unit",
  };
  const unknown: MatrixColumnKey = {
    kind: "behavior",
    // @ts-expect-error Unknown capability families do not widen to string.
    id: "behavior:unknown@unit",
  };
  // @ts-expect-error Source coordinates are not symbolic host anchors.
  const coordinate: MatrixEnforcementAnchor =
    "src/adapters/model-source-authorization.ts:127";
  assert.ok(wrong && unknown && coordinate);
});

Deno.test("matrix scopes reuse the board's readonly canonical grants", () => {
  const grants: readonly BoardGrant[] = [{
    file: "mission.sysml",
    qualifiedRoots: ["Example::policy"],
  }];
  const scope: MatrixScope = { grants };
  assert.equal(scope.grants, grants);
  const invalidMutations = () => {
    // @ts-expect-error Read-only roots retain the canonical grant boundary.
    scope.grants![0].qualifiedRoots.push("Other");
    // @ts-expect-error No independent string grant vocabulary.
    const bad: MatrixScope = { grants: "mayAdmitOwnCandidates" };
    assert.ok(bad);
  };
  assert.equal(typeof invalidMutations, "function");
});

Deno.test("matrix qualifier groups cannot be emitted as cell codes", () => {
  assert.equal(isMatrixCellCode("UNUSABLE"), false);
  assert.equal(isMatrixCellCode("BY_HUMAN"), false);
  for (const code of [...UNUSABLE, ...BY_HUMAN]) {
    assert.equal(isMatrixCellCode(code), true);
  }
});

Deno.test("matrix contract requires the adopted caveat and coherent column groups and targets", async () => {
  const { matrixFixture } = await import(
    "../../../../test/support/authority-matrix-fixtures.ts"
  );
  type Matrix = import("./authority-matrix.ts").AuthorityMatrix;
  type Column = import("./authority-matrix.ts").MatrixColumn;
  const tool = {
    kind: "tool-build",
    id: "tool.build:read_web_page",
    group: "tools",
    target: { kind: "tool-kind", ref: "read_web_page" },
    capability: "BuildTool",
    inTypedPlan: true,
    label: "Build web reader",
    mode: "propose",
    tier: "core",
    order: 1,
    typedScope: "missing-in-plan",
    doc: "Build a web reader.",
  } as const satisfies Column;
  const wrongGroup = { ...tool, group: "behaviors" } as const;
  // @ts-expect-error A tool-build column belongs to tools.
  const wrongGroupColumn: Column = wrongGroup;
  const wrongTarget = {
    ...tool,
    target: { kind: "change", ref: "reviewer" },
  } as const;
  // @ts-expect-error A tool-build column targets its tool kind.
  const wrongTargetColumn: Column = wrongTarget;
  const wrongRef = {
    ...tool,
    target: { kind: "tool-kind", ref: "read_web_page_outline" },
  } as const;
  // @ts-expect-error Id and target ref describe the same tool kind.
  const wrongRefColumn: Column = wrongRef;
  const memory = {
    ...tool,
    kind: "behavior",
    id: "behavior:memory-recall@Example::unit",
    group: "memory-skills",
    target: { kind: "entry-kind", ref: "memory-recall", unit: "Example::unit" },
  } as const satisfies Column;
  const wrongMemory = { ...memory, group: "behaviors" } as const;
  // @ts-expect-error A memory entry belongs to memory-skills.
  const wrongMemoryColumn: Column = wrongMemory;
  const absentCaveat = { ...matrixFixture(), caveats: [] } as const;
  // @ts-expect-error ADOPTED_VERSION_ONLY is required at the start of caveats.
  const withoutCaveat: Matrix = absentCaveat;
  assert.equal(matrixFixture().caveats[0], "ADOPTED_VERSION_ONLY");
  assert.ok(
    wrongGroupColumn && wrongTargetColumn && wrongRefColumn &&
      wrongMemoryColumn && withoutCaveat,
  );
});

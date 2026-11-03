import assert from "node:assert/strict";
import type * as Matrix from "../../src/domain/governance/records/authority-matrix.ts";
import type { BoardGrant } from "../../src/domain/model/records/board.ts";

const closedKeys = {
  matrix: {
    schema: true,
    version: true,
    model: true,
    groups: true,
    rows: true,
    columns: true,
    cells: true,
    delegations: true,
    diagnostics: true,
    caveats: true,
    summary: true,
    digest: true,
  } satisfies Record<keyof Matrix.AuthorityMatrix, true>,
  model: {
    name: true,
    sourceDigest: true,
    toolkit: true,
    authoritySchema: true,
    units: true,
  } satisfies Record<keyof Matrix.AuthorityMatrix["model"], true>,
  unit: { system: true, executionDigest: true } satisfies Record<
    keyof Matrix.AuthorityMatrix["model"]["units"][number],
    true
  >,
  group: { id: true, label: true, order: true } satisfies Record<
    keyof Matrix.MatrixGroup,
    true
  >,
  row: {
    id: true,
    kind: true,
    role: true,
    label: true,
    unit: true,
    declared: true,
    element: true,
    endpoint: true,
    limits: true,
    principal: true,
  } satisfies Record<keyof Matrix.MatrixRow, true>,
  endpoint: { name: true, primary: true, humanInput: true } satisfies Record<
    keyof NonNullable<Matrix.MatrixRow["endpoint"]>,
    true
  >,
  column: {
    kind: true,
    id: true,
    group: true,
    target: true,
    capability: true,
    inTypedPlan: true,
    label: true,
    mode: true,
    tier: true,
    order: true,
    typedScope: true,
    doc: true,
  } satisfies Record<keyof Matrix.MatrixColumn, true>,
  cell: {
    row: true,
    column: true,
    state: true,
    display: true,
    mode: true,
    basis: true,
    sources: true,
    via: true,
    scope: true,
    codes: true,
    uncertain: true,
    origin: true,
  } satisfies Record<keyof Matrix.MatrixCell, true>,
  source: {
    role: true,
    elementId: true,
    qname: true,
    file: true,
    line: true,
    column: true,
  } satisfies Record<keyof Matrix.MatrixSourceRef, true>,
  diagnostic: {
    code: true,
    severity: true,
    context: true,
    recovery: true,
  } satisfies Record<keyof Matrix.MatrixDiagnostic, true>,
  delegation: {
    id: true,
    revision: true,
    issuerSystem: true,
    targetSystem: true,
    active: true,
    reason: true,
  } satisfies Record<keyof Matrix.MatrixDelegationStatus, true>,
  summary: {
    byState: true,
    uncertain: true,
    hostRule: true,
    byRow: true,
    coordinates: true,
  } satisfies Record<keyof Matrix.AuthorityMatrix["summary"], true>,
  states: {
    allowed: true,
    "propose-only": true,
    denied: true,
    inherited: true,
    delegated: true,
  } satisfies Record<Matrix.MatrixCellState, true>,
  coordinates: { checked: true, mismatches: true } satisfies Record<
    keyof Matrix.AuthorityMatrix["summary"]["coordinates"],
    true
  >,
  grant: { file: true, qualifiedRoots: true } satisfies Record<
    keyof BoardGrant,
    true
  >,
  uncertain: { code: true, reason: true } satisfies Record<
    keyof NonNullable<Matrix.MatrixCell["uncertain"]>,
    true
  >,
};
const viaKeys = {
  "own-declaration": { kind: true },
  "unit-configuration": { kind: true, attribute: true },
  exposure: { kind: true, accessName: true, accessId: true },
  delegation: {
    kind: true,
    record: true,
    revision: true,
    issuerSystem: true,
    chainDigest: true,
    chain: true,
  },
  "root-grant": { kind: true, grant: true, mandate: true },
  "host-rule": { kind: true, rule: true, enforcedAt: true },
} satisfies {
  [Kind in Matrix.MatrixVia["kind"]]: Record<
    keyof Extract<Matrix.MatrixVia, { kind: Kind }>,
    true
  >;
};

/** Closed transport records are checked at runtime, including nested variants.
 * Explicitly open maps (scope, diagnostic context and row limits) stay open. */
export function assertClosedAuthorityMatrix(
  matrix: Matrix.AuthorityMatrix,
): void {
  const keys = (value: object, allowed: object, path: string) => {
    assert.deepEqual(
      Object.keys(value).filter((key) => !Object.hasOwn(allowed, key)),
      [],
      `undeclared matrix field at ${path}`,
    );
    assert.equal(
      Object.values(value).includes(undefined),
      false,
      `undefined transport field at ${path}`,
    );
  };
  keys(matrix, closedKeys.matrix, "matrix");
  assert.deepEqual(
    Object.keys(matrix).sort(),
    Object.keys(closedKeys.matrix).sort(),
  );
  // Enforcement points are symbolic anchors; a source path with a line number
  // goes stale as soon as the file moves, so no production output carries one.
  assert.equal(
    JSON.stringify(matrix).includes(".ts:"),
    false,
    "matrix output cites a source file and line",
  );
  keys(matrix.model, closedKeys.model, "model");
  matrix.model.units.forEach((unit) =>
    keys(unit, closedKeys.unit, "model.units")
  );
  matrix.groups.forEach((group) => keys(group, closedKeys.group, "groups"));
  for (const row of matrix.rows) {
    keys(row, closedKeys.row, "rows");
    if (row.element) keys(row.element, closedKeys.source, "rows.element");
    if (row.endpoint) keys(row.endpoint, closedKeys.endpoint, "rows.endpoint");
  }
  for (const column of matrix.columns) {
    keys(column, closedKeys.column, "columns");
    if (column.target) {
      keys(
        column.target,
        column.kind === "behavior"
          ? { kind: true, ref: true, unit: true }
          : { kind: true, ref: true },
        "columns.target",
      );
    }
  }
  for (const cell of matrix.cells) {
    keys(cell, closedKeys.cell, "cells");
    cell.sources.forEach((source) =>
      keys(source, closedKeys.source, "cells.sources")
    );
    if (cell.uncertain) {
      keys(cell.uncertain, closedKeys.uncertain, "cells.uncertain");
    }
    if (cell.scope?.grants) {
      cell.scope.grants.forEach((grant) =>
        keys(grant, closedKeys.grant, "cells.scope.grants")
      );
    }
    if (cell.via) {
      keys(cell.via, viaKeys[cell.via.kind], "cells.via");
      if (cell.via.kind === "delegation") {
        cell.via.chain.forEach((link) =>
          keys(
            link,
            { kind: true, id: true, revision: true, system: true },
            "cells.via.chain",
          )
        );
      }
    }
  }
  matrix.delegations.forEach((delegation) =>
    keys(delegation, closedKeys.delegation, "delegations")
  );
  matrix.diagnostics.forEach((diagnostic) => {
    keys(diagnostic, closedKeys.diagnostic, "diagnostics");
    assert.deepEqual(
      Object.keys(diagnostic).sort(),
      Object.keys(closedKeys.diagnostic).sort(),
    );
    assert.ok(
      diagnostic.recovery.length > 0,
      "each diagnostic carries recovery guidance",
    );
  });
  keys(matrix.summary, closedKeys.summary, "summary");
  keys(matrix.summary.byState, closedKeys.states, "summary.byState");
  Object.values(matrix.summary.byRow).forEach((states) =>
    keys(states, closedKeys.states, "summary.byRow")
  );
  keys(
    matrix.summary.coordinates,
    closedKeys.coordinates,
    "summary.coordinates",
  );
}

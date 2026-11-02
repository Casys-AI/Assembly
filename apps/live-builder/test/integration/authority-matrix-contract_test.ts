import assert from "node:assert/strict";
import {
  isMatrixCellCode,
  parseMatrixColumnId,
} from "../../src/domain/governance/records/authority-matrix.ts";
import {
  fixtureCellCodes,
  fixtureColumnIds,
} from "../support/authority-matrix-fixtures.ts";

import {
  checkAuthorityMatrixCoordinates,
  projectAuthorityMatrix,
} from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts";
import { prepareMatrixArtifact } from "../support/authority-matrix-artifact-fixtures.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { assertClosedAuthorityMatrix } from "../support/assert-closed-authority-matrix.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test("matrix contract covers every hard-coded UI id and qualifier", async () => {
  const template = await Deno.readTextFile(
    new URL("../../prototypes/model-views/template.html", import.meta.url),
  );
  const literals = [...template.matchAll(/"([^"\n]+)"/g)].map((match) =>
    match[1]
  );
  const ids = [
    ...new Set(
      literals.filter((text) =>
        /^(?:tool\.|network\.|model\.|candidate\.|mandate\.|operator\.)/.test(
          text,
        )
      ),
    ),
  ];
  assert.ok(
    ids.includes("tool.invoke") && ids.includes("candidate.admit") &&
      ids.includes("model.edit"),
  );
  for (const id of ids) {
    assert.equal(parseMatrixColumnId(id).id, id);
    assert.ok(
      fixtureColumnIds.some((known) => known === id),
      `Add ${id} to the typed inventory`,
    );
  }
  // Qualifier objects/sets use both bare property names and quoted literals.
  const rules = template.slice(
    template.indexOf("const UNUSABLE ="),
    template.indexOf("const LABEL ="),
  );
  const codes = new Set(
    [...rules.matchAll(/\b[A-Z][A-Z_]+\b/g)].map((match) => match[0]),
  );
  for (const name of ["UNUSABLE", "HARD", "OWNER_ONLY", "BY_HUMAN"]) {
    codes.delete(name);
  }
  for (const match of template.matchAll(/\.includes\("([A-Z][A-Z_]+)"\)/g)) {
    codes.add(match[1]);
  }
  assert.ok(
    codes.has("RIGHT_WITHOUT_OBJECT") && codes.has("HOST_RESERVED") &&
      codes.has("ADMISSION_BY_BUILDER"),
  );
  for (const code of codes) {
    assert.ok(isMatrixCellCode(code), code);
    assert.ok(
      fixtureCellCodes.some((known) => known === code),
      `Add ${code} to the typed inventory`,
    );
  }
  // The UI builds these prefixes dynamically; exercise each represented family.
  for (const prefix of ["inbox@", "context-", "memory-", "skill-"]) {
    assert.ok(
      fixtureColumnIds.some((id) => id.startsWith(`behavior:${prefix}`)),
    );
  }
});

Deno.test("typed inventory stays exhaustive against both prototype matrix snapshots", async () => {
  for (const name of ["demo-ase", "commercial-watch"]) {
    const data = JSON.parse(
      await Deno.readTextFile(
        new URL(
          `../../prototypes/model-views/data/data-${name}.json`,
          import.meta.url,
        ),
      ),
    );
    assert.equal(data.matrix.model.authoritySchema, "legacy-v1");
    for (const column of data.matrix.columns) {
      assert.equal(parseMatrixColumnId(column.id).id, column.id);
      assert.ok(fixtureColumnIds.some((id) => id === column.id), column.id);
    }
    for (const cell of data.matrix.cells) {
      parseMatrixColumnId(cell.column);
      for (const code of cell.codes) {
        assert.ok(isMatrixCellCode(code), code);
        assert.ok(fixtureCellCodes.some((known) => known === code), code);
      }
    }
  }
});

Deno.test("rapatriated B0 snapshots retain an exhaustive typed column and qualifier inventory", async () => {
  for (
    const name of [
      "initial",
      "demo-ase",
      "commercial-watch",
      "fixture-delegation",
      "fixture-reviewer-policies",
    ]
  ) {
    const matrix = JSON.parse(
      await Deno.readTextFile(
        new URL(
          `../fixtures/authority-matrix/matrix-${name}.json`,
          import.meta.url,
        ),
      ),
    );
    for (const column of matrix.columns) {
      assert.equal(parseMatrixColumnId(column.id).id, column.id);
    }
    for (const cell of matrix.cells) {
      parseMatrixColumnId(cell.column);
      for (const code of cell.codes) {
        assert.ok(isMatrixCellCode(code), `${name}: ${code}`);
      }
    }
  }
});

Deno.test({
  name:
    "compiled artifact matrix output has exactly the closed B4 transport keys",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const prepared = await prepareMatrixArtifact("initial", {
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      projectId: "git:33333333-3333-4333-8333-333333333333",
      version: parseModelRevisionId(`commit:${"a".repeat(40)}`),
    });
    const matrix = await projectAuthorityMatrix({
      name: "initial",
      revision: prepared.revision,
      units: prepared.units,
    });
    assertClosedAuthorityMatrix(matrix);
  },
});

Deno.test("artifact coordinate verification detects corrupt metadata and references with UTF8 byte columns", () => {
  const element = {
    "@id": "sample",
    "@type": "PartUsage",
    qualifiedName: "Sample::sample",
    "sysx:sourceDocument": "sample.sysml",
    "sysx:sourceLine": 1,
    "sysx:sourceColumn": 8,
    "sysx:sourceEndLine": 1,
    "sysx:sourceEndColumn": 20,
    "sysx:sourceText": "part sample;",
  };
  const revision = {
    elements: [element],
    sources: { "sample.sysml": "/*é*/ part sample;\n" },
  };
  const ref = {
    role: "holder" as const,
    elementId: "sample",
    qname: "Sample::sample",
    file: "sample.sysml",
    line: 1,
    column: 8,
  };
  assert.deepEqual(checkAuthorityMatrixCoordinates(revision, [ref]), {
    checked: 1,
    mismatches: [],
  });
  for (
    const corrupt of [{ file: "other.sysml" }, { line: 2 }, { column: 7 }, {
      qname: "Sample::other",
    }, { elementId: "missing" }]
  ) {
    assert.equal(
      checkAuthorityMatrixCoordinates(revision, [{ ...ref, ...corrupt }])
        .mismatches.length,
      1,
      JSON.stringify(corrupt),
    );
  }
  for (
    const corrupt of [{ "sysx:sourceText": "part other;" }, {
      "sysx:sourceEndColumn": 200,
    }, { "sysx:sourceColumn": 4 }]
  ) {
    assert.equal(
      checkAuthorityMatrixCoordinates({
        ...revision,
        elements: [{ ...element, ...corrupt }],
      }, [ref]).mismatches.length,
      1,
      JSON.stringify(corrupt),
    );
  }
  const implicit = {
    "@id": "implicit",
    "@type": "PartUsage",
    qualifiedName: "Sample::sample::implicit",
    owner: { "@id": "sample" },
  };
  assert.deepEqual(
    checkAuthorityMatrixCoordinates({
      ...revision,
      elements: [element, implicit],
    }, [{ ...ref, elementId: "implicit", qname: implicit.qualifiedName }]),
    { checked: 0, mismatches: [] },
    "inherited owner coordinates are validated without pretending to be an independent location",
  );
});

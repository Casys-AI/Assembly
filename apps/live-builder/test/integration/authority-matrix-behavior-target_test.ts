import assert from "node:assert/strict";
import { projectAuthorityMatrix } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { assertClosedAuthorityMatrix } from "../support/assert-closed-authority-matrix.ts";
import {
  type MatrixCorrectionArtifact,
  writeMatrixCorrectionArtifact,
} from "../support/authority-matrix-correction-probe.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test({
  name:
    "enabled and disabled exposures to a non-entry action yield diagnostics without losing Rights",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-matrix-unsupported-",
    });
    try {
      const artifact = `${directory}/artifact.json`;
      await writeMatrixCorrectionArtifact("unsupported-targets", artifact, {
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        projectId: "git:11111111-1111-4111-8111-111111111111",
        version: parseModelRevisionId(`commit:${"e".repeat(40)}`),
      });
      const fixture: MatrixCorrectionArtifact = JSON.parse(
        await Deno.readTextFile(artifact),
      );
      const accessIds = new Map(
        fixture.revision.elements.flatMap((element) =>
          element.qualifiedName ===
              "AssemblyLiveBuilder::liveBuilder::unsupportedEnabled" ||
            element.qualifiedName ===
              "AssemblyLiveBuilder::liveBuilder::unsupportedDisabled"
            ? [[String(element.qualifiedName), String(element["@id"])] as const]
            : []
        ),
      );
      assert.equal(
        accessIds.size,
        2,
        "both actual BehaviorAccess declarations were compiled",
      );
      const behaviors = fixture.units.flatMap(({ model }) =>
        model.behaviors ?? []
      );
      assert.ok(
        behaviors.some((behavior) =>
          behavior.id ===
            accessIds.get(
              "AssemblyLiveBuilder::liveBuilder::unsupportedEnabled",
            )
        ),
        "the compiler admits the enabled non-entry exposure",
      );
      assert.equal(
        behaviors.some((behavior) =>
          behavior.id ===
            accessIds.get(
              "AssemblyLiveBuilder::liveBuilder::unsupportedDisabled",
            )
        ),
        false,
        "the compiler drops the disabled exposure",
      );
      const matrix = await projectAuthorityMatrix({
        ...fixture,
        name: "unsupported-targets",
      });
      assertClosedAuthorityMatrix(matrix);
      assert.equal(matrix.rows.length, 2);
      assert.equal(matrix.columns.length, 28);
      assert.equal(matrix.cells.length, 38);
      assert.deepEqual(matrix.summary.coordinates, {
        checked: 78,
        mismatches: 0,
      });
      const diagnostics = matrix.diagnostics.filter((diagnostic) =>
        diagnostic.code === "UNSUPPORTED_BEHAVIOR_TARGET"
      );
      assert.equal(
        diagnostics.length,
        2,
        "one diagnostic per enabled/disabled exposure",
      );
      for (const access of ["unsupportedEnabled", "unsupportedDisabled"]) {
        const diagnostic = diagnostics.find((candidate) =>
          candidate.context.access ===
            `AssemblyLiveBuilder::liveBuilder::${access}`
        );
        assert.ok(diagnostic, access);
        assert.equal(diagnostic.severity, "info");
        assert.deepEqual(diagnostic.context, {
          access: `AssemblyLiveBuilder::liveBuilder::${access}`,
          target: "AssemblyLiveBuilder::liveBuilder::reply",
        });
        assert.ok(diagnostic.recovery.length > 0);
      }
      assert.equal(
        matrix.columns.some((column) => column.id.includes("native-action")),
        false,
      );
      assert.equal(
        matrix.cells.some((cell) =>
          cell.via?.kind === "exposure" &&
          [...accessIds.values()].includes(cell.via.accessId)
        ),
        false,
      );
      assert.ok(
        matrix.cells.some((cell) =>
          cell.column ===
            "behavior:memory-review@AssemblyLiveBuilder::liveBuilder" &&
          cell.state === "allowed"
        ),
        "supported behavior authority is still projected",
      );
      assert.deepEqual(
        await projectAuthorityMatrix({
          ...fixture,
          name: "unsupported-targets",
        }),
        matrix,
        "skipped exposure diagnostics and digest are deterministic",
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

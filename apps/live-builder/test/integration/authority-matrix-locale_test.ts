import assert from "node:assert/strict";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { compareCodeUnits } from "../../src/domain/primitives/canonical-json.ts";
import {
  observeMatrixLocale,
  writeMatrixCorrectionArtifact,
} from "../support/authority-matrix-correction-probe.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test({
  name:
    "production artifact matrix and digest survive English, Danish and Czech caller locales",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-matrix-locale-" });
    try {
      const artifact = `${directory}/artifact.json`;
      await writeMatrixCorrectionArtifact("locale", artifact, {
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        projectId: "git:11111111-1111-4111-8111-111111111111",
        version: parseModelRevisionId(`commit:${"d".repeat(40)}`),
      });
      const reference = await observeMatrixLocale(artifact, "en_US.UTF-8");
      // The projector alone, sorted under each caller locale with the same
      // prepared units: nothing in its ordering may follow the locale.
      const direct = await observeMatrixLocale(
        artifact,
        "en_US.UTF-8",
        "direct",
      );
      assert.match(reference.locale, /^en/u);
      const units = [...new Set(reference.matrix.rows.map((row) => row.unit))];
      assert.ok(units.some((unit) => unit.startsWith("ASEChannel::")));
      assert.ok(units.some((unit) => unit.startsWith("aseHub::")));
      assert.ok(units.some((unit) => unit.startsWith("ASELiveBuilder::")));
      assert.deepEqual(units, units.toSorted(compareCodeUnits));
      assert.equal(reference.matrix.summary.coordinates.mismatches, 0);
      for (
        const [locale, prefix] of [["da_DK.UTF-8", "da"], ["cs_CZ.UTF-8", "cs"]]
      ) {
        const observed = await observeMatrixLocale(artifact, locale!);
        assert.ok(observed.locale.startsWith(prefix!), locale);
        assert.notDeepEqual(
          observed.canary,
          reference.canary,
          `collation changed under ${locale}`,
        );
        assert.deepEqual(
          observed.matrix,
          reference.matrix,
          `full matrix under ${locale}`,
        );
        assert.equal(
          observed.matrix.digest,
          reference.matrix.digest,
          `digest under ${locale}`,
        );
        const projected = await observeMatrixLocale(
          artifact,
          locale!,
          "direct",
        );
        assert.ok(projected.locale.startsWith(prefix!), locale);
        assert.deepEqual(
          projected.matrix,
          direct.matrix,
          `projector matrix under ${locale}`,
        );
        assert.equal(projected.matrix.digest, direct.matrix.digest, locale);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

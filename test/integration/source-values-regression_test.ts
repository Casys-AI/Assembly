/** Frozen source, literal and executable compatibility of the models/ bootstrap.
 * Representation hashes use corrected Toolkit 0.10.10+ase.2 / normalizer 2:
 * commit 6eb9a9c corrected conditional endpoints and else markers after the
 * previous representation goldens were recorded. Both source variants retain
 * their source, provenance, literal and executable digests across that change.
 * JSON.stringify deliberately preserves array order and every literal field.
 */
import assert from "node:assert/strict";
import { sha256 } from "../../src/domain/model/value-objects/artifact.ts";
import { sourceLiterals } from "../../src/domain/model/projections/source-facts.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

// The initial model without the four B11 operator attributes. The delegation's
// OperatorAuthorityPolicy definition moved five of them, not the executable.
// Artifact/semantic hashes below reflect the corrected current recipe, not a
// rebuild of a persisted historical artifact under a different recipe.
const LEGACY_DIGESTS = {
  sourceDigest:
    "e69a0fdecd0d3b280b91e5f375ef57dd5e1d7e2c1d35600a30a5fe9ea3229b91",
  semanticDigest:
    "53fbfd70a7dd8428eada6e08ef63265b3ff0cfd044fd1e43172fd4446c90f66a",
  provenanceDigest:
    "27ba11946d07edaca2560ddd47e823ee2c2cd81c5faada992917e61cf9c3698b",
  providerArtifactDigest:
    "69ffe69040a5e00d5880b39434c35683e33cd22e3d9394d0c686e0c88d314667",
  documentsDigest:
    "3818170f566ceb901dae1ac1f11d5ecf8c5bdb492197a7bec212c24796627d48",
  executableDigest:
    "db06c334dabda770d219d4f16689376c1fff3f5eda8bb5d7dd1c107bf4edf627",
  literalsDigest:
    "53f0016b2cfb035d0dd478460c88460381b8ffc4565c45706457cc764f8587f9",
};

/** The original seven-hash qualification predates the inert ToolAdmissionPolicy
 * definition added in 2021826. Preserve that exact input, rather than updating
 * historical hashes whenever the maintained bootstrap gains declarations. */
async function legacyGoldenSources() {
  const sources = await loadInitialSources(
    new URL("../fixtures/legacy-ase-model/", import.meta.url),
  );
  sources["authority.sysml"] = await Deno.readTextFile(
    new URL(
      "../fixtures/legacy-ase-authority-before-tool-admission.sysml",
      import.meta.url,
    ),
  );
  return sources;
}

async function measure(sources: Record<string, string>) {
  const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
    .compile(sources);
  const model = await validateSourceExecutable(
    { ...compiled, version: "typed-value-legacy-regression" },
    "git:dd0917bd-0df7-5120-8b98-76c2cf832a04",
  );
  const literals = sourceLiterals(compiled.elements);
  return {
    literals,
    digests: {
      sourceDigest: compiled.sourceDigest,
      semanticDigest: compiled.semanticDigest,
      provenanceDigest: compiled.provenanceDigest,
      providerArtifactDigest:
        compiled.documents.find((document) =>
          document["@type"] === "ProviderArtifactV0"
        )!.sha256,
      documentsDigest: await sha256(JSON.stringify(compiled.documents)),
      executableDigest: model.version.digest,
      literalsDigest: await sha256(JSON.stringify(literals)),
    },
  };
}

Deno.test({
  name:
    "typed-value reader preserves exact legacy literals, executable and artifact digests",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const { literals, digests } = await measure(
      await legacyGoldenSources(),
    );
    // The initial template gained the typed owner (authority lot 1) and the
    // typed Schedule (Jobs and Watches); stored systems keep their digests.
    // M1c1 reworded the catalog documentation only: the source, semantic and
    // artifact digests moved, the executable and literal digests did not.
    // B11 added the designer's four operator fields (operatorName,
    // operatorInstruction, primaryContact, humanInputEnabled) on liveBuilder:
    // all seven digests moved and four literals were added. Renaming the
    // operator from Designer to Main Operator moved all seven again. The
    // delegation added the OperatorAuthorityPolicy definition, with no
    // instance: five digests moved, the executable and literal ones did not.
    assert.equal(literals.length, 99);
    assert.deepEqual(digests, {
      sourceDigest:
        "4acccc4dc6aa7bfdeec8503fefb067164b888b419829ff190b57db5639b58f0d",
      semanticDigest:
        "60001055d8b1fa9999e86f5db53ca9c9cc6808974bb23633b552ef9419a23912",
      provenanceDigest:
        "7a670ee7ffcfc1f07eac23dfad20e0228125081abef484d02db1613601def8f9",
      providerArtifactDigest:
        "5370394c63fdbfaeddba9e793e0a36980a9788dac2110e0f76e1cc98bf4950e2",
      documentsDigest:
        "569b6196748da99595366646b92bbe78b87b4784b9c164c8559275573eabfac8",
      executableDigest:
        "105a68cdddb719ac6ad068a73e4b729f71cc1f2ae59087206900dfee893123b2",
      literalsDigest:
        "e5caefc09a652cf1f8710164baf8a29aab280e2d47c8d5efda0deedcedfd35cf",
    });
  },
});

Deno.test({
  name:
    "initial model without the B11 operator endpoint keeps the legacy digests",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await legacyGoldenSources();
    const operatorAttributes =
      /attribute (operatorName|operatorInstruction|primaryContact|humanInputEnabled) :/;
    let removed = 0;
    const stripped: Record<string, string> = {};
    for (const [name, content] of Object.entries(sources)) {
      const lines = content.split("\n");
      stripped[name] = lines.filter((line) => {
        if (operatorAttributes.test(line)) {
          removed++;
          return false;
        }
        return true;
      }).join("\n");
    }
    assert.equal(removed, 4, "the four B11 operator attributes are stripped");
    const { literals, digests } = await measure(stripped);
    assert.equal(literals.length, 95);
    assert.deepEqual(digests, LEGACY_DIGESTS);
  },
});

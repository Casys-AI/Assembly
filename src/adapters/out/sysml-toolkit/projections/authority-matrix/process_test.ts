import assert from "node:assert/strict";
import { MATRIX_MIN_ENGINE_VERSION, matrixProviderRefusal } from "./process.ts";
import { TOOLKIT_COMPILER_DESCRIPTOR } from "../../compilation/compiler.ts";

const provider = (version: string) => ({
  name: TOOLKIT_COMPILER_DESCRIPTOR.name,
  version,
  format: TOOLKIT_COMPILER_DESCRIPTOR.format,
});
const artifact = (engineVersion: string) => ({
  engineVersion,
  provider: provider(engineVersion),
});

Deno.test("the floor is not the running build, so a Toolkit bump keeps stored versions readable", () => {
  assert.equal(
    matrixProviderRefusal(artifact(MATRIX_MIN_ENGINE_VERSION)),
    undefined,
  );
  // Every engine at or above the floor is served; the artifact reports its own.
  for (
    const version of [
      "0.10.11",
      "0.11.0",
      "0.99.0",
      "1.0.0",
      "10.0.0",
      "0.10.10+ase.1",
      "0.11.0+build.2",
    ]
  ) {
    assert.equal(matrixProviderRefusal(artifact(version)), undefined, version);
  }
  // The running build is itself one of them, and may be newer than the floor.
  assert.equal(
    matrixProviderRefusal(artifact(TOOLKIT_COMPILER_DESCRIPTOR.version)),
    undefined,
  );
});

Deno.test("engines older than the floor, malformed versions and incoherent descriptors are refused", () => {
  for (
    const version of ["0.10.9", "0.9.99", "0.0.1", "0.10.0", "0.10.9+ase.1"]
  ) {
    assert.match(
      matrixProviderRefusal(artifact(version))!,
      /older than/,
      version,
    );
  }
  for (
    const version of [
      "",
      "latest",
      "0.10",
      "0.10.10.1",
      "0.10.x",
      "0.10.10-rc1",
      "0.10.10-rc1+ase.1",
      "0.10.10+",
      "0.10.10+ase..1",
      "0.10.10+ase+1",
      "-1.0.0",
    ]
  ) {
    assert.match(
      matrixProviderRefusal(artifact(version))!,
      /malformed/,
      version,
    );
  }
  assert.match(
    matrixProviderRefusal({
      engineVersion: "0.11.0",
      provider: provider("0.10.10"),
    })!,
    /disagree/,
  );
  assert.match(
    matrixProviderRefusal({
      engineVersion: "0.11.0",
      provider: { ...provider("0.11.0"), name: "other-engine" },
    })!,
    /is not sysml-toolkit/,
  );
  assert.match(
    matrixProviderRefusal({
      engineVersion: "0.11.0",
      provider: {
        ...provider("0.11.0"),
        format: "ase-toolkit-normalized-json-v2",
      },
    })!,
    /artifact format/,
  );
  assert.match(
    matrixProviderRefusal({
      engineVersion: "0.11.0",
      provider: { ...provider("0.11.0"), extra: true } as never,
    })!,
    /exactly/,
  );
  assert.match(
    matrixProviderRefusal({ engineVersion: "0.11.0", provider: undefined })!,
    /exactly/,
  );
});

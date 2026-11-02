import {
  prepareToolkitElements,
  TOOLKIT_COMPILER_DESCRIPTOR,
  ToolkitCompiler,
} from "./compiler.ts";
import { ARTIFACT_SCHEMA } from "../../../../domain/model/value-objects/build.ts";
import { IR_VERSION } from "../../../model/builds/materialization/artifact.ts";
import { NORMALIZER_VERSION } from "./normalizer.ts";
import {
  SYSML_TOOLKIT_VERSION,
  type ToolkitRuntime,
  type ToolkitSession,
} from "../runtime/loader.ts";
function runtime(overrides: Partial<ToolkitSession> = {}) {
  let freed = false;
  const session = {
    check: () => "[]",
    toFullJson: () =>
      JSON.stringify([{
        "@id": "p",
        "@type": "PartUsage",
        isReference: true,
        type: [{ "@id": "lib" }],
      }]),
    rows: (ids: string) =>
      JSON.stringify(
        JSON.parse(ids)[0] === "p" ? [{ memberExtent: null }] : [{
          name: "Thing",
          qualifiedName: "Library::Thing",
          metaclass: "PartDefinition",
          isLibraryElement: true,
          owner: null,
        }],
      ),
    units: () => "[]",
    free: () => {
      freed = true;
    },
    ...overrides,
  } as ToolkitSession;
  return {
    runtime: {
      version: SYSML_TOOLKIT_VERSION,
      checkSyntax: () => "[]",
      createSession: () => session,
    } as ToolkitRuntime,
    freed: () => freed,
  };
}
Deno.test("Toolkit compiler joins real referenced library identities and frees session", async () => {
  const mock = runtime();
  const elements = await prepareToolkitElements(
    { "x.sysml": "part p;" },
    mock.runtime,
  );
  if (
    elements.length !== 2 || elements[0].isReference !== true ||
    elements[1]["toolkit:catalogOnly"] !== true ||
    elements[1].qualifiedName !== "Library::Thing" || !mock.freed()
  ) throw new Error("Native catalog or lifecycle lost");
});
Deno.test("Toolkit compiler refuses missing native endpoints and frees failed session", async () => {
  const mock = runtime({
    rows: (ids) =>
      JSON.stringify(
        JSON.parse(ids)[0] === "p" ? [{ memberExtent: null }] : [null],
      ),
  });
  let failed = false;
  try {
    await prepareToolkitElements({ "x.sysml": "part p;" }, mock.runtime);
  } catch {
    failed = true;
  }
  if (!failed || !mock.freed()) {
    throw new Error("Unknown endpoint admitted or session leaked");
  }
});
Deno.test("Toolkit compiler rejects source referential diagnostics before export", async () => {
  const mock = runtime({
    check: () =>
      JSON.stringify([{
        severity: "warning",
        stage: "referential",
        unit: "x.sysml",
        message: "unknown X",
      }]),
  });
  let failed = false;
  try {
    await prepareToolkitElements({ "x.sysml": "part p;" }, mock.runtime);
  } catch {
    failed = true;
  }
  if (!failed || !mock.freed()) throw new Error("Broken source admitted");
});
Deno.test("Toolkit compiler recipe pins bundle bytes and versioned stages", async () => {
  const loadRuntime = () =>
    Promise.resolve({
      version: SYSML_TOOLKIT_VERSION,
      checkSyntax: () => "[]",
      createSession: () => {
        throw new Error("recipe must not compile");
      },
      provenance: () =>
        Promise.resolve({
          version: SYSML_TOOLKIT_VERSION,
          digest: "a".repeat(64),
        }),
    } as ToolkitRuntime);
  const compiler = new ToolkitCompiler({ packageDir: "/fixture", loadRuntime });
  const recipe = await compiler.recipe();
  if (
    recipe.toolkit.version !== SYSML_TOOLKIT_VERSION ||
    recipe.toolkit.bundleDigest !== "a".repeat(64) ||
    recipe.format !== TOOLKIT_COMPILER_DESCRIPTOR.format ||
    recipe.normalizerVersion !== NORMALIZER_VERSION ||
    recipe.irVersion !== IR_VERSION ||
    recipe.artifactSchema !== ARTIFACT_SCHEMA ||
    recipe.engineVersion !== SYSML_TOOLKIT_VERSION
  ) throw new Error("Compiler recipe lost its pinned identity");
  if (
    NORMALIZER_VERSION !== 2 || IR_VERSION !== "0.1" || ARTIFACT_SCHEMA !== 1
  ) {
    throw new Error("Recipe stage versions moved without a golden update");
  }
});
Deno.test("Toolkit compiler recipe refuses a runtime without provenance", async () => {
  const compiler = new ToolkitCompiler({
    packageDir: "/fixture",
    loadRuntime: () =>
      Promise.resolve({
        version: SYSML_TOOLKIT_VERSION,
        checkSyntax: () => "[]",
        createSession: () => {
          throw new Error("unreachable");
        },
      } as ToolkitRuntime),
  });
  let failed = false;
  try {
    await compiler.recipe();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Provenance-free recipe admitted");
});

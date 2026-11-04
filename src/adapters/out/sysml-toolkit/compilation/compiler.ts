import { isNativeToolkitPanic } from "../runtime/native-addon.ts";
/** Source-only compiler backed exclusively by the pinned local Toolkit native addon. */
import type {
  CompiledModel,
  JsonObject,
} from "../../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../../domain/model/value-objects/sources.ts";
import { ARTIFACT_SCHEMA } from "../../../../domain/model/value-objects/build.ts";
import type { ModelCompilerRecipe } from "../../../../application/model/builds/ports/out/model-compiler.port.ts";
import {
  IR_VERSION,
  materialize,
} from "../../../../domain/model/value-objects/artifact.ts";
import { validateModelSources as validateSources } from "../../../../domain/model/value-objects/sources.ts";
import {
  SYSML_TOOLKIT_VERSION,
  type ToolkitBundleProvenance,
  type ToolkitRuntime,
} from "../runtime/loader.ts";
import {
  NORMALIZER_VERSION,
  normalizeToolkit,
  type ToolkitRow,
  type ToolkitUnit,
} from "./normalizer.ts";
import {
  runSysmlToolkitWorker,
  validateToolkitTimeout,
} from "../worker-client.ts";

export const TOOLKIT_COMPILER_DESCRIPTOR = {
  name: "sysml-toolkit",
  version: SYSML_TOOLKIT_VERSION,
  format: "ase-toolkit-normalized-json-v1",
} as const;
export interface ToolkitCompilerOptions {
  packageDir: string;
  timeoutMs?: number;
  /** Test seam. Production uses a bounded worker with a fresh session per call. */
  loadRuntime?: () => Promise<ToolkitRuntime>;
}
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function clean(input: string, sources: Sources): void {
  const diagnostics: unknown = JSON.parse(input);
  if (
    !Array.isArray(diagnostics) ||
    diagnostics.some((d) =>
      !object(d) || typeof d.severity !== "string" ||
      typeof d.message !== "string"
    )
  ) throw new Error("Malformed Toolkit diagnostics");
  const errors = diagnostics.filter((d) =>
    d.severity.toLowerCase() === "error" ||
    d.stage === "referential" &&
      (d.unit === undefined || Object.hasOwn(sources, String(d.unit)))
  );
  if (errors.length) {
    throw new Error(
      `Toolkit validation refused: ${errors.map((d) => d.message).join("; ")}`,
    );
  }
}
/** Extract actual native rows, including referenced library type identities. */
export function prepareToolkitElements(
  sources: Sources,
  runtime: ToolkitRuntime,
): JsonObject[] {
  if (runtime.version !== SYSML_TOOLKIT_VERSION) {
    throw new Error("Unsupported Toolkit compiler version");
  }
  const encoded = JSON.stringify(
    Object.entries(sources).map(([name, text]) => ({ name, text })),
  );
  clean(runtime.checkSyntax(encoded), sources);
  const session = runtime.createSession(encoded);
  try {
    clean(session.check(), sources);
    if (!session.toFullJson) {
      throw new Error("Toolkit native full interchange API unavailable");
    }
    const raw: unknown = JSON.parse(session.toFullJson(false));
    if (
      !Array.isArray(raw) ||
      raw.some((e) =>
        !object(e) || typeof e["@id"] !== "string" ||
        typeof e["@type"] !== "string"
      )
    ) throw new Error("Malformed Toolkit full interchange");
    const elements = raw as JsonObject[];
    const ids = elements.map((e) => String(e["@id"]));
    const rows: unknown = JSON.parse(
      session.rows(
        JSON.stringify(ids),
        JSON.stringify(["memberExtent"]),
      ),
    );
    if (
      !Array.isArray(rows) || rows.length !== ids.length ||
      rows.some((r) => r !== null && (!object(r) || r.errors))
    ) throw new Error("Toolkit source rows unavailable");
    const nativeRows = new Map(
      ids.map((id, index) => [id, (rows[index] ?? {}) as ToolkitRow]),
    );
    const known = new Set(ids), missing = new Set<string>();
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (object(v)) {
        if (typeof v["@id"] === "string" && !known.has(v["@id"])) {
          missing.add(v["@id"]);
        }
        Object.values(v).forEach(visit);
      }
    };
    elements.forEach(visit);
    const externalIds = [...missing];
    if (externalIds.length) {
      const catalog: unknown = JSON.parse(
        session.rows(
          JSON.stringify(externalIds),
          JSON.stringify([
            "name",
            "qualifiedName",
            "metaclass",
            "isLibraryElement",
            "owner",
          ]),
        ),
      );
      if (!Array.isArray(catalog) || catalog.length !== externalIds.length) {
        throw new Error("Malformed Toolkit catalog rows");
      }
      catalog.forEach((row, index) => {
        if (
          !object(row) || row.errors || row.isLibraryElement !== true ||
          typeof row.metaclass !== "string"
        ) throw new Error(`Unresolved Toolkit endpoint: ${externalIds[index]}`);
        elements.push({
          "@id": externalIds[index],
          "@type": row.metaclass,
          declaredName: row.name,
          qualifiedName: row.qualifiedName,
          isLibraryElement: true,
          "toolkit:catalogOnly": true,
          ...(typeof row.owner === "string"
            ? { owner: { "@id": row.owner } }
            : {}),
        });
      });
    }
    const units: unknown = JSON.parse(session.units());
    if (
      !Array.isArray(units) ||
      units.some((u) =>
        !object(u) || !Number.isSafeInteger(u.unit) ||
        typeof u.name !== "string" || typeof u.text !== "string"
      )
    ) throw new Error("Malformed Toolkit source units");
    return normalizeToolkit(elements, nativeRows, units as ToolkitUnit[]);
  } catch (error) {
    if (isNativeToolkitPanic(error)) runtime.invalidate?.(error);
    throw error;
  } finally {
    session.free();
  }
}
async function runtimeBundleProvenance(
  runtime: ToolkitRuntime,
): Promise<ToolkitBundleProvenance> {
  const provenance = await runtime.provenance?.();
  if (!provenance) {
    throw new Error("Toolkit bundle provenance unavailable");
  }
  return provenance;
}
export class ToolkitCompiler {
  constructor(readonly options: ToolkitCompilerOptions) {
    if (!options.packageDir) {
      throw new Error("A local Toolkit package directory is required");
    }
    validateToolkitTimeout(options.timeoutMs ?? 60_000);
  }
  version(): Promise<string> {
    return Promise.resolve(SYSML_TOOLKIT_VERSION);
  }
  /** The exact pipeline identity stamped by compile(); bundle bytes included. */
  async recipe(): Promise<ModelCompilerRecipe> {
    const bundle: ToolkitBundleProvenance = this.options.loadRuntime
      ? await runtimeBundleProvenance(await this.options.loadRuntime())
      : await runSysmlToolkitWorker<ToolkitBundleProvenance>(
        this.options.packageDir,
        { operation: "provenance" },
        this.options.timeoutMs ?? 60_000,
      );
    if (bundle.version !== SYSML_TOOLKIT_VERSION) {
      throw new Error("Unsupported Toolkit compiler version");
    }
    return {
      toolkit: {
        version: SYSML_TOOLKIT_VERSION,
        bundleDigest: bundle.digest,
      },
      format: TOOLKIT_COMPILER_DESCRIPTOR.format,
      normalizerVersion: NORMALIZER_VERSION,
      irVersion: IR_VERSION,
      artifactSchema: ARTIFACT_SCHEMA,
      engineVersion: SYSML_TOOLKIT_VERSION,
    };
  }
  async compile(input: Sources): Promise<CompiledModel> {
    const sources = validateSources(input);
    const elements = this.options.loadRuntime
      ? await prepareToolkitElements(sources, await this.options.loadRuntime())
      : await runSysmlToolkitWorker<JsonObject[]>(this.options.packageDir, {
        operation: "compile",
        sources,
      }, this.options.timeoutMs ?? 60_000);
    return await materialize(
      elements,
      sources,
      SYSML_TOOLKIT_VERSION,
      TOOLKIT_COMPILER_DESCRIPTOR,
    );
  }
}

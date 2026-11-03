import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
/** SHACL model diagnostics (W6): versioned shapes over projected facts,
 * pure-JS RDFJS engine, no WASM.
 *
 * Facts are the `ModelDiagnosticFacts` already computed by
 * `model-diagnostics-source` — this adapter projects them to RDF and
 * never reinterprets rights (the host set difference and effect exposure
 * stay computed by the facts projector; SHACL Core verifies the
 * constats). Composition raccord for the coordinator: feed
 * `SourceModelDiagnosticsReader.read()` facts plus the resolved
 * `BuildRef` into `validateBuild`, keep user masks in the existing
 * diagnostics service, and store reports in the W2 projection cache.
 * Two shapes are qualified — this is not "SHACL complete".
 */
import { Readable } from "node:stream";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import type {
  ModelDiagnostic,
  ModelDiagnosticFacts,
} from "../../../domain/model/policies/diagnostics.ts";
import {
  type BuildRef,
  parseBuildRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  createShaclReportIdentity,
  ModelShapesError,
  SHACL_REPORT_KIND,
  shaclReportStoreVersion,
  type ShaclValidationReport,
} from "../../../application/model/diagnostics/shapes.ts";
import type { ModelShapesDiagnostics } from "../../../application/model/diagnostics/ports/out/shapes-diagnostics.port.ts";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import type { SemanticProjectionCache } from "../../../application/model/semantic/ports/out/semantic-projection-cache.port.ts";
import { escapeNQuadsLiteral, XSD } from "../oxigraph/rdf.ts";

export const FACTS_PROJECTOR_VERSION = "ase-diagnostic-facts-v2";
export const FACTS_VOCAB = "urn:ase:facts:";
export const SHAPES_FILE = "ase-diagnostics-shapes.ttl";

/** Pins installed in deno.json (single import sites). */
export const SHACL_ENGINE_SPECIFIER = "npm:rdf-validate-shacl@0.6.0";
export const SHACL_ENGINE_VERSION = "0.6.0";
export const RDF_PARSER_SPECIFIER = "npm:@rdfjs/parser-n3@2.1.0";
export const RDF_DATASET_SPECIFIER = "npm:@rdfjs/dataset@2.0.1";

const fact = (name: string): string => `${FACTS_VOCAB}${name}`;

// --- Facts projection (the exposure/set-difference owner) ---

export interface ProjectedDiagnosticFacts {
  readonly ntriples: string;
  readonly tripleCount: number;
  readonly units: readonly {
    readonly node: string;
    readonly unit: ModelDiagnosticFacts["units"][number];
  }[];
  readonly capabilities: readonly {
    readonly node: string;
    readonly capability: ModelDiagnosticFacts["networkCapabilities"][number];
    readonly outsideHosts: readonly string[];
  }[];
}

/** Each fact occurrence has its own node, independent of its optional
 * source element identity. Stable IRIs survive parser blank-node relabeling. */
function subjectFor(build: BuildRef, kind: string, index: number): string {
  return `<urn:ase:facts:occurrence:${
    encodeURIComponent(build.repositoryId)
  }:${build.artifactDigest}:${kind}:${index}>`;
}
function nodeKey(subject: string): string {
  return subject.slice(1, -1);
}
const lit = (value: string): string => `"${escapeNQuadsLiteral(value)}"`;
const bool = (value: boolean): string => `"${value}"^^<${XSD.boolean}>`;

/** Deterministic N-Triples for the facts the shapes check. */
export function projectDiagnosticFacts(
  facts: ModelDiagnosticFacts,
  buildInput: BuildRef,
): ProjectedDiagnosticFacts {
  const build = parseBuildRef(buildInput);
  const lines: string[] = [];
  const triple = (s: string, p: string, o: string) =>
    lines.push(`${s} <${p}> ${o} .`);
  const units = facts.units.map((unit, index) => {
    const subject = subjectFor(build, "unit", index);
    triple(
      subject,
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      `<${fact("DiagnosticUnit")}>`,
    );
    triple(subject, fact("unitKind"), lit(unit.kind));
    triple(
      subject,
      fact("hasInvocationBudget"),
      bool(unit.hasInvocationBudget),
    );
    return { node: nodeKey(subject), unit };
  });
  facts.effects.forEach((effect, index) => {
    const subject = subjectFor(
      build,
      "effect",
      index,
    );
    triple(
      subject,
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      `<${fact("EffectExposure")}>`,
    );
    triple(subject, fact("effectKind"), lit(effect.effect));
    triple(
      subject,
      fact("hasWorkResultContract"),
      bool(effect.hasWorkResultContract),
    );
  });
  const capabilities = facts.networkCapabilities.map((capability, index) => {
    const subject = subjectFor(
      build,
      "capability",
      index,
    );
    // Same set difference as the domain lint; SHACL Core checks the
    // resulting occurrences, it does not recompute the difference.
    const covered = new Set(capability.mandateHosts);
    const outsideHosts = [...new Set(capability.allowedHosts)]
      .filter((host) => !covered.has(host)).sort(compareCodeUnits);
    triple(
      subject,
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      `<${fact("NetworkCapability")}>`,
    );
    for (const host of [...new Set(capability.allowedHosts)]) {
      triple(subject, fact("allowedHost"), lit(host));
    }
    for (const host of [...new Set(capability.mandateHosts)]) {
      triple(subject, fact("mandateHost"), lit(host));
    }
    for (const host of outsideHosts) {
      triple(subject, fact("outsideHost"), lit(host));
    }
    return { node: nodeKey(subject), capability, outsideHosts };
  });
  const sorted = [...new Set(lines)].sort(compareCodeUnits);
  return Object.freeze({
    ntriples: sorted.length ? `${sorted.join("\n")}\n` : "",
    tripleCount: sorted.length,
    units: Object.freeze(units),
    capabilities: Object.freeze(capabilities),
  });
}

// --- Engine port (distinct from Oxigraph; versioned separately) ---

export interface ShaclEngineResult {
  readonly focusNode: string;
  readonly path?: string;
  readonly value?: string;
  readonly message?: string;
  readonly severity?: string;
  readonly sourceShape?: string;
  readonly component?: string;
}
export interface ShaclEngine {
  readonly engineId: string;
  readonly engineVersion: string;
  validate(input: {
    readonly shapesTurtle: string;
    readonly dataNTriples: string;
  }): Promise<{
    readonly conforms: boolean;
    readonly results: readonly ShaclEngineResult[];
  }>;
}

function engineUnavailable(reason: string): ModelShapesError {
  return new ModelShapesError(
    "SHACL_ENGINE_UNAVAILABLE",
    { reason },
    "SHACL engine is not available",
  );
}

// --- Real engine binding, qualified against the installed pins ---
//
// rdf-validate-shacl 0.6.0: default export is the validator class;
// `validate(dataset)` resolves a report whose `results` are objects
// with RDFJS term getters (`focusNode`, `path`, `value`, `severity`,
// `sourceShape`, `sourceConstraintComponent` are Term|null, `message`
// is Term[]). @rdfjs/dataset 2.0.1: the default export is a factory
// object with a `.dataset()` method — it is not callable itself.
// @rdfjs/parser-n3 2.1.0: the default export is a Sink class whose
// `.import()` requires a Node readable stream, not a Web stream.

interface RdfJsTermLike {
  readonly termType: string;
  readonly value: string;
}

interface ShaclResultLike {
  readonly focusNode: RdfJsTermLike | null;
  readonly path: RdfJsTermLike | null;
  readonly value: RdfJsTermLike | null;
  readonly severity: RdfJsTermLike | null;
  readonly sourceShape: RdfJsTermLike | null;
  readonly sourceConstraintComponent: RdfJsTermLike | null;
  readonly message: readonly RdfJsTermLike[];
}

interface ShaclReportLike {
  readonly conforms: boolean;
  readonly results: readonly ShaclResultLike[];
}

interface RdfDatasetLike {
  add(quad: unknown): void;
}

function termLike(value: unknown): RdfJsTermLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const term = value as { termType?: unknown; value?: unknown };
  if (typeof term.termType !== "string" || typeof term.value !== "string") {
    return undefined;
  }
  return { termType: term.termType, value: term.value };
}

function termText(term: RdfJsTermLike | null | undefined): string | undefined {
  if (!term) return undefined;
  return term.termType === "BlankNode" ? `_:${term.value}` : term.value;
}

function qualifyReport(value: unknown): ShaclReportLike {
  const report = value as Partial<ShaclReportLike> | null;
  if (
    !report || typeof report !== "object" ||
    typeof report.conforms !== "boolean" || !Array.isArray(report.results)
  ) {
    throw new ModelShapesError(
      "SHACL_VALIDATION_FAILED",
      { reason: "Engine returned a malformed validation report" },
      "SHACL validation failed",
    );
  }
  for (const result of report.results) {
    const candidate = result as Partial<ShaclResultLike> | null;
    if (
      !candidate || typeof candidate !== "object" ||
      !Array.isArray(candidate.message) ||
      !termLike(candidate.focusNode) ||
      candidate.message.some((term) => !termLike(term)) ||
      [
        candidate.path,
        candidate.value,
        candidate.severity,
        candidate.sourceShape,
        candidate.sourceConstraintComponent,
      ]
        .some((term) => term !== null && term !== undefined && !termLike(term))
    ) {
      throw new ModelShapesError(
        "SHACL_VALIDATION_FAILED",
        { reason: "Engine returned a malformed validation result" },
        "SHACL validation failed",
      );
    }
  }
  return report as ShaclReportLike;
}

/** Real engine binding: `rdf-validate-shacl` (pure JS, RDFJS, no WASM). */
export async function createRdfValidateShaclEngine(): Promise<ShaclEngine> {
  const load = async <T>(specifier: string): Promise<T> => {
    const name: string = specifier;
    try {
      return await import(name) as T;
    } catch (cause) {
      throw engineUnavailable(`Cannot load ${name}: ${String(cause)}`);
    }
  };
  const [validatorModule, parserModule, datasetModule] = await Promise.all([
    load<{ default?: unknown }>(SHACL_ENGINE_SPECIFIER),
    load<{ default?: unknown }>(RDF_PARSER_SPECIFIER),
    load<{ default?: unknown }>(RDF_DATASET_SPECIFIER),
  ]);
  const Validator = validatorModule.default as
    | (new (
      shapes: RdfDatasetLike,
      options: Record<string, never>,
    ) => { validate(data: RdfDatasetLike): Promise<unknown> })
    | undefined;
  const Parser = parserModule.default as
    | (new () => { import(stream: Readable): AsyncIterable<unknown> })
    | undefined;
  const datasetFactory = datasetModule.default as
    | { dataset(quads?: unknown[]): RdfDatasetLike }
    | undefined;
  if (
    typeof Validator !== "function" || typeof Parser !== "function" ||
    !datasetFactory || typeof datasetFactory.dataset !== "function"
  ) {
    throw engineUnavailable(
      "Pinned RDF packages do not expose the expected exports",
    );
  }
  const parseToDataset = async (text: string): Promise<RdfDatasetLike> => {
    const parser = new Parser();
    const dataset = datasetFactory.dataset();
    for await (const quad of parser.import(Readable.from([text]))) {
      dataset.add(quad);
    }
    return dataset;
  };
  const engine: ShaclEngine = {
    engineId: "rdf-validate-shacl",
    engineVersion: SHACL_ENGINE_VERSION,
    async validate(input) {
      let report: ShaclReportLike;
      try {
        const shapes = await parseToDataset(input.shapesTurtle);
        const data = await parseToDataset(input.dataNTriples);
        report = qualifyReport(await new Validator(shapes, {}).validate(data));
      } catch (error) {
        if (error instanceof ModelShapesError) throw error;
        throw new ModelShapesError(
          "SHACL_VALIDATION_FAILED",
          { reason: String(error) },
          "SHACL validation failed",
        );
      }
      const results = report.results.map((result) => {
        const focusNode = termText(result.focusNode);
        if (focusNode === undefined) {
          throw new ModelShapesError(
            "SHACL_VALIDATION_FAILED",
            { reason: "Validation result has no focus node" },
            "SHACL validation failed",
          );
        }
        return {
          focusNode,
          ...(termText(result.path)
            ? { path: termText(result.path) as string }
            : {}),
          ...(termText(result.value) !== undefined
            ? { value: termText(result.value) as string }
            : {}),
          ...(result.message[0]
            ? { message: termText(result.message[0]) ?? "" }
            : {}),
          ...(termText(result.severity)
            ? { severity: termText(result.severity) as string }
            : {}),
          ...(termText(result.sourceShape)
            ? { sourceShape: termText(result.sourceShape) as string }
            : {}),
          ...(termText(result.sourceConstraintComponent)
            ? {
              component: termText(
                result.sourceConstraintComponent,
              ) as string,
            }
            : {}),
        };
      });
      return { conforms: report.conforms, results };
    },
  };
  return Object.freeze(engine);
}

// --- Result mapping back to domain diagnostics ---

function locationOf(
  location: ModelDiagnostic["source"] extends never ? never
    : {
      elementId?: string;
      qualifiedName?: string;
      source?: { file: string; line: number; column: number };
    },
): Partial<ModelDiagnostic> {
  return {
    ...(location.elementId !== undefined
      ? { elementId: location.elementId }
      : {}),
    ...(location.qualifiedName !== undefined
      ? { qualifiedName: location.qualifiedName }
      : {}),
    ...(location.source !== undefined
      ? { source: { ...location.source } }
      : {}),
  };
}

const severityOrder = { error: 0, warning: 1, info: 2 } as const;
function sortDiagnostics(
  diagnostics: ModelDiagnostic[],
): ModelDiagnostic[] {
  return diagnostics.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.elementId ?? "", right.elementId ?? "") ||
    compareCodeUnits(left.qualifiedName ?? "", right.qualifiedName ?? "") ||
    compareCodeUnits(left.message, right.message)
  );
}

export function mapShaclResults(input: {
  readonly results: readonly ShaclEngineResult[];
  readonly projected: ProjectedDiagnosticFacts;
}): { diagnostics: ModelDiagnostic[]; unmappedResults: number } {
  const unitsByNode = new Map(
    input.projected.units.map((entry) => [entry.node, entry.unit]),
  );
  const capabilitiesByNode = new Map(
    input.projected.capabilities.map((entry) => [entry.node, entry]),
  );
  const diagnostics: ModelDiagnostic[] = [];
  const hostFindings = new Map<string, Set<string>>();
  let unmappedResults = 0;
  for (const result of input.results) {
    if (result.path === fact("hasInvocationBudget")) {
      const unit = unitsByNode.get(result.focusNode);
      if (!unit) {
        unmappedResults++;
        continue;
      }
      diagnostics.push({
        ...locationOf(unit.location),
        code: "LOOP_WITHOUT_BUDGET",
        severity: "warning",
        pattern: "3.6",
        finding: "absent",
        message: unit.kind === "conversation"
          ? "Conversation unit has no invocation budget policy."
          : "Executable plan has no invocation budget policy.",
        remedy: { kind: "revision-template", template: "work-budget" },
      });
      continue;
    }
    if (result.path === fact("outsideHost")) {
      if (!capabilitiesByNode.has(result.focusNode)) {
        unmappedResults++;
        continue;
      }
      const hosts = hostFindings.get(result.focusNode) ?? new Set<string>();
      if (result.value !== undefined) hosts.add(result.value);
      hostFindings.set(result.focusNode, hosts);
      continue;
    }
    unmappedResults++;
  }
  for (const [node, hosts] of hostFindings) {
    const entry = capabilitiesByNode.get(
      node,
    ) as ProjectedDiagnosticFacts["capabilities"][number];
    const outside = (hosts.size ? [...hosts] : [...entry.outsideHosts])
      .sort(compareCodeUnits);
    diagnostics.push({
      ...locationOf(entry.capability.location),
      code: "CAPABILITY_BEYOND_MANDATE",
      severity: "warning",
      pattern: "6.2",
      finding: "present",
      message: `SkillPolicy allows hosts outside the network mandate: ${
        outside.join(", ")
      }.`,
    });
  }
  return { diagnostics: sortDiagnostics(diagnostics), unmappedResults };
}

// --- Service: immutable reports keyed by build + shapes + engine ---

export type ShapesLoader = () => Promise<string>;

/** Default loader: the versioned shapes file in adapters/shacl. */
export const fileShapesLoader: ShapesLoader = () =>
  Deno.readTextFile(new URL(`./${SHAPES_FILE}`, import.meta.url));

export interface ShaclModelDiagnosticsOptions {
  readonly engine: ShaclEngine | (() => Promise<ShaclEngine>);
  readonly loadShapes?: ShapesLoader;
  /** W2 projection cache (`"shacl-report"`, store version, A). */
  readonly cache?: Pick<
    SemanticProjectionCache,
    "getProjection" | "putProjection"
  >;
}

const reportEncoder = new TextEncoder();
const reportDecoder = new TextDecoder("utf-8", { fatal: true });

const SEVERITIES = new Set(["error", "warning", "info"]);
const FINDINGS = new Set(["absent", "indeterminate", "present"]);

function optionalString(
  owner: Record<string, unknown>,
  key: string,
): boolean {
  return owner[key] === undefined || typeof owner[key] === "string";
}

/** Runtime validation of a cached report. Corrupt bytes are a cache
 * miss, never a valid report: no cast promotes them. */
export function parseCachedShaclReport(
  bytes: Uint8Array,
  expected: {
    readonly build: BuildRef;
    readonly storeVersion: string;
  },
): ShaclValidationReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportDecoder.decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.identity)) return undefined;
  const identity = parsed.identity;
  const identityFields = [
    "artifactDigest",
    "shapesDigest",
    "factsProjectorVersion",
    "engineId",
    "engineVersion",
    "optionsDigest",
  ] as const;
  if (
    identityFields.some((field) => typeof identity[field] !== "string") ||
    shaclReportStoreVersion(
        identity as unknown as ShaclValidationReport["identity"],
      ) !== expected.storeVersion ||
    identity.artifactDigest !== expected.build.artifactDigest ||
    typeof parsed.conforms !== "boolean" ||
    !Number.isSafeInteger(parsed.unmappedResults) ||
    (parsed.unmappedResults as number) < 0 ||
    !Array.isArray(parsed.diagnostics) ||
    canonical(parsed.build) !== canonical(expected.build)
  ) {
    return undefined;
  }
  for (const diagnostic of parsed.diagnostics as unknown[]) {
    if (
      !isRecord(diagnostic) ||
      typeof diagnostic.code !== "string" || !diagnostic.code ||
      typeof diagnostic.severity !== "string" ||
      !SEVERITIES.has(diagnostic.severity) ||
      typeof diagnostic.finding !== "string" ||
      !FINDINGS.has(diagnostic.finding) ||
      typeof diagnostic.message !== "string" ||
      !optionalString(diagnostic, "elementId") ||
      !optionalString(diagnostic, "qualifiedName") ||
      !optionalString(diagnostic, "pattern") ||
      (diagnostic.source !== undefined &&
        (!isRecord(diagnostic.source) ||
          typeof diagnostic.source.file !== "string" ||
          !Number.isSafeInteger(diagnostic.source.line) ||
          !Number.isSafeInteger(diagnostic.source.column))) ||
      (diagnostic.remedy !== undefined &&
        (!isRecord(diagnostic.remedy) ||
          diagnostic.remedy.kind !== "revision-template" ||
          typeof diagnostic.remedy.template !== "string"))
    ) {
      return undefined;
    }
  }
  const valid = parsed as unknown as ShaclValidationReport;
  return Object.freeze({
    ...valid,
    build: expected.build,
    identity: Object.freeze({ ...valid.identity }),
    diagnostics: Object.freeze(
      valid.diagnostics.map((diagnostic) =>
        Object.freeze({
          ...diagnostic,
          ...(diagnostic.source
            ? { source: Object.freeze({ ...diagnostic.source }) }
            : {}),
          ...(diagnostic.remedy
            ? { remedy: Object.freeze({ ...diagnostic.remedy }) }
            : {}),
        })
      ),
    ),
  });
}

export class ShaclModelDiagnostics implements ModelShapesDiagnostics {
  readonly #engineOption: ShaclModelDiagnosticsOptions["engine"];
  readonly #loadShapes: ShapesLoader;
  readonly #cache?: ShaclModelDiagnosticsOptions["cache"];
  #engine: Promise<ShaclEngine> | undefined;

  constructor(options: ShaclModelDiagnosticsOptions) {
    this.#engineOption = options.engine;
    this.#loadShapes = options.loadShapes ?? fileShapesLoader;
    this.#cache = options.cache;
  }

  #resolveEngine(): Promise<ShaclEngine> {
    this.#engine ??= Promise.resolve().then(() =>
      typeof this.#engineOption === "function"
        ? (this.#engineOption as () => Promise<ShaclEngine>)()
        : this.#engineOption
    );
    return this.#engine;
  }

  async validateBuild(input: {
    build: BuildRef;
    facts: ModelDiagnosticFacts;
    options?: { strictUnmapped?: boolean };
  }): Promise<ShaclValidationReport> {
    const build = parseBuildRef(input.build);
    if (
      !input.facts || !Array.isArray(input.facts.units) ||
      !Array.isArray(input.facts.effects) ||
      !Array.isArray(input.facts.networkCapabilities)
    ) {
      throw new ModelShapesError(
        "SHAPES_INVALID_INPUT",
        { reason: "Expected diagnostic facts with units/effects/capabilities" },
        "Invalid diagnostic facts",
      );
    }
    const engine = await this.#resolveEngine();
    const shapesTurtle = await this.#loadShapes();
    const identity = await createShaclReportIdentity({
      artifactDigest: build.artifactDigest,
      shapesDigest: await sha256(shapesTurtle),
      factsProjectorVersion: FACTS_PROJECTOR_VERSION,
      engineId: engine.engineId,
      engineVersion: engine.engineVersion,
      options: input.options,
    });
    const storeVersion = shaclReportStoreVersion(identity);
    // Cache slot must cover the complete serialized report: the application
    // identity covers A + shapes + projector + engine + options, but builds
    // sharing A can have different provenance. Include the normalized full
    // BuildRef and exact facts so immutable reports never share a slot.
    const factsDigest = await canonicalDigest(input.facts);
    // W2 projectorVersion is limited to 128 characters. Hash the entire
    // contextual identity rather than concatenating its unbounded fields;
    // retain the complete identity in the immutable report below.
    const cacheVersion = `shacl-v2:${await canonicalDigest({
      identity,
      build,
      factsDigest,
    })}`;
    if (this.#cache) {
      let cached: Uint8Array | undefined;
      try {
        cached = await this.#cache.getProjection(
          SHACL_REPORT_KIND,
          cacheVersion,
          build.artifactDigest,
        );
      } catch (error) {
        if (
          !(error instanceof BuildStoreError &&
            error.code === "BUILD_BLOB_MISSING")
        ) {
          throw error;
        }
      }
      if (cached) {
        const parsed = parseCachedShaclReport(cached, {
          build,
          storeVersion,
        });
        if (parsed) return parsed;
        // Corrupt or mismatched cache entry: recompute below.
      }
    }
    const projected = projectDiagnosticFacts(input.facts, build);
    const outcome = await engine.validate({
      shapesTurtle,
      dataNTriples: projected.ntriples,
    });
    const { diagnostics, unmappedResults } = mapShaclResults({
      results: outcome.results,
      projected,
    });
    if (input.options?.strictUnmapped && unmappedResults > 0) {
      throw new ModelShapesError(
        "SHACL_RESULT_UNMAPPED",
        { reason: `${unmappedResults} unmapped validation result(s)` },
        "SHACL produced results no Assembly mapping covers",
      );
    }
    const report: ShaclValidationReport = Object.freeze({
      build,
      identity,
      conforms: outcome.conforms,
      diagnostics: Object.freeze(diagnostics),
      unmappedResults,
    });
    await this.#cache?.putProjection(
      SHACL_REPORT_KIND,
      cacheVersion,
      build.artifactDigest,
      reportEncoder.encode(JSON.stringify(report)),
    );
    return report;
  }
}

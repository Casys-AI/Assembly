import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
/** Grouped parameterized SHACL-SPARQL over the complete leased native graph.
 * Compilation supplies associations; source facts supply locations and TS oracle only. */
import { Readable } from "node:stream";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import type {
  ModelDiagnostic,
  ModelDiagnosticFacts,
} from "../../../domain/model/policies/diagnostics.ts";
import { buildElementIri } from "../oxigraph/iri.ts";
import {
  type BuildRef,
  parseBuildRef,
  parseProjectionRef,
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
import {
  ASE_VOCAB,
  RDF_QUADS_KIND,
  RDF_QUADS_PROJECTOR_VERSION,
  XSD,
} from "../oxigraph/rdf.ts";
import {
  MAX_QUERY_BYTES,
  SemanticIndexError,
} from "../../../application/model/semantic/index-service.ts";
import { SEMANTIC_OXIGRAPH_VERSION } from "../oxigraph/runtime.ts";
import type {
  ShaclGraphRead,
  ValidateShaclShapesInput,
} from "../../../application/model/diagnostics/queries/inputs.ts";
import type { SemanticQueryLimits } from "../../../application/model/semantic/queries/inputs.ts";
import { admitSelect, bindAssociations, ShaclQueryError } from "./query.ts";

export const FACTS_PROJECTOR_VERSION = "ase-diagnostic-associations-v4";
export const FACTS_VOCAB = "urn:ase:facts:";
export const SHAPES_FILE = "ase-diagnostics-shapes.ttl";
export const SHACL_ENGINE_VERSION =
  `1.0.0+oxigraph-${SEMANTIC_OXIGRAPH_VERSION}+sparqljs-3.7.4`;
export const RDF_PARSER_SPECIFIER = "npm:@rdfjs/parser-n3@2.1.0";
export const SHACL_LIMITS: SemanticQueryLimits = Object.freeze({
  maxResults: 10000,
  maxBytes: 4_194_304,
  timeoutMs: 5000,
});
const fact = (name: string): string => `${FACTS_VOCAB}${name}`;
const SH = "http://www.w3.org/ns/shacl#";

export interface ShaclEngineResult {
  readonly focusNode: string;
  readonly ownerSystem?: string;
  readonly path?: string;
  readonly value?: string;
  readonly sourceShape?: string;
}
interface Association {
  readonly this: string;
  readonly ownerSystem: string;
  readonly budgetPolicy?: string;
  readonly allowedHostsAttribute?: string;
  readonly networkHostsAttribute?: string;
}
export interface ShaclEngineInput {
  readonly shapesTurtle: string;
  readonly graph: ShaclGraphRead;
  readonly units: readonly Association[];
  readonly capabilities: readonly Association[];
}
export interface ShaclEngine {
  readonly engineId: string;
  readonly engineVersion: string;
  validate(
    input: ShaclEngineInput,
  ): Promise<
    {
      readonly conforms: boolean;
      readonly results: readonly ShaclEngineResult[];
    }
  >;
}
function failure(reason: string): never {
  throw new ModelShapesError(
    "SHACL_VALIDATION_FAILED",
    { reason },
    "SHACL validation failed",
  );
}
interface Term {
  readonly termType: string;
  readonly value: string;
  readonly datatype?: Term;
  readonly language?: string;
}
interface Quad {
  readonly subject: Term;
  readonly predicate: Term;
  readonly object: Term;
  readonly graph: Term;
}

type ShapesParserModule = {
  default: new () => { import(stream: Readable): AsyncIterable<Quad> };
};
const loadShapesParser = async (): Promise<ShapesParserModule> => {
  const name: string = RDF_PARSER_SPECIFIER;
  return await import(name) as ShapesParserModule;
};

/** The small shapes graph is parsed separately; no model triples are copied. */
export async function createNativeShaclEngine(
  loadParser: () => Promise<ShapesParserModule> = loadShapesParser,
): Promise<ShaclEngine> {
  let Parser: ShapesParserModule["default"];
  try {
    ({ default: Parser } = await loadParser());
    if (typeof Parser !== "function") {
      throw new Error("Parser constructor is unavailable");
    }
  } catch (cause) {
    throw new ModelShapesError("SHACL_ENGINE_UNAVAILABLE", {
      reason: "Cannot load the pinned shapes parser",
      specifier: RDF_PARSER_SPECIFIER,
      cause: cause instanceof Error ? cause.message : String(cause),
    }, "SHACL engine is not available");
  }
  return Object.freeze({
    engineId: "assembly-native-shacl-sparql",
    engineVersion: SHACL_ENGINE_VERSION,
    async validate(input: ShaclEngineInput) {
      try {
        const quads: Quad[] = [];
        for await (
          const quad of new Parser().import(Readable.from([input.shapesTurtle]))
        ) quads.push(quad);
        const named = (value: string): Term => ({
          termType: "NamedNode",
          value,
        });
        const termKey = (term: Term) => canonical([term.termType, term.value]);
        const isNamed = (term: Term, value: string) =>
          term.termType === "NamedNode" && term.value === value;
        const isText = (term: Term) =>
          term.termType === "Literal" && !term.language &&
          term.datatype?.value === XSD.string;
        const objects = (subject: Term, predicate: string) =>
          quads.filter((q) =>
            termKey(q.subject) === termKey(subject) &&
            isNamed(q.predicate, predicate)
          ).map((q) => q.object);
        const shapes = quads.filter((q) =>
          q.subject.termType === "NamedNode" &&
          isNamed(q.predicate, ASE_VOCAB.rdfType) &&
          isNamed(q.object, SH + "NodeShape")
        ).map((q) => q.subject.value);
        const expected = [
          fact("LoopWithoutBudgetShape"),
          fact("CapabilityBeyondMandateShape"),
        ];
        if (
          shapes.length !== 2 ||
          expected.some((shape) => !shapes.includes(shape))
        ) failure("Expected exactly the two admitted parameterized shapes");
        if (
          quads.some((q) =>
            q.graph.termType !== "DefaultGraph" ||
            ![
              ASE_VOCAB.rdfType,
              SH + "severity",
              SH + "sparql",
              SH + "message",
              SH + "select",
            ].includes(q.predicate.value)
          )
        ) failure("Unsupported shape property or named graph");
        const constraints = shapes.map((shape) => {
          const links = objects(named(shape), SH + "sparql");
          if (
            links.length !== 1 ||
            !["NamedNode", "BlankNode"].includes(links[0]!.termType)
          ) {
            failure("Each shape requires one SELECT constraint");
          }
          const selects = objects(links[0]!, SH + "select");
          if (selects.length !== 1 || !isText(selects[0]!)) {
            failure("Constraint requires one literal SELECT");
          }
          const loop = shape === expected[0];
          return {
            shape,
            loop,
            associations: loop ? input.units : input.capabilities,
            query: admitSelect(selects[0]!.value),
          };
        });
        const constraintNodes = shapes.map((shape) =>
          objects(named(shape), SH + "sparql")[0]!
        );
        if (
          new Set(constraintNodes.map(termKey)).size !== 2 ||
          quads.length !== 10
        ) {
          failure(
            "Shapes contain duplicate, shared or unrecognized declarations",
          );
        }
        for (const [i, shape] of shapes.entries()) {
          const types = objects(named(shape), ASE_VOCAB.rdfType);
          const severity = objects(named(shape), SH + "severity");
          const messages = objects(constraintNodes[i]!, SH + "message");
          if (
            types.length !== 1 || !isNamed(types[0]!, SH + "NodeShape") ||
            severity.length !== 1 || !isNamed(severity[0]!, SH + "Warning") ||
            messages.length !== 1 || !isText(messages[0]!) ||
            messages[0]!.value !==
              (shape === expected[0]
                ? "LOOP_WITHOUT_BUDGET"
                : "CAPABILITY_BEYOND_MANDATE")
          ) failure("Unsupported shape type, severity or mapping message");
        }
        const query = async (sparql: string) => {
          const queryBytes = new TextEncoder().encode(sparql).length;
          if (queryBytes > MAX_QUERY_BYTES) {
            throw new ModelShapesError("SHACL_VALIDATION_FAILED", {
              reason:
                "Generated association query exceeds the native input byte limit",
              queryBytes,
              maxQueryBytes: MAX_QUERY_BYTES,
              recovery:
                "Validation covers the entire selected version and has no caller scope selector. Review the validation profile or model revision before retrying; grouped constraints cannot be split or truncated.",
            }, "SHACL query exceeds the native input budget");
          }
          const result = await input.graph.query(sparql, SHACL_LIMITS);
          if (result.form !== "solutions" || result.truncated) {
            failure(
              "Native SELECT was truncated or returned an unsupported result form",
            );
          }
          return result.rows;
        };
        const focus = new Map<
          string,
          { this: string; ownerSystem: string | undefined }
        >();
        const addFocus = (node: string, ownerSystem?: string) => {
          const row = { this: node, ownerSystem };
          focus.set(canonical(row), row);
        };
        for (const association of [...input.units, ...input.capabilities]) {
          addFocus(association.this);
          addFocus(association.ownerSystem);
          if (association.budgetPolicy) addFocus(association.budgetPolicy);
        }
        for (const association of input.capabilities) {
          if (!association.allowedHostsAttribute) {
            failure(
              "Capability requires its exact allowedHosts attribute identity",
            );
          }
          addFocus(association.allowedHostsAttribute, association.this);
          if (association.networkHostsAttribute) {
            addFocus(
              association.networkHostsAttribute,
              association.ownerSystem,
            );
          }
        }
        if (focus.size > SHACL_LIMITS.maxResults) {
          failure("Focus association budget exceeded");
        }
        if (focus.size) {
          const missing = await query(bindAssociations(
            admitSelect(`
            PREFIX sysml: <https://www.omg.org/spec/SysML#>
            SELECT ?this WHERE {
              FILTER NOT EXISTS {
                ?this a ?type .
                FILTER (!BOUND(?ownerSystem) || (?type = sysml:AttributeUsage && EXISTS { ?this sysml:owner ?ownerSystem }))
              }
            }
          `),
            [...focus.values()],
          ));
          if (missing.length) {
            failure(
              "Association references an absent, untyped or incorrectly owned model element",
            );
          }
        }
        const results: ShaclEngineResult[] = [];
        for (const constraint of constraints) {
          if (!constraint.associations.length) continue;
          if (constraint.associations.length > SHACL_LIMITS.maxResults) {
            failure("Constraint association budget exceeded");
          }
          const allowed = new Set(
            constraint.associations.map((a) =>
              JSON.stringify([a.this, a.ownerSystem])
            ),
          );
          const rows = await query(
            bindAssociations(
              constraint.query,
              constraint.associations.map((a) => ({
                ...a,
                ...(constraint.loop ? { budgetPolicy: a.budgetPolicy } : {
                  allowedHostsAttribute: a.allowedHostsAttribute,
                  networkHostsAttribute: a.networkHostsAttribute,
                }),
              })),
            ),
          );
          for (const row of rows) {
            if (
              row.this?.kind !== "iri" || row.ownerSystem?.kind !== "iri" ||
              !allowed.has(
                JSON.stringify([row.this.value, row.ownerSystem.value]),
              )
            ) {
              failure(
                "Native constraint returned a focus outside its admitted associations",
              );
            }
            if (!constraint.loop && row.value?.kind !== "literal") {
              failure("Host constraint did not return a literal host");
            }
            results.push({
              focusNode: row.this.value,
              ownerSystem: row.ownerSystem.value,
              path: fact(
                constraint.loop ? "hasInvocationBudget" : "outsideHost",
              ),
              ...(row.value ? { value: row.value.value } : {}),
              sourceShape: constraint.shape,
            });
          }
        }
        return { conforms: results.length === 0, results };
      } catch (error) {
        if (error instanceof ModelShapesError) throw error;
        throw new ModelShapesError(
          "SHACL_VALIDATION_FAILED",
          {
            reason: String(error),
            ...(error instanceof SemanticIndexError ||
                error instanceof ShaclQueryError
              ? {
                cause: {
                  code: error.code,
                  ...(error instanceof SemanticIndexError
                    ? { context: error.context, recovery: error.recovery }
                    : {}),
                },
              }
              : {}),
          },
          "SHACL validation failed",
          { cause: error },
        );
      }
    },
  });
}

interface ProjectedDiagnosticFacts {
  readonly units: readonly {
    readonly node: string;
    readonly unit: ModelDiagnosticFacts["units"][number];
  }[];
  readonly capabilities: readonly {
    readonly node: string;
    readonly ownerSystem: string;
    readonly capability: ModelDiagnosticFacts["networkCapabilities"][number];
  }[];
}

/** Validate compiler provenance at the adapter trust boundary; never infer owners. */
function associations(facts: ModelDiagnosticFacts, build: BuildRef) {
  const context = facts.graphContext;
  const invalid = (reason: string): never => {
    throw new ModelShapesError(
      "SHAPES_INVALID_INPUT",
      { reason },
      "Invalid diagnostic graph context",
    );
  };
  if (
    !context || !Array.isArray(context.units) ||
    !Array.isArray(context.capabilities)
  ) invalid("Compiler graphContext is required");
  const validId = (value: unknown) =>
    typeof value === "string" && value.length > 0;
  if (
    context!.units.some((u) =>
      !isRecord(u) || !validId(u.elementId) ||
      !["conversation", "plan"].includes(u.kind) || !validId(u.ownerSystemId) ||
      (u.budgetPolicyId !== undefined && !validId(u.budgetPolicyId))
    ) || context!.capabilities.some((c) =>
      !isRecord(c) || !validId(c.policyElementId) ||
      !validId(c.ownerSystemId) || !validId(c.allowedHostsAttributeId) ||
      (c.networkHostsAttributeId !== undefined &&
        !validId(c.networkHostsAttributeId))
    )
  ) invalid("Malformed compiler association");
  const iriCache = new Map<string, string>();
  const iri = (nativeId: string): string => {
    let value = iriCache.get(nativeId);
    if (value === undefined) {
      try {
        value = buildElementIri({ build, nativeId }, "user");
      } catch {
        return invalid("Invalid scoped native identity");
      }
      iriCache.set(nativeId, value);
    }
    return value;
  };
  const key = (...parts: string[]) => JSON.stringify(parts);
  const owners = new Map<string, string | undefined>();
  const contextUnits = new Set<string>();
  const unitKinds = new Map<string, string>();
  for (const unit of context!.units) {
    if (
      unitKinds.has(unit.elementId) &&
      unitKinds.get(unit.elementId) !== unit.kind
    ) invalid("One model element cannot be both a conversation and a plan");
    unitKinds.set(unit.elementId, unit.kind);
    contextUnits.add(key(unit.elementId, unit.kind));
    if (unit.kind === "conversation" && unit.elementId === unit.ownerSystemId) {
      if (
        owners.has(unit.elementId) &&
        owners.get(unit.elementId) !== unit.budgetPolicyId
      ) invalid("Conflicting owner budget associations");
      owners.set(unit.elementId, unit.budgetPolicyId);
    }
  }
  const factUnits = new Set(
    facts.units.map((unit) => key(unit.location.elementId!, unit.kind)),
  );
  const factCapabilities = new Map<string, Set<string | undefined>>();
  for (const capability of facts.networkCapabilities) {
    const id = capability.location.elementId!;
    const bucket = factCapabilities.get(id) ?? new Set();
    bucket.add(capability.ownerSystemId);
    factCapabilities.set(id, bucket);
  }
  const units = context!.units.map((unit) => {
    if (
      !factUnits.has(key(unit.elementId, unit.kind)) ||
      !owners.has(unit.ownerSystemId) ||
      owners.get(unit.ownerSystemId) !== unit.budgetPolicyId ||
      (unit.kind === "conversation" && unit.elementId !== unit.ownerSystemId)
    ) {
      invalid(
        "Unit association does not match its compiled owner, budget and source unit",
      );
    }
    return {
      this: iri(unit.elementId),
      ownerSystem: iri(unit.ownerSystemId),
      ...(unit.budgetPolicyId !== undefined
        ? { budgetPolicy: iri(unit.budgetPolicyId) }
        : {}),
    };
  });
  const capabilityOwners = new Map<string, Set<string>>();
  const capabilities = context!.capabilities.map((capability) => {
    const sourceOwners = factCapabilities.get(capability.policyElementId);
    if (
      !owners.has(capability.ownerSystemId) ||
      !(sourceOwners?.has(undefined) ||
        sourceOwners?.has(capability.ownerSystemId))
    ) {
      invalid(
        "Capability association does not match its compiled owner and source policy",
      );
    }
    const bucket = capabilityOwners.get(capability.policyElementId) ??
      new Set();
    bucket.add(capability.ownerSystemId);
    capabilityOwners.set(capability.policyElementId, bucket);
    return {
      this: iri(capability.policyElementId),
      ownerSystem: iri(capability.ownerSystemId),
      allowedHostsAttribute: iri(capability.allowedHostsAttributeId!),
      ...(capability.networkHostsAttributeId === undefined
        ? {}
        : { networkHostsAttribute: iri(capability.networkHostsAttributeId) }),
    };
  });
  if ([...factUnits].some((unit) => !contextUnits.has(unit))) {
    invalid("Incomplete compiler unit associations");
  }
  const projected: ProjectedDiagnosticFacts = {
    units: facts.units.map((unit) => ({
      node: iri(unit.location.elementId!),
      unit,
    })),
    capabilities: facts.networkCapabilities.map((capability) => {
      const admittedOwners = capabilityOwners.get(
        capability.location.elementId!,
      );
      const owner = capability.ownerSystemId ??
        (admittedOwners?.size === 1
          ? admittedOwners.values().next().value
          : undefined);
      if (owner === undefined || !admittedOwners?.has(owner)) {
        invalid("Capability source mapping requires one exact admitted owner");
      }
      return {
        node: iri(capability.location.elementId!),
        ownerSystem: iri(owner!),
        capability,
      };
    }),
  };
  return { units, capabilities, projected };
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
    input.projected.capabilities.map((
      entry,
    ) => [canonical([entry.node, entry.ownerSystem]), entry]),
  );
  const diagnostics: ModelDiagnostic[] = [];
  const hostFindings = new Map<string, Set<string>>();
  const budgetFindings = new Set<string>();
  let unmappedResults = 0;
  for (const result of input.results) {
    if (result.path === fact("hasInvocationBudget")) {
      const unit = unitsByNode.get(result.focusNode);
      if (!unit) {
        unmappedResults++;
        continue;
      }
      if (budgetFindings.has(result.focusNode)) continue;
      budgetFindings.add(result.focusNode);
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
      const key = canonical([result.focusNode, result.ownerSystem]);
      if (!capabilitiesByNode.has(key)) {
        unmappedResults++;
        continue;
      }
      const hosts = hostFindings.get(key) ?? new Set<string>();
      if (result.value !== undefined) hosts.add(result.value);
      hostFindings.set(key, hosts);
      continue;
    }
    unmappedResults++;
  }
  for (const [node, hosts] of hostFindings) {
    const entry = capabilitiesByNode.get(
      node,
    ) as ProjectedDiagnosticFacts["capabilities"][number];
    const outside = [...hosts].sort(compareCodeUnits);
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
  return {
    diagnostics: sortDiagnostics(diagnostics),
    unmappedResults,
  };
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

/** Runtime validation of a cached report; the caller refuses corrupt bytes. */
export function parseCachedShaclReport(
  bytes: Uint8Array,
  expected: {
    readonly build: BuildRef;
    readonly storeVersion: string;
    readonly projection?: ShaclValidationReport["projection"];
    readonly contextDigest?: string;
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
    canonical(parsed.build) !== canonical(expected.build) ||
    canonical(parsed.projection) !== canonical(expected.projection) ||
    parsed.contextDigest !== expected.contextDigest ||
    parsed.conforms !==
      (parsed.diagnostics.length === 0 && parsed.unmappedResults === 0)
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

  async validateBuild(
    input: ValidateShaclShapesInput,
  ): Promise<ShaclValidationReport> {
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
    if (
      !input.graph || canonical(input.graph.build) !== canonical(build) ||
      !input.graph.projection
    ) {
      throw new ModelShapesError("SHAPES_INVALID_INPUT", {
        reason: "Exact leased graph and projection are required",
      }, "Invalid SHACL graph");
    }
    const projection = parseProjectionRef(input.graph.projection);
    const contextPrefix = `${RDF_QUADS_PROJECTOR_VERSION}:`;
    if (
      projection.artifactDigest !== build.artifactDigest ||
      projection.kind !== RDF_QUADS_KIND ||
      !projection.projectorVersion.startsWith(contextPrefix) ||
      !isSha256Hex(projection.projectorVersion.slice(contextPrefix.length))
    ) {
      throw new ModelShapesError("SHAPES_INVALID_INPUT", {
        reason:
          "Projection must match the exact build and supported RDF context version",
        expectedKind: RDF_QUADS_KIND,
        expectedProjectorVersion:
          `${contextPrefix}<64 lowercase hex context digest>`,
        actualKind: projection.kind,
        actualProjectorVersion: projection.projectorVersion,
      }, "Incompatible SHACL model projection");
    }
    const association = associations(input.facts, build);
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
    const contextDigest = await canonicalDigest(input.facts.graphContext);
    // W2 projectorVersion is limited to 128 characters. Hash the entire
    // contextual identity rather than concatenating its unbounded fields;
    // retain the complete identity in the immutable report below.
    const cacheVersion = `shacl-v2:${await canonicalDigest({
      identity,
      build,
      factsDigest,
      projection,
      limits: SHACL_LIMITS,
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
          projection,
          contextDigest,
        });
        if (parsed) return parsed;
        failure("Corrupt or mismatched immutable report cache entry");
      }
    }
    const projected = association.projected;
    const outcome = await engine.validate({
      shapesTurtle,
      graph: input.graph,
      units: association.units,
      capabilities: association.capabilities,
    });
    if (outcome.conforms !== (outcome.results.length === 0)) {
      failure("Engine report contradicts its results");
    }
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
      projection,
      contextDigest,
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

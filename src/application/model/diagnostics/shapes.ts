/** Advisory, immutable reports over exact native model projections.
 * Compiler associations bind parameterized constraints; user masks stay in
 * ModelDiagnosticsService. Toolkit and domain authority remain independent. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  ModelDiagnostic,
} from "../../../domain/model/policies/diagnostics.ts";
import type {
  BuildRef,
  ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";

export const SHACL_REPORT_KIND = "shacl-report";

export interface ShaclEngineOptions {
  /** Refuse (instead of count) validation results no mapping covers. */
  readonly strictUnmapped?: boolean;
}

interface ShaclReportIdentity {
  /** Artifact digest `A` of the validated build. */
  readonly artifactDigest: string;
  /** sha256 of the exact shapes bytes. */
  readonly shapesDigest: string;
  readonly factsProjectorVersion: string;
  readonly engineId: string;
  readonly engineVersion: string;
  /** sha256 of the canonical engine options. */
  readonly optionsDigest: string;
}

export interface ShaclValidationReport {
  readonly build: BuildRef;
  readonly identity: ShaclReportIdentity;
  /** Present for native graph reports; legacy serialized reports may omit it. */
  readonly projection?: ProjectionRef;
  readonly contextDigest?: string;
  readonly conforms: boolean;
  /** Diagnostics in the domain shape, joinable with the TS lint output. */
  readonly diagnostics: readonly ModelDiagnostic[];
  /** Engine results no product mapping claimed; never silently dropped. */
  readonly unmappedResults: number;
}

/** Exact viewed source beside the existing build/engine/shapes report. */
export interface ModelShapesDiagnosticsResult {
  readonly version: string;
  readonly report: ShaclValidationReport;
}

type ModelShapesErrorCode =
  | "SHAPES_INVALID_INPUT"
  | "SHACL_ENGINE_UNAVAILABLE"
  | "SHACL_VALIDATION_FAILED"
  | "SHACL_RESULT_UNMAPPED";

const RECOVERY: Record<ModelShapesErrorCode, string> = {
  SHAPES_INVALID_INPUT:
    "Fix the caller: build reference, facts or shapes are malformed (see context.reason).",
  SHACL_ENGINE_UNAVAILABLE:
    "Install the pinned shapes/query parsers and native semantic index; there is no alternate evaluator.",
  SHACL_VALIDATION_FAILED:
    "Inspect the shapes, compiler associations, native query limits and report cache; the TS lint remains available.",
  SHACL_RESULT_UNMAPPED:
    "Extend the Assembly result mapping for the new shape, or rerun without strictUnmapped to count instead of refuse.",
};

export class ModelShapesError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: ModelShapesErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelShapesError";
    this.recovery = RECOVERY[code];
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function requireField(
  condition: boolean,
  reason: string,
  path: string,
): void {
  if (!condition) {
    throw new ModelShapesError(
      "SHAPES_INVALID_INPUT",
      { reason, path },
      `Invalid SHACL report identity: ${path}`,
    );
  }
}

export async function createShaclReportIdentity(input: {
  readonly artifactDigest: string;
  readonly shapesDigest: string;
  readonly factsProjectorVersion: string;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly options?: ShaclEngineOptions;
}): Promise<ShaclReportIdentity> {
  requireField(
    HEX64.test(input.artifactDigest),
    "Expected 64 lowercase hex characters",
    "artifactDigest",
  );
  requireField(
    HEX64.test(input.shapesDigest),
    "Expected 64 lowercase hex characters",
    "shapesDigest",
  );
  const textKeys = [
    "factsProjectorVersion",
    "engineId",
    "engineVersion",
  ] as const;
  for (const key of textKeys) {
    requireField(
      typeof input[key] === "string" && !!input[key] &&
        (input[key] as string).length <= 128,
      "Expected 1–128 characters",
      key,
    );
  }
  const optionsDigest = await canonicalDigest({
    strictUnmapped: input.options?.strictUnmapped ?? false,
  });
  return Object.freeze({
    artifactDigest: input.artifactDigest,
    shapesDigest: input.shapesDigest,
    factsProjectorVersion: input.factsProjectorVersion,
    engineId: input.engineId,
    engineVersion: input.engineVersion,
    optionsDigest,
  });
}

/** Store addressing for the W2 projection cache (`kind, version, A`):
 * the version slot carries engine, facts and shapes identity so two
 * reports for one artifact never overwrite each other. */
export function shaclReportStoreVersion(
  identity: ShaclReportIdentity,
): string {
  return [
    identity.engineId,
    identity.engineVersion,
    identity.factsProjectorVersion,
    identity.shapesDigest,
    identity.optionsDigest,
  ].join(":");
}

interface DiagnosticFieldMismatch {
  readonly key: string;
  readonly field: "finding" | "message" | "remedy" | "source" | "qualifiedName";
  readonly shacl: unknown;
  readonly reference: unknown;
}

interface DiagnosticComparison {
  readonly equal: boolean;
  readonly matched: number;
  readonly onlyShacl: readonly ModelDiagnostic[];
  readonly onlyReference: readonly ModelDiagnostic[];
  readonly mismatched: readonly DiagnosticFieldMismatch[];
}

function diagnosticKey(diagnostic: ModelDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.elementId ?? null,
    diagnostic.severity,
  ]);
}

/** Compare SHACL-derived diagnostics with the TypeScript lint on equal
 * footing: code, target, severity, finding, message (which carries the
 * outside hosts), remedy and locatable source. Restrict with `codes`
 * when only some rules are claimed (two rules are not “SHACL complete”). */
export function compareDiagnostics(input: {
  readonly shacl: readonly ModelDiagnostic[];
  readonly reference: readonly ModelDiagnostic[];
  readonly codes?: readonly string[];
}): DiagnosticComparison {
  const wanted = input.codes ? new Set(input.codes) : undefined;
  const pick = (all: readonly ModelDiagnostic[]) =>
    wanted ? all.filter((d) => wanted.has(d.code)) : [...all];
  const shacl = pick(input.shacl);
  const reference = pick(input.reference);
  const referenceByKey = new Map<string, ModelDiagnostic[]>();
  for (const diagnostic of reference) {
    const bucket = referenceByKey.get(diagnosticKey(diagnostic)) ?? [];
    bucket.push(diagnostic);
    referenceByKey.set(diagnosticKey(diagnostic), bucket);
  }
  const onlyShacl: ModelDiagnostic[] = [];
  const mismatched: DiagnosticFieldMismatch[] = [];
  let matched = 0;
  for (const diagnostic of shacl) {
    const key = diagnosticKey(diagnostic);
    const candidate = referenceByKey.get(key)?.shift();
    if (!candidate) {
      onlyShacl.push(diagnostic);
      continue;
    }
    matched++;
    const fields: Array<[
      DiagnosticFieldMismatch["field"],
      unknown,
      unknown,
    ]> = [
      ["finding", diagnostic.finding, candidate.finding],
      ["message", diagnostic.message, candidate.message],
      [
        "remedy",
        diagnostic.remedy?.template ?? null,
        candidate.remedy?.template ?? null,
      ],
      [
        "source",
        diagnostic.source ?? null,
        candidate.source ?? null,
      ],
      [
        "qualifiedName",
        diagnostic.qualifiedName ?? null,
        candidate.qualifiedName ?? null,
      ],
    ];
    for (const [field, left, right] of fields) {
      if (canonical(left) !== canonical(right)) {
        mismatched.push({ key, field, shacl: left, reference: right });
      }
    }
  }
  const onlyReference = [...referenceByKey.values()].flat();
  return Object.freeze({
    equal: onlyShacl.length === 0 && onlyReference.length === 0 &&
      mismatched.length === 0,
    matched,
    onlyShacl: Object.freeze(onlyShacl),
    onlyReference: Object.freeze(onlyReference),
    mismatched: Object.freeze(mismatched),
  });
}

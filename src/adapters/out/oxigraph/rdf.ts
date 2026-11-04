import { Buffer } from "node:buffer";
import { isPlainRecord as isRecord } from "../../../domain/primitives/is-plain-record.ts";
/** Deterministic RDF projection of verified `A.elements` (W5).
 *
 * Input is the canonical native normalized element graph, already
 * verified against `A` by W2. No SysML is re-analyzed and no runtime
 * state enters: the same elements, repository and verified library metadata produce the same sorted
 * N-Quads bytes. Lists preserve order and duplicates through occurrence
 * nodes (direct triples are query convenience only). See
 * `native/semantic-index/API-CONTRACT-SEMANTIC.md` for the vocabulary.
 */
import { compareCodeUnits } from "../../../domain/primitives/canonical-json.ts";
import type { JsonObject } from "../../../domain/model/records/compiled-model.ts";
import { sha256Bytes } from "../../../domain/primitives/sha256-bytes.ts";
import {
  buildGraphIri,
  type BuildRef,
  encodeIriSegment,
  libraryElementIri,
  parseBuildRef,
  parseProjectionRef,
  userElementIri,
} from "../../../domain/model/value-objects/element-ref.ts";
import { contextualProjectorVersion } from "../../../application/model/semantic/index-service.ts";
import type { ModelRdfProjector } from "../../../application/model/semantic/ports/out/rdf-projector.port.ts";

export const RDF_QUADS_KIND = "rdf-quads";
export const RDF_QUADS_PROJECTOR_VERSION = "ase-rdf-quads-v4";

export const ASE_VOCAB = Object.freeze({
  base: "urn:ase:vocab:",
  rdfType: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  metaclass: "urn:ase:vocab:metaclass",
  nativeId: "urn:ase:vocab:nativeId",
  name: "urn:ase:vocab:name",
  qualifiedName: "urn:ase:vocab:qualifiedName",
  occurrenceList: "urn:ase:vocab:OccurrenceList",
  length: "urn:ase:vocab:length",
  occurrence: "urn:ase:vocab:occurrence",
  index: "urn:ase:vocab:index",
  value: "urn:ase:vocab:value",
  nullValue: "urn:ase:vocab:null",
});

export const XSD = Object.freeze({
  string: "http://www.w3.org/2001/XMLSchema#string",
  integer: "http://www.w3.org/2001/XMLSchema#integer",
  double: "http://www.w3.org/2001/XMLSchema#double",
  boolean: "http://www.w3.org/2001/XMLSchema#boolean",
});

export const SYSML_VOCAB = "https://www.omg.org/spec/SysML#";
export const ASE_PROPERTY_VOCAB = "urn:ase:vocab:prop:";

/** Canonical Toolkit property name → reversible predicate IRI. Source annotations
 * are Assembly extensions, not SysML properties. */
export function propPredicate(property: string): string {
  return `${property.startsWith("sysx:") ? ASE_PROPERTY_VOCAB : SYSML_VOCAB}${
    encodeIriSegment(property)
  }`;
}
/** Members of a JSON string-array literal, retaining the original literal. */
export function stringArrayMemberPredicate(property: string): string {
  return `urn:ase:vocab:string-array-member:${encodeIriSegment(property)}`;
}
export function listPredicate(property: string): string {
  return `urn:ase:vocab:list:${encodeIriSegment(property)}`;
}
export function metaclassIri(metaclass: string): string {
  return `${SYSML_VOCAB}${encodeIriSegment(metaclass)}`;
}

export class RdfProjectionError extends Error {
  readonly recovery =
    "Re-project from the verified canonical artifact bytes; malformed element graphs must be fixed at the compiler/normalizer boundary, not patched here.";
  constructor(
    readonly code: "RDF_PROJECTION_INVALID" | "RDF_PROJECTION_UNSUPPORTED",
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "RdfProjectionError";
  }
}

function invalid(reason: string, extra: Record<string, unknown> = {}): never {
  throw new RdfProjectionError(
    "RDF_PROJECTION_INVALID",
    { reason, ...extra },
    `Invalid element graph for RDF projection: ${reason}`,
  );
}

// --- N-Quads formatting ---

export function escapeNQuadsLiteral(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += char;
  }
  return out;
}

const iriTerm = (iri: string): string => `<${iri}>`;
const blankTerm = (label: string): string => `_:${label}`;
export function literalTerm(value: string, datatype: string): string {
  const lexical = `"${escapeNQuadsLiteral(value)}"`;
  return datatype === XSD.string ? lexical : `${lexical}^^<${datatype}>`;
}

const utf8 = new TextEncoder();
// --- Projection core ---

interface ProjectionContext {
  readonly repositoryId: string;
  readonly libraryIds: ReadonlySet<string>;
  readonly graph: string;
  readonly lines: string[];
  readonly blankLabels: Map<string, string>;
}

/** Keep repeated visits to the same structural path on the same blank node. */
function blankNode(
  context: ProjectionContext,
  path: readonly string[],
): string {
  const key = JSON.stringify(path);
  let label = context.blankLabels.get(key);
  if (label === undefined) {
    label = `b${context.blankLabels.size}`;
    context.blankLabels.set(key, label);
  }
  return blankTerm(label);
}

function quad(
  context: ProjectionContext,
  subject: string,
  predicateIri: string,
  object: string,
): void {
  context.lines.push(
    `${subject} <${predicateIri}> ${object} ${context.graph} .`,
  );
}

function elementTerm(context: ProjectionContext, nativeId: string): string {
  return iriTerm(
    context.libraryIds.has(nativeId)
      ? libraryElementIri(nativeId)
      : userElementIri(context.repositoryId, nativeId),
  );
}

function scalarTerm(value: string | number | boolean): string {
  if (typeof value === "string") return literalTerm(value, XSD.string);
  if (typeof value === "boolean") {
    return literalTerm(value ? "true" : "false", XSD.boolean);
  }
  if (!Number.isFinite(value)) {
    throw new RdfProjectionError(
      "RDF_PROJECTION_UNSUPPORTED",
      { reason: "Non-finite numbers have no canonical JSON/RDF form" },
      "Unsupported element value: non-finite number",
    );
  }
  return Number.isSafeInteger(value)
    ? literalTerm(String(value), XSD.integer)
    : literalTerm(String(value), XSD.double);
}

/** Object term for any value; emits extra quads for compound values. */
function termForValue(
  context: ProjectionContext,
  value: unknown,
  path: readonly string[],
): string {
  if (value === null) return iriTerm(ASE_VOCAB.nullValue);
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return scalarTerm(value);
  }
  if (Array.isArray(value)) return emitList(context, value, path);
  if (isRecord(value)) {
    const refId = value["@id"];
    if (typeof refId === "string" && refId) {
      const term = elementTerm(context, refId);
      // An embedded object beyond a bare reference keeps its extra
      // properties, stated about the referenced element.
      for (const key of Object.keys(value).sort(compareCodeUnits)) {
        if (key === "@id") continue;
        emitProperty(context, term, key, value[key], [...path, key]);
      }
      return term;
    }
    const term = blankNode(context, path);
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      emitProperty(context, term, key, value[key], [...path, key]);
    }
    return term;
  }
  throw new RdfProjectionError(
    "RDF_PROJECTION_UNSUPPORTED",
    { reason: `Unsupported value type ${typeof value}` },
    "Unsupported element value type",
  );
}

/** Occurrence list node; the authoritative order/duplicates record. */
function emitList(
  context: ProjectionContext,
  items: readonly unknown[],
  path: readonly string[],
): string {
  const list = blankNode(context, path);
  quad(context, list, ASE_VOCAB.rdfType, iriTerm(ASE_VOCAB.occurrenceList));
  quad(
    context,
    list,
    ASE_VOCAB.length,
    literalTerm(String(items.length), XSD.integer),
  );
  items.forEach((item, index) => {
    const occurrence = blankNode(context, [...path, `#${index}`]);
    quad(context, list, ASE_VOCAB.occurrence, occurrence);
    quad(
      context,
      occurrence,
      ASE_VOCAB.index,
      literalTerm(String(index), XSD.integer),
    );
    quad(
      context,
      occurrence,
      ASE_VOCAB.value,
      termForValue(context, item, [...path, `#${index}`, "v"]),
    );
  });
  return list;
}

function emitProperty(
  context: ProjectionContext,
  subject: string,
  property: string,
  value: unknown,
  path: readonly string[],
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    const list = emitList(context, value, path);
    quad(context, subject, listPredicate(property), list);
    // Direct triples: query convenience. Duplicates collapse here; the
    // occurrence list above remains the roundtrip authority.
    value.forEach((item, index) => {
      quad(
        context,
        subject,
        propPredicate(property),
        termForValue(context, item, [...path, `#${index}`, "v"]),
      );
    });
    return;
  }
  quad(
    context,
    subject,
    propPredicate(property),
    termForValue(context, value, path),
  );
  if (typeof value === "string" && value.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    if (
      Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ) {
      for (const item of parsed) {
        quad(
          context,
          subject,
          stringArrayMemberPredicate(property),
          scalarTerm(item),
        );
      }
    }
  }
}

export interface ModelProjectionInput {
  readonly build: BuildRef;
  readonly elements: readonly JsonObject[];
  readonly libraryNativeIds: readonly string[];
}

function canonicalLines(input: ModelProjectionInput): string[] {
  const build = parseBuildRef(input.build);
  if (!Array.isArray(input.elements)) invalid("elements is not an array");
  if (
    !Array.isArray(input.libraryNativeIds) ||
    input.libraryNativeIds.some((id) =>
      typeof id !== "string" || !id || id.length > 2048 || id.includes("\0")
    )
  ) invalid("libraryNativeIds must be verified non-empty native IDs");
  const context: ProjectionContext = {
    repositoryId: build.repositoryId,
    libraryIds: new Set(input.libraryNativeIds),
    graph: iriTerm(buildGraphIri(build)),
    lines: [],
    blankLabels: new Map(),
  };
  const seen = new Set<string>();
  for (const element of input.elements) {
    if (!isRecord(element)) invalid("element is not an object");
    const nativeId = element["@id"];
    const metaclass = element["@type"];
    if (typeof nativeId !== "string" || !nativeId) {
      invalid("element @id is not a non-empty string");
    }
    if (typeof metaclass !== "string" || !metaclass) {
      invalid("element @type is not a non-empty string", { nativeId });
    }
    if (seen.has(nativeId)) invalid("duplicate element @id", { nativeId });
    seen.add(nativeId);
  }
  // Allocation follows a canonical traversal, independent of input order.
  const orderedElements = [...input.elements].sort((a, b) =>
    compareCodeUnits(a["@id"] as string, b["@id"] as string)
  );
  for (const element of orderedElements) {
    const nativeId = element["@id"] as string;
    const metaclass = element["@type"] as string;
    const subject = elementTerm(context, nativeId);
    quad(context, subject, ASE_VOCAB.rdfType, iriTerm(metaclassIri(metaclass)));
    quad(
      context,
      subject,
      ASE_VOCAB.metaclass,
      literalTerm(metaclass, XSD.string),
    );
    quad(
      context,
      subject,
      ASE_VOCAB.nativeId,
      literalTerm(nativeId, XSD.string),
    );
    // Explicit aliases only; canonical Toolkit properties remain primary.
    const declaredName = element["declaredName"] ?? element["name"];
    if (typeof declaredName === "string") {
      quad(
        context,
        subject,
        ASE_VOCAB.name,
        literalTerm(declaredName, XSD.string),
      );
    }
    if (typeof element["qualifiedName"] === "string") {
      quad(
        context,
        subject,
        ASE_VOCAB.qualifiedName,
        literalTerm(element["qualifiedName"] as string, XSD.string),
      );
    }
    for (const key of Object.keys(element).sort(compareCodeUnits)) {
      if (key === "@id" || key === "@type") continue;
      emitProperty(context, subject, key, element[key], [nativeId, key]);
    }
  }
  return [...new Set(context.lines)].sort(compareCodeUnits);
}

const DEFAULT_BATCH_BYTES = 1024 * 1024;

/** Canonical complete-quad batches. The OpenClaw export plugin suggested
 * batching, using projection helpers originally derived from Assembly. Global
 * sorting is retained here to preserve Assembly's existing byte identity. */
export function projectModelToNQuadBatches(
  input: ModelProjectionInput,
  targetBytes = DEFAULT_BATCH_BYTES,
): {
  readonly batches: Iterable<string>;
  readonly quadCount: number;
  readonly byteLength: number;
} {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    invalid("batch limit must be a positive safe integer", { targetBytes });
  }
  const lines = canonicalLines(input);
  const ends: number[] = [];
  let byteLength = 0;
  let batchBytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const lineBytes = Buffer.byteLength(lines[index]!, "utf8") + 1;
    if (batchBytes && batchBytes + lineBytes > targetBytes) {
      ends.push(index);
      batchBytes = 0;
    }
    batchBytes += lineBytes;
    byteLength += lineBytes;
  }
  if (batchBytes) ends.push(lines.length);
  function* batches(): Generator<string> {
    let start = 0;
    for (const end of ends) {
      yield `${lines.slice(start, end).join("\n")}\n`;
      start = end;
    }
  }
  return { batches: batches(), quadCount: lines.length, byteLength };
}

/** Sorted canonical N-Quads text for explicit tools and tests. */
export function projectModelToNQuads(input: ModelProjectionInput): {
  readonly nquads: string;
  readonly quadCount: number;
} {
  const { batches, quadCount } = projectModelToNQuadBatches(input);
  return { nquads: [...batches].join(""), quadCount };
}

/** W2 projection keyed by kind, contextual version and A. The contextual
 * version hashes repository scope and verified library classification. */
export class DeterministicRdfModelProjector implements ModelRdfProjector {
  readonly kind = RDF_QUADS_KIND;
  readonly projectorVersion = RDF_QUADS_PROJECTOR_VERSION;

  async project(input: ModelProjectionInput) {
    const { batches, quadCount, byteLength } = projectModelToNQuadBatches(
      input,
    );
    const quads = new Uint8Array(byteLength);
    let offset = 0;
    for (const batch of batches) {
      offset += utf8.encodeInto(batch, quads.subarray(offset)).written;
    }
    const projectionDigest = await sha256Bytes(quads);
    return {
      quads,
      projection: parseProjectionRef({
        kind: this.kind,
        projectorVersion: await contextualProjectorVersion(
          this.projectorVersion,
          input.build,
          input.libraryNativeIds,
        ),
        artifactDigest: input.build.artifactDigest,
        projectionDigest,
      }),
      quadCount,
    };
  }
}

// --- Minimal strict N-Quads/N-Triples reader (roundtrip + facts checks) ---

export type ParsedTerm =
  | { readonly kind: "iri"; readonly value: string }
  | { readonly kind: "blank"; readonly value: string }
  | {
    readonly kind: "literal";
    readonly value: string;
    readonly datatype: string;
    readonly language?: string;
  };

export interface ParsedQuad {
  readonly subject: ParsedTerm;
  readonly predicate: string;
  readonly object: ParsedTerm;
  readonly graph?: string;
}

function unescapeLiteral(raw: string, line: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] as string;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[index + 1];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === '"') out += '"';
    else if (next === "\\") out += "\\";
    else if (next === "u") {
      out += String.fromCodePoint(
        parseInt(raw.slice(index + 2, index + 6), 16),
      );
      index += 4;
    } else if (next === "U") {
      out += String.fromCodePoint(
        parseInt(raw.slice(index + 2, index + 10), 16),
      );
      index += 8;
    } else invalid("bad literal escape", { line });
    index++;
  }
  return out;
}

const TERM_PATTERN =
  /^(?:<([^<>\s]*)>|_:([A-Za-z0-9_][A-Za-z0-9_-]*)|"((?:\\.|[^"\\])*)"(?:\^\^<([^<>\s]*)>|@([A-Za-z0-9-]+))?)/;

function parseTerm(
  rest: string,
  line: string,
): { term: ParsedTerm; rest: string } {
  const match = TERM_PATTERN.exec(rest);
  if (!match) invalid("unparseable RDF term", { line });
  const [, iri, blank, literal, datatype, language] = match as unknown as [
    string,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
  ];
  const term: ParsedTerm = iri !== undefined
    ? { kind: "iri", value: iri }
    : blank !== undefined
    ? { kind: "blank", value: blank }
    : {
      kind: "literal",
      value: unescapeLiteral(literal as string, line),
      datatype: datatype ?? XSD.string,
      ...(language ? { language } : {}),
    };
  return { term, rest: rest.slice((match as RegExpExecArray)[0].length) };
}

/** Parse canonical N-Quads (or N-Triples) text. Blank lines and `#`
 * comment lines are skipped; anything else malformed is refused. */
export function parseNQuads(text: string): ParsedQuad[] {
  const quads: ParsedQuad[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.endsWith(".")) {
      invalid("quad line does not end with '.'", { line });
    }
    let rest = line.slice(0, -1).trimEnd();
    const subject = parseTerm(rest, line);
    rest = subject.rest.trimStart();
    if (subject.term.kind === "literal") {
      invalid("literal subject", { line });
    }
    const predicate = parseTerm(rest, line);
    if (predicate.term.kind !== "iri") invalid("non-IRI predicate", { line });
    rest = predicate.rest.trimStart();
    const object = parseTerm(rest, line);
    rest = object.rest.trimStart();
    let graph: string | undefined;
    if (rest) {
      const graphTerm = parseTerm(rest, line);
      if (graphTerm.term.kind === "literal") {
        invalid("literal graph name", { line });
      }
      graph = (graphTerm.term as { value: string }).value;
      rest = graphTerm.rest.trimStart();
      if (rest) invalid("trailing content after quad", { line });
    }
    quads.push({
      subject: subject.term,
      predicate: (predicate.term as { value: string }).value,
      object: object.term,
      ...(graph !== undefined ? { graph } : {}),
    });
  }
  return quads;
}

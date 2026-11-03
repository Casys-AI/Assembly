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
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
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
export const RDF_QUADS_PROJECTOR_VERSION = "ase-rdf-quads-v2";

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

/** Canonical Toolkit property name → reversible predicate IRI. */
export function propPredicate(property: string): string {
  return `urn:ase:vocab:prop:${encodeIriSegment(property)}`;
}
export function listPredicate(property: string): string {
  return `urn:ase:vocab:list:${encodeIriSegment(property)}`;
}
export function metaclassIri(metaclass: string): string {
  return `urn:ase:metaclass:${encodeIriSegment(metaclass)}`;
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
/** Blank-node-safe, injective segment encoding (`_` introduces escapes). */
function blankSegment(value: string): string {
  let out = "";
  for (const byte of utf8.encode(value)) {
    const char = String.fromCharCode(byte);
    out += /^[A-Za-z0-9-]$/.test(char)
      ? char
      : `_x${byte.toString(16).toUpperCase().padStart(2, "0")}_`;
  }
  return out;
}
/** Length-frame the escaped segments: `_` also occurs inside an escape,
 * so it cannot by itself separate paths such as ["a_b"] and ["a","x5F","b"]. */
const blankLabel = (path: readonly string[]): string =>
  `b${
    path.map((segment) => {
      const encoded = blankSegment(segment);
      return `_${encoded.length}_${encoded}`;
    }).join("")
  }`;

// --- Projection core ---

interface ProjectionContext {
  readonly repositoryId: string;
  readonly libraryIds: ReadonlySet<string>;
  readonly graph: string;
  readonly lines: string[];
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
    const term = blankTerm(blankLabel(path));
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
  const list = blankTerm(blankLabel(path));
  quad(context, list, ASE_VOCAB.rdfType, iriTerm(ASE_VOCAB.occurrenceList));
  quad(
    context,
    list,
    ASE_VOCAB.length,
    literalTerm(String(items.length), XSD.integer),
  );
  items.forEach((item, index) => {
    const occurrence = blankTerm(blankLabel([...path, `#${index}`]));
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
}

export interface ModelProjectionInput {
  readonly build: BuildRef;
  readonly elements: readonly JsonObject[];
  readonly libraryNativeIds: readonly string[];
}

/** Sorted canonical N-Quads for one verified build. Pure and synchronous
 * so tests and tools can pin the exact bytes. */
export function projectModelToNQuads(input: ModelProjectionInput): {
  readonly nquads: string;
  readonly quadCount: number;
} {
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
  const lines = [...new Set(context.lines)].sort(compareCodeUnits);
  return {
    nquads: lines.length ? `${lines.join("\n")}\n` : "",
    quadCount: lines.length,
  };
}

/** W2 projection keyed by kind, contextual version and A. The contextual
 * version hashes repository scope and verified library classification. */
export class DeterministicRdfModelProjector implements ModelRdfProjector {
  readonly kind = RDF_QUADS_KIND;
  readonly projectorVersion = RDF_QUADS_PROJECTOR_VERSION;

  async project(input: ModelProjectionInput) {
    const { nquads, quadCount } = projectModelToNQuads(input);
    const projectionDigest = await sha256(nquads);
    return {
      quads: utf8.encode(nquads),
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

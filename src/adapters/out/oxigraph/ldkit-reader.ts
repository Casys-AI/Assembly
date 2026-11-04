/** Typed LDkit 2.10.1 reads over a build-pinned, bounded semantic index.
 * The actual LDkit lens uses our IQueryEngine implementation. Every query
 * goes to ModelSemanticIndex.queryReadOnly; edits go through the writer.
 * RDFJS terms come from LDkit's public data model exports, while $id values
 * become BuildElementRef only through the verified identity codec.
 */
import { Readable } from "node:stream";
import { DataFactory as LdDataFactory, type RDF } from "ldkit/rdf";
import {
  type IQueryEngine,
  type Lens,
  type QueryContext,
  type Schema,
  type SchemaInterface,
} from "ldkit";
import {
  buildElementIri,
  buildElementRefFromIri,
  decodeIriSegment,
  encodeIriSegment,
} from "./iri.ts";
import {
  type BuildElementRef,
  type BuildRef,
  type ElementIriScope,
  parseBuildRef,
  sameBuildRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  DEFAULT_QUERY_LIMITS,
  MAX_QUERY_BYTES,
  type ModelSemanticIndex,
  SemanticIndexError,
} from "../../../application/model/semantic/index-service.ts";
import type {
  RdfQuadDto,
  RdfTermDto,
  SemanticQueryLimits,
} from "../../../application/model/semantic/queries/inputs.ts";
import {
  ASE_PROPERTY_VOCAB,
  ASE_VOCAB,
  escapeNQuadsLiteral,
  listPredicate,
  metaclassIri,
  propPredicate,
  SYSML_VOCAB,
} from "./rdf.ts";

/** Pinned library used for its factory and RDFJS data model. */
export const LDKIT_MODULE_SPECIFIER = "npm:ldkit@2.10.1";
export const LDKIT_READER_VERSION = "ase-ldkit-reader-v1";

/** Versioned query context: the build pins the dataset, limits bound the
 * work. Carried through the engine into `queryReadOnly`. */
export interface ModelReaderContext {
  readonly v: 1;
  readonly readerVersion: typeof LDKIT_READER_VERSION;
  readonly build: BuildRef;
  readonly limits?: Partial<SemanticQueryLimits>;
}

export function modelReaderContext(
  build: BuildRef,
  limits?: Partial<SemanticQueryLimits>,
): ModelReaderContext {
  return Object.freeze({
    v: 1 as const,
    readerVersion: LDKIT_READER_VERSION,
    build: parseBuildRef(build),
    ...(limits ? { limits } : {}),
  });
}

// --- RDFJS terms from the same data factory used by pinned LDkit ---

export type RdfJsDataFactory = LdDataFactory;
export type RdfJsNamedNode = RDF.NamedNode;
export type RdfJsBlankNode = RDF.BlankNode;
export type RdfJsLiteral = RDF.Literal;
export type RdfJsVariable = RDF.Variable;
export type RdfJsDefaultGraph = ReturnType<LdDataFactory["defaultGraph"]>;
export type RdfJsTerm =
  | RDF.NamedNode
  | RDF.BlankNode
  | RDF.Literal
  | RDF.Variable
  | RdfJsDefaultGraph;
export type RdfJsQuad = ReturnType<LdDataFactory["quad"]>;
export const dataFactory = Object.freeze(new LdDataFactory());

export function termFromDto(
  dto: RdfTermDto,
): RDF.NamedNode | RDF.BlankNode | RDF.Literal {
  switch (dto.kind) {
    case "iri":
      return dataFactory.namedNode(dto.value);
    case "blank":
      return dataFactory.blankNode(dto.value);
    case "literal":
      return dataFactory.literal(
        dto.value,
        dto.language ?? dataFactory.namedNode(dto.datatype),
      );
  }
}
export function quadFromDto(dto: RdfQuadDto): RdfJsQuad {
  const subject = termFromDto(dto.subject);
  if (subject.termType !== "NamedNode" && subject.termType !== "BlankNode") {
    throw new Error("Invalid RDF subject");
  }
  return dataFactory.quad(
    subject,
    dataFactory.namedNode(dto.predicate),
    termFromDto(dto.object),
    dto.graph ? dataFactory.namedNode(dto.graph) : undefined,
  );
}

/** Map-backed bindings with the read surface LDkit/Comunica consume. */
export class SimpleBindings implements RDF.Bindings {
  readonly type = "bindings";
  constructor(private readonly terms: ReadonlyMap<string, RdfJsTerm>) {}
  get(key: string | RDF.Variable): RdfJsTerm | undefined {
    return this.terms.get(typeof key === "string" ? key : key.value);
  }
  has(key: string | RDF.Variable): boolean {
    return this.terms.has(typeof key === "string" ? key : key.value);
  }
  keys(): Iterable<RDF.Variable> {
    return [...this.terms.keys()].map((key) => dataFactory.variable(key));
  }
  values(): Iterable<RdfJsTerm> {
    return this.terms.values();
  }
  get size(): number {
    return this.terms.size;
  }
  *[Symbol.iterator](): IterableIterator<[RDF.Variable, RdfJsTerm]> {
    for (const [key, value] of this.terms) {
      yield [dataFactory.variable(key), value];
    }
  }
  forEach(fn: (value: RDF.Term, key: RDF.Variable) => unknown): void {
    for (const [key, value] of this) fn(value, key);
  }
  set(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  delete(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  filter(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  map(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  merge(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  mergeWith(): RDF.Bindings {
    throw new Error("Bindings are readonly");
  }
  equals(other: RDF.Bindings | null | undefined): boolean {
    return !!other && this.size === other.size &&
      [...this].every(([key, value]) => value.equals(other.get(key)));
  }
}

// --- Read-only engine over the semantic index port ---
//
// Two surfaces, both read-only: StringSparqlQueryable-style methods for
// direct callers, and the RDFJS `Source` surface (`match`/`countQuads`)
// that Comunica (inside LDkit) resolves quad patterns against.

type PatternTerm = RdfJsTerm | undefined;

function patternTermSparql(
  term: PatternTerm,
  variable: string,
): string {
  if (!term || term.termType === "Variable") return `?${variable}`;
  switch (term.termType) {
    case "NamedNode":
      if (/[<>\s"]/.test(term.value)) {
        throw new SemanticIndexError(
          "INDEX_INVALID_INPUT",
          { reason: "Unsafe IRI in quad pattern" },
          "Unsafe IRI in quad pattern",
        );
      }
      return `<${term.value}>`;
    case "BlankNode":
      return `_:${term.value}`;
    case "Literal": {
      const lexical = `"${escapeNQuadsLiteral(term.value)}"`;
      return term.language
        ? `${lexical}@${term.language}`
        : `${lexical}^^<${term.datatype.value}>`;
    }
    case "DefaultGraph":
      return `?${variable}`;
  }
}

export class SemanticIndexQueryEngine implements IQueryEngine {
  constructor(
    private readonly index: ModelSemanticIndex,
    private readonly defaultContext?: ModelReaderContext,
  ) {}

  #contextOrThrow(): ModelReaderContext {
    if (!this.defaultContext) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: "Quad-pattern access requires a bound reader context" },
        "Engine has no bound build context",
      );
    }
    return this.defaultContext;
  }

  async #patternQuads(
    subject: PatternTerm,
    predicate: PatternTerm,
    object: PatternTerm,
  ): Promise<RdfJsQuad[]> {
    const context = this.#contextOrThrow();
    const sparql = `SELECT ?s ?p ?o WHERE { ${
      patternTermSparql(subject, "s")
    } ${patternTermSparql(predicate, "p")} ${
      patternTermSparql(object, "o")
    } . }`;
    const result = await this.index.queryReadOnly({
      build: context.build,
      sparql,
      limits: context.limits,
    });
    if (result.form !== "solutions") {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: `Expected SELECT solutions, got ${result.form}` },
        "Quad-pattern query requires a SELECT result",
      );
    }
    if (result.truncated) {
      throw new SemanticIndexError(
        "INDEX_QUERY_LIMIT",
        {},
        "Quad source requires a complete result; narrow the query",
      );
    }
    const bound = (
      term: PatternTerm,
      variable: string,
      row: Readonly<Record<string, RdfTermDto>>,
    ): RdfJsTerm | undefined =>
      term && term.termType !== "Variable"
        ? term
        : row[variable]
        ? termFromDto(row[variable])
        : undefined;
    const quads: RdfJsQuad[] = [];
    for (const row of result.rows) {
      const s = bound(subject, "s", row);
      const p = bound(predicate, "p", row);
      const o = bound(object, "o", row);
      if (
        s && p && o &&
        (s.termType === "NamedNode" || s.termType === "BlankNode") &&
        p.termType === "NamedNode" && o.termType !== "DefaultGraph"
      ) quads.push(dataFactory.quad(s, p, o));
    }
    return quads;
  }

  /** RDFJS Source surface for Comunica: a Node stream of matching quads.
   * The graph term is ignored — the index port is already pinned to the
   * bound build's named graph. */
  match(
    subject?: PatternTerm,
    predicate?: PatternTerm,
    object?: PatternTerm,
    _graph?: PatternTerm,
  ): Readable {
    const quads = this.#patternQuads(subject, predicate, object);
    async function* generate() {
      for (const quad of await quads) yield quad;
    }
    return Readable.from(generate(), { objectMode: true });
  }

  async countQuads(
    subject?: PatternTerm,
    predicate?: PatternTerm,
    object?: PatternTerm,
    _graph?: PatternTerm,
  ): Promise<number> {
    return (await this.#patternQuads(subject, predicate, object)).length;
  }

  async queryBindings(
    sparql: string,
    suppliedContext?: QueryContext | ModelReaderContext,
  ): Promise<Readable> {
    const context = this.defaultContext ??
      (suppliedContext && "build" in suppliedContext
        ? suppliedContext
        : undefined);
    if (!context) throw new Error("Query engine requires a bound build");
    const result = await this.index.queryReadOnly({
      build: context.build,
      sparql,
      limits: context.limits,
    });
    if (result.form !== "solutions") {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: `Expected SELECT solutions, got ${result.form}` },
        "queryBindings requires a SELECT query",
      );
    }
    if (result.truncated) {
      throw new SemanticIndexError(
        "INDEX_QUERY_LIMIT",
        {},
        "Typed reads require a complete result; narrow the query",
      );
    }
    const rows = result.rows;
    async function* generate(): AsyncGenerator<SimpleBindings> {
      for (const row of rows) {
        yield new SimpleBindings(
          new Map(
            Object.entries(row).map(([key, dto]) => [key, termFromDto(dto)]),
          ),
        );
      }
    }
    return Readable.from(generate(), { objectMode: true });
  }

  async queryBoolean(
    sparql: string,
    suppliedContext?: QueryContext | ModelReaderContext,
  ): Promise<boolean> {
    const context = this.defaultContext ??
      (suppliedContext && "build" in suppliedContext
        ? suppliedContext
        : undefined);
    if (!context) throw new Error("Query engine requires a bound build");
    const result = await this.index.queryReadOnly({
      build: context.build,
      sparql,
      limits: context.limits,
    });
    if (result.form !== "boolean") {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: `Expected ASK result, got ${result.form}` },
        "queryBoolean requires an ASK query",
      );
    }
    return result.value;
  }

  async queryQuads(
    sparql: string,
    suppliedContext?: QueryContext | ModelReaderContext,
  ): Promise<Readable> {
    const context = this.defaultContext ??
      (suppliedContext && "build" in suppliedContext
        ? suppliedContext
        : undefined);
    if (!context) throw new Error("Query engine requires a bound build");
    const result = await this.index.queryReadOnly({
      build: context.build,
      sparql,
      limits: context.limits,
    });
    if (result.form !== "graph") {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: `Expected graph result, got ${result.form}` },
        "queryQuads requires a CONSTRUCT or DESCRIBE query",
      );
    }
    if (result.truncated) {
      throw new SemanticIndexError(
        "INDEX_QUERY_LIMIT",
        {},
        "Typed reads require a complete graph; narrow the query",
      );
    }
    const quads = result.quads;
    async function* generate(): AsyncGenerator<RdfJsQuad> {
      for (const quad of quads) yield quadFromDto(quad);
    }
    return Readable.from(generate(), { objectMode: true });
  }

  /** Updates do not exist on this engine, by design. */
  queryVoid(): Promise<void> {
    return Promise.reject(
      new SemanticIndexError(
        "INDEX_QUERY_REFUSED",
        { reason: "The semantic index is read-only" },
        "SPARQL updates are refused; edits go through the writer",
      ),
    );
  }
}

// --- LDkit schemas (canonical Toolkit names stay primary) ---

// LDkit 2.10.1 typed properties use prefixed datatype names
// (`SupportedDataTypes` keys), not full datatype IRIs.
const xsdString = "xsd:string";
const optionalString = (iri: string) => ({
  "@id": iri,
  "@type": xsdString,
  "@optional": true,
} as const);

/** LDkit schema for one Toolkit metaclass. Field names are the reader's
 * public names; every `@id` keeps the canonical projected predicate. */
export function modelElementSchema(metaclass: string) {
  return {
    "@type": metaclassIri(metaclass),
    nativeId: { "@id": ASE_VOCAB.nativeId, "@type": xsdString },
    metaclass: { "@id": ASE_VOCAB.metaclass, "@type": xsdString },
    declaredName: optionalString(propPredicate("declaredName")),
    name: optionalString(ASE_VOCAB.name),
    qualifiedName: optionalString(ASE_VOCAB.qualifiedName),
    owner: { "@id": propPredicate("owner"), "@optional": true },
    ownedMember: {
      "@id": propPredicate("ownedMember"),
      "@array": true,
      "@optional": true,
    },
  } as const;
}

export const PackageSchema = modelElementSchema("Package");
export const PartUsageSchema = modelElementSchema("PartUsage");
export const PartDefinitionSchema = modelElementSchema("PartDefinition");

/** What a lens over `modelElementSchema` yields per element. */
/** LDkit optional scalar fields are present with null when absent.
 * ownedMember is a set of direct RDF edges; use orderedMembers for
 * occurrence order and duplicate entries. */
export type LdkModelElement = SchemaInterface<typeof PackageSchema>;

/** Read-only lens facade over a real LDkit resource. The underlying
 * resource's insert/update/delete methods are never exposed here. */
export interface ReadonlyLdkitLens<E extends { readonly $id: string }> {
  readonly build: BuildRef;
  find(limit?: number): Promise<readonly E[]>;
  findByIri(iri: string): Promise<E | undefined>;
  findByIris(iris: readonly string[]): Promise<readonly E[]>;
  count(): Promise<number>;
  /** Verified `$id` → identity conversion for this lens's build. */
  refOf(entityOrIri: E | string): {
    readonly ref: BuildElementRef;
    readonly scope: ElementIriScope;
  };
  refsOf(entities: readonly E[]): readonly {
    readonly ref: BuildElementRef;
    readonly scope: ElementIriScope;
  }[];
}

/** Construct the actual LDkit 2.10.1 lens with our typed readonly engine.
 * Its SPARQL runs directly against the pinned native index port. */
export async function createLdkitLens<T extends Schema>(
  schema: T,
  options: {
    readonly index: ModelSemanticIndex;
    readonly build: BuildRef;
    readonly limits?: Partial<SemanticQueryLimits>;
  },
): Promise<ReadonlyLdkitLens<Awaited<ReturnType<Lens<T>["find"]>>[number]>> {
  const build = parseBuildRef(options.build);
  const { createLens: createNativeLdkitLens } = await import("ldkit");
  const engine = new SemanticIndexQueryEngine(
    options.index,
    modelReaderContext(build, options.limits),
  );
  const resource = createNativeLdkitLens(schema, {
    engine,
    sources: [`urn:ase:build:${build.artifactDigest}`],
  });
  type E = Awaited<ReturnType<Lens<T>["find"]>>[number];
  const refOf = (entityOrIri: E | string) =>
    buildElementRefFromIri(
      build,
      typeof entityOrIri === "string" ? entityOrIri : entityOrIri.$id,
    );
  return Object.freeze({
    build,
    find: (limit?: number) =>
      resource.find(limit === undefined ? undefined : { take: limit }),
    findByIri: async (iri: string) => {
      refOf(iri);
      return (await resource.findByIri(iri)) ?? undefined;
    },
    findByIris: async (iris: readonly string[]) => {
      for (const iri of iris) refOf(iri);
      return await resource.findByIris([...iris]);
    },
    count: () => resource.count(),
    refOf,
    refsOf: (entities: readonly E[]) => Object.freeze(entities.map(refOf)),
  });
}

/** Coordinator raccord: name used by the semantic-index integration
 * suite for the same real lens. */
export const createModelLens = createLdkitLens;

// --- Typed reader bound to one build ---

export interface ModelElementView {
  readonly ref: BuildElementRef;
  readonly scope: ElementIriScope;
  readonly $id: string;
  readonly nativeId: string;
  readonly metaclass: string;
  readonly name?: string;
  readonly qualifiedName?: string;
}

export interface ModelNeighbor {
  readonly direction: "out" | "in";
  /** Canonical Toolkit property name (decoded from the predicate). */
  readonly property: string;
  readonly predicate: string;
  readonly otherIri: string;
  readonly occurrence?: string;
  readonly position?: number;
  readonly other?: {
    readonly ref: BuildElementRef;
    readonly scope: ElementIriScope;
  };
}

export interface ModelNeighborPage {
  readonly items: readonly ModelNeighbor[];
  readonly limit: number;
  /** False only when lookahead finds more matches or native bounds truncate. */
  readonly complete: boolean;
  readonly nativeTruncated?: boolean;
  readonly nextOffset?: number;
}

const PREFIXES =
  `PREFIX ase: <${ASE_VOCAB.base}> PREFIX prop: <https://www.omg.org/spec/SysML#> `;

function literalOf(
  row: Readonly<Record<string, RdfTermDto>>,
  variable: string,
): string | undefined {
  const term = row[variable];
  return term?.kind === "literal" ? term.value : undefined;
}
function iriOf(
  row: Readonly<Record<string, RdfTermDto>>,
  variable: string,
): string | undefined {
  const term = row[variable];
  return term?.kind === "iri" ? term.value : undefined;
}

export class BoundModelReader {
  constructor(
    private readonly index: ModelSemanticIndex,
    private readonly build: BuildRef,
    private readonly limits?: Partial<SemanticQueryLimits>,
  ) {}

  get boundBuild(): BuildRef {
    return this.build;
  }

  /** Load the projection natively; required before any lookup. */
  ensure() {
    return this.index.ensureProjection(this.build);
  }

  /** Verified `$id` → ref conversion for this reader's build. */
  refFromIri(iri: string): {
    readonly ref: BuildElementRef;
    readonly scope: ElementIriScope;
  } {
    return buildElementRefFromIri(this.build, iri);
  }

  iriOf(ref: BuildElementRef, scope: ElementIriScope = "user"): string {
    if (!sameBuildRef(ref.build, this.build)) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        {},
        "Target belongs to another build",
      );
    }
    return buildElementIri(ref, scope);
  }

  #verifiedRowRef(iri: string, nativeId: string) {
    const decoded = this.refFromIri(iri);
    if (decoded.ref.nativeId !== nativeId) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        {},
        "Element IRI disagrees with nativeId",
      );
    }
    return decoded;
  }

  async #select(
    sparql: string,
    maxResults?: number,
  ): Promise<readonly Readonly<Record<string, RdfTermDto>>[]> {
    const result = await this.index.queryReadOnly({
      build: this.build,
      sparql,
      limits: { ...this.limits, ...(maxResults ? { maxResults } : {}) },
    });
    if (result.form !== "solutions") {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        { reason: `Expected solutions, got ${result.form}` },
        "Semantic index answered an unexpected form",
      );
    }
    if (result.truncated) {
      throw new SemanticIndexError(
        "INDEX_QUERY_LIMIT",
        {},
        "Typed reads require a complete result; narrow the query",
      );
    }
    return result.rows;
  }

  async getElement(
    target: BuildElementRef | string,
    scope: ElementIriScope = "user",
  ): Promise<ModelElementView | undefined> {
    const nativeId = typeof target === "string" ? target : target.nativeId;
    const ref: BuildElementRef = typeof target === "string"
      ? { build: this.build, nativeId }
      : target;
    const iri = this.iriOf(ref, scope);
    const decoded = this.#verifiedRowRef(iri, nativeId);
    const rows = await this.#select(
      `${PREFIXES}SELECT ?metaclass ?name ?qualifiedName WHERE { ` +
        `<${iri}> ase:metaclass ?metaclass . ` +
        `OPTIONAL { <${iri}> ase:name ?name } ` +
        `OPTIONAL { <${iri}> ase:qualifiedName ?qualifiedName } }`,
      2,
    );
    const row = rows[0];
    if (!row) return undefined;
    return Object.freeze({
      ref: decoded.ref,
      scope: decoded.scope,
      $id: iri,
      nativeId,
      metaclass: literalOf(row, "metaclass") ?? "",
      ...(literalOf(row, "name") !== undefined
        ? { name: literalOf(row, "name") as string }
        : {}),
      ...(literalOf(row, "qualifiedName") !== undefined
        ? { qualifiedName: literalOf(row, "qualifiedName") as string }
        : {}),
    });
  }

  /** Lookup straight from an LDkit `$id`, repository verified. */
  async getByIri(iri: string): Promise<ModelElementView | undefined> {
    const { ref, scope } = this.refFromIri(iri);
    return await this.getElement(ref, scope);
  }

  async elementsByMetaclass(
    metaclass: string,
    limit = 200,
  ): Promise<readonly ModelElementView[]> {
    const rows = await this.#select(
      `${PREFIXES}SELECT ?element ?nativeId ?name ?qualifiedName WHERE { ` +
        `?element a <${metaclassIri(metaclass)}> ; ase:nativeId ?nativeId . ` +
        `OPTIONAL { ?element ase:name ?name } ` +
        `OPTIONAL { ?element ase:qualifiedName ?qualifiedName } } ` +
        `ORDER BY ?nativeId`,
      limit,
    );
    return rows.flatMap((row) => {
      const iri = iriOf(row, "element");
      const nativeId = literalOf(row, "nativeId");
      if (!iri || nativeId === undefined) return [];
      const decoded = this.#verifiedRowRef(iri, nativeId);
      return [Object.freeze({
        ref: decoded.ref,
        scope: decoded.scope,
        $id: iri,
        nativeId,
        metaclass,
        ...(literalOf(row, "name") !== undefined
          ? { name: literalOf(row, "name") as string }
          : {}),
        ...(literalOf(row, "qualifiedName") !== undefined
          ? { qualifiedName: literalOf(row, "qualifiedName") as string }
          : {}),
      })];
    });
  }

  /** Occurrences preserve list order and repeated endpoints. A lookahead row
   * proves continuation; native truncation is reported independently. */
  async neighborsPage(
    target: BuildElementRef,
    options: {
      readonly direction?: "out" | "in" | "both";
      readonly property?: string;
      readonly scope?: ElementIriScope;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): Promise<ModelNeighborPage> {
    const iri = this.iriOf(target, options.scope ?? "user");
    const direction = options.direction ?? "out";
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 ||
      !["out", "in", "both"].includes(direction) ||
      options.property !== undefined &&
        (typeof options.property !== "string" || !options.property.trim() ||
          options.property.length > 512)
    ) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        {},
        "Invalid neighbor selectors or page bounds",
      );
    }
    const userPrefix = `urn:ase:model:${
      encodeIriSegment(this.build.repositoryId)
    }:`;
    const canonicalFilters =
      `FILTER EXISTS { ?other ase:nativeId ?neighborNativeId } ` +
      `FILTER(isIRI(?other) && ?other != <${ASE_VOCAB.nullValue}> && ` +
      `(STRSTARTS(STR(?other), "${userPrefix}") || STRSTARTS(STR(?other), "urn:ase:library:")) && ` +
      `(STRSTARTS(STR(?p), "${SYSML_VOCAB}") || STRSTARTS(STR(?p), "${ASE_PROPERTY_VOCAB}")))`;
    const branch = (dir: "out" | "in") => {
      const source = dir === "out" ? `<${iri}>` : "?other";
      const value = dir === "out" ? "?other" : `<${iri}>`;
      const property = options.property;
      const listBinding = property
        ? `BIND(<${propPredicate(property)}> AS ?p)`
        : `FILTER(STRSTARTS(STR(?listProperty), "urn:ase:vocab:list:")) ` +
          `BIND(STRAFTER(STR(?listProperty), "urn:ase:vocab:list:") AS ?propertySuffix) ` +
          `BIND(IRI(CONCAT(IF(STRSTARTS(?propertySuffix, "sysx%3A"), "${ASE_PROPERTY_VOCAB}", "${SYSML_VOCAB}"), ?propertySuffix)) AS ?p)`;
      const direct = property ? `<${propPredicate(property)}>` : "?p";
      const absentList = property
        ? `FILTER NOT EXISTS { ${source} <${
          listPredicate(property)
        }> ?existingList }`
        : `FILTER(isIRI(?other) && (STRSTARTS(STR(?p), "${SYSML_VOCAB}") || STRSTARTS(STR(?p), "${ASE_PROPERTY_VOCAB}"))) ` +
          `BIND(IF(STRSTARTS(STR(?p), "${SYSML_VOCAB}"), STRAFTER(STR(?p), "${SYSML_VOCAB}"), STRAFTER(STR(?p), "${ASE_PROPERTY_VOCAB}")) AS ?propertySuffix) ` +
          `BIND(IRI(CONCAT("urn:ase:vocab:list:", ?propertySuffix)) AS ?existingListProperty) ` +
          `FILTER NOT EXISTS { ${source} ?existingListProperty ?existingList }`;
      // A named reverse property can use its direct edge as an anchor.
      // For the unfiltered reverse page, derive p from each matching list
      // instead of joining every incoming property to every source list.
      const anchor = dir === "in" && property
        ? `${source} ${direct} ${value} . `
        : "";
      // Hoisting the shared filters/BIND above UNION makes the native plan
      // expand on dense system roots; keep each arm independently selective.
      return `{ BIND("${dir}" AS ?direction) ${anchor}${source} ${
        property ? `<${listPredicate(property)}>` : "?listProperty"
      } ?list . ` +
        `?list ase:occurrence ?occurrence . ?occurrence ase:index ?index ; ase:value ${value} . ` +
        `${listBinding} ${canonicalFilters} } UNION ` +
        `{ BIND("${dir}" AS ?direction) ${source} ${direct} ${value} . ${
          property ? `BIND(${direct} AS ?p)` : ""
        } ${absentList} ${canonicalFilters} }`;
    };
    const branches = direction === "both"
      ? `{ ${branch("out")} } UNION { ${branch("in")} }`
      : branch(direction);
    const sparql =
      `${PREFIXES}SELECT ?direction ?p ?other ?index ?occurrence WHERE { ` +
      `${branches} } ` +
      `ORDER BY ?direction ?p ?index ?other ?occurrence OFFSET ${offset} LIMIT ${
        limit + 1
      }`;
    const result = await this.index.queryReadOnly({
      build: this.build,
      sparql,
      limits: { ...this.limits, maxResults: limit + 1 },
    });
    if (result.form !== "solutions") {
      throw new SemanticIndexError(
        "INDEX_UNAVAILABLE",
        {},
        "Neighbor query expected SELECT solutions",
      );
    }
    const items = result.rows.slice(0, limit).map((row): ModelNeighbor => {
      const predicate = iriOf(row, "p");
      const otherIri = iriOf(row, "other");
      const propertyPrefix = predicate?.startsWith(SYSML_VOCAB)
        ? SYSML_VOCAB
        : predicate?.startsWith(ASE_PROPERTY_VOCAB)
        ? ASE_PROPERTY_VOCAB
        : undefined;
      if (!predicate || !propertyPrefix || !otherIri) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          {},
          "Invalid neighbor row",
        );
      }
      const other = this.refFromIri(otherIri);
      const occurrence = row.occurrence?.value;
      const position = row.index?.kind === "literal"
        ? Number(row.index.value)
        : undefined;
      return Object.freeze({
        direction: literalOf(row, "direction") === "in"
          ? "in"
          : direction === "in"
          ? "in"
          : "out",
        property: decodeIriSegment(
          predicate.slice(propertyPrefix.length),
        ),
        predicate,
        otherIri,
        other,
        ...(occurrence ? { occurrence } : {}),
        ...(position !== undefined && Number.isSafeInteger(position)
          ? { position }
          : {}),
      });
    });
    // Keep identity joins out of the ordered discovery query: on dense roots
    // they expand before LIMIT. Verify only the returned endpoints, in VALUES
    // batches bounded independently by query bytes, result bytes and row count.
    const expectedIds = new Map(
      items.map((item) => [item.otherIri, item.other!.ref.nativeId]),
    );
    const identityHead =
      `${PREFIXES}SELECT ?other ?neighborNativeId WHERE { VALUES ?other { `;
    const identityTail = ` } ?other ase:nativeId ?neighborNativeId . }`;
    const encoder = new TextEncoder();
    const envelopeBytes = encoder.encode(
      JSON.stringify({
        form: "solutions",
        variables: ["other", "neighborNativeId"],
        rows: [],
        truncated: false,
      }),
    ).length;
    const baseQueryBytes = encoder.encode(identityHead + identityTail).length;
    const maxIdentityBytes = this.limits?.maxBytes ??
      DEFAULT_QUERY_LIMITS.maxBytes;
    let batch: Array<[string, string]> = [];
    let queryBytes = baseQueryBytes;
    let resultBytes = envelopeBytes;
    const verifyBatch = async () => {
      if (!batch.length) return;
      const expected = new Map(batch);
      const seen = new Set<string>();
      const rows = await this.#select(
        identityHead + batch.map(([iri]) => `<${iri}>`).join(" ") +
          identityTail,
        batch.length + 1,
      );
      for (const row of rows) {
        const iri = iriOf(row, "other");
        const id = literalOf(row, "neighborNativeId");
        if (
          !iri || !expected.has(iri) || id !== expected.get(iri) ||
          seen.has(iri)
        ) {
          throw new SemanticIndexError(
            "INDEX_PROJECTION_CORRUPT",
            {},
            "Neighbor IRI disagrees with nativeId or has ambiguous identity",
          );
        }
        seen.add(iri);
      }
      if (seen.size !== expected.size) {
        throw new SemanticIndexError(
          "INDEX_PROJECTION_CORRUPT",
          {},
          "Neighbor identity is missing from the pinned index",
        );
      }
      batch = [];
      queryBytes = baseQueryBytes;
      resultBytes = envelopeBytes;
    };
    for (const [iri, nativeId] of expectedIds) {
      const termBytes = encoder.encode(`<${iri}> `).length;
      const rowBytes = encoder.encode(
        JSON.stringify({
          other: { kind: "iri", value: iri },
          neighborNativeId: {
            kind: "literal",
            value: nativeId,
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
        }),
      ).length + 1;
      if (
        batch.length &&
        (batch.length >= 50 || queryBytes + termBytes > MAX_QUERY_BYTES ||
          resultBytes + rowBytes > maxIdentityBytes)
      ) {
        await verifyBatch();
      }
      if (
        queryBytes + termBytes > MAX_QUERY_BYTES ||
        resultBytes + rowBytes > maxIdentityBytes
      ) {
        throw new SemanticIndexError(
          "INDEX_QUERY_LIMIT",
          {},
          "Neighbor identity exceeds the bounded query or result byte budget",
        );
      }
      batch.push([iri, nativeId]);
      queryBytes += termBytes;
      resultBytes += rowBytes;
    }
    await verifyBatch();
    const more = result.rows.length > limit;
    // Do not advertise an empty retry loop when a single row exceeds native bounds.
    const nextOffset = (more || result.truncated) && items.length > 0
      ? offset + items.length
      : undefined;
    return Object.freeze({
      items: Object.freeze(items),
      limit,
      complete: !more && !result.truncated,
      nativeTruncated: result.truncated,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    });
  }

  /** Compatibility array view of bounded discovery. Use neighborsPage
   * when the consumer needs the explicit completeness indicator. */
  async neighbors(
    target: BuildElementRef,
    options: Parameters<BoundModelReader["neighborsPage"]>[1] = {},
  ): Promise<readonly ModelNeighbor[]> {
    return (await this.neighborsPage(target, options)).items;
  }

  /** Ordered members of one list property, duplicates included. */
  async orderedMembers(
    target: BuildElementRef,
    property: string,
    scope: ElementIriScope = "user",
  ): Promise<readonly string[]> {
    const iri = this.iriOf(target, scope);
    const rows = await this.#select(
      `${PREFIXES}SELECT ?value WHERE { ` +
        `<${iri}> <${listPredicate(property)}> ?list . ` +
        `?list ase:occurrence ?occurrence . ` +
        `?occurrence ase:index ?index ; ase:value ?value . ` +
        `FILTER(isIRI(?value)) } ORDER BY ?index`,
    );
    return rows.flatMap((row) => {
      const value = iriOf(row, "value");
      return value && value !== ASE_VOCAB.nullValue ? [value] : [];
    });
  }

  /** Concrete transversal query: every element, of any metaclass,
   * reachable from a root through `ownedMember` (the containment tree),
   * with names — the shape agent tools need to walk a model. */
  async descendantsOf(
    root: BuildElementRef,
    options: { readonly scope?: ElementIriScope; readonly limit?: number } = {},
  ): Promise<readonly ModelElementView[]> {
    const iri = this.iriOf(root, options.scope ?? "user");
    const rows = await this.#select(
      `${PREFIXES}SELECT DISTINCT ?element ?nativeId ?metaclass ?name WHERE { ` +
        `<${iri}> prop:ownedMember+ ?element . ` +
        `?element ase:nativeId ?nativeId ; ase:metaclass ?metaclass . ` +
        `OPTIONAL { ?element ase:name ?name } } ORDER BY ?nativeId`,
      options.limit ?? 500,
    );
    return rows.flatMap((row) => {
      const elementIri = iriOf(row, "element");
      const nativeId = literalOf(row, "nativeId");
      if (!elementIri || nativeId === undefined) return [];
      const decoded = this.#verifiedRowRef(elementIri, nativeId);
      return [Object.freeze({
        ref: decoded.ref,
        scope: decoded.scope,
        $id: elementIri,
        nativeId,
        metaclass: literalOf(row, "metaclass") ?? "",
        ...(literalOf(row, "name") !== undefined
          ? { name: literalOf(row, "name") as string }
          : {}),
      })];
    });
  }

  async referencesToPage(
    target: BuildElementRef,
    options: Omit<
      NonNullable<Parameters<BoundModelReader["neighborsPage"]>[1]>,
      "direction"
    > = {},
  ): Promise<ModelNeighborPage> {
    return await this.neighborsPage(target, { ...options, direction: "in" });
  }

  /** Cross-cutting reverse lookup: who points at this element, through
   * which canonical property — regardless of metaclass. */
  async referencesTo(
    target: BuildElementRef,
    options: { readonly scope?: ElementIriScope; readonly limit?: number } = {},
  ): Promise<readonly ModelNeighbor[]> {
    return await this.neighbors(target, {
      direction: "in",
      scope: options.scope,
      limit: options.limit,
    });
  }

  /** Escape hatch for one bounded read-only SPARQL string, still pinned
   * to this build and still admitted twice (TS + native AST). */
  query(sparql: string) {
    if (typeof sparql !== "string" || !sparql.trim()) {
      throw new SemanticIndexError(
        "INDEX_INVALID_INPUT",
        { reason: "Empty SPARQL query" },
        "Empty SPARQL query",
      );
    }
    return this.index.queryReadOnly({
      build: this.build,
      sparql,
      limits: this.limits,
    });
  }
}

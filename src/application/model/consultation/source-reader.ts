import {
  requireModelContext,
  utf8SourceSpan,
} from "../../../domain/model/value-objects/source-span.ts";
import { compareCodeUnits as compare } from "../../../domain/primitives/canonical-json.ts";
import {
  type ModelContextElement,
  type ModelContextInspection,
  type ModelContextOverview,
  type ModelContextQuery,
  type ModelContextQueryResult,
  type ModelContextRelation,
  type ModelSourceRange,
} from "../../../domain/model/consultation/context.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";

type ObjectValue = Record<string, unknown>;
type ModelContextRepository = Pick<
  ModelRepositoryPort,
  "current" | "at"
>;
interface ModelContextReaderOptions {
  maxCachedVersions?: number;
  maxSourceBytes?: number;
  maxInspectSourceBytes?: number;
}

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const encoder = new TextEncoder();
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const ref = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  return value && typeof value === "object"
    ? string((value as ObjectValue)["@id"])
    : undefined;
};

function version(value: unknown): asserts value is string {
  requireModelContext(
    typeof value === "string" &&
      /^(?:branch|commit):[A-Za-z0-9_-]{1,120}$/.test(value),
    "INVALID_REQUEST",
    "An immutable model version is required",
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  requireModelContext(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "INVALID_REQUEST",
    `${name} must be an integer between ${minimum} and ${maximum}`,
  );
  return value;
}

interface Relation {
  id: string;
  metaclass: string;
  ownerId?: string;
  endpoints: Array<{ role: string; position: number; target: string }>;
}

class ModelIndex {
  readonly revision: ModelRevision;
  readonly objects = new Map<string, ObjectValue>();
  readonly raw = new Map<string, ObjectValue>();
  readonly byOwner = new Map<string, string[]>();
  readonly relations = new Map<string, Relation>();
  readonly references = new Map<string, Set<string>>();
  readonly origins = new Map<string, ObjectValue[]>();
  readonly docIds = new Map<string, string>();
  readonly sourcePaths = new Map<string, string>();
  readonly locations = new Map<
    string,
    ModelContextElement["source"]
  >();
  readonly files: ModelContextOverview["files"];

  constructor(revision: ModelRevision) {
    // Repository snapshots and every returned DTO may be mutated by callers.
    // Keep the cache isolated from both directions.
    this.revision = structuredClone(revision);
    for (const element of this.revision.elements) {
      const id = string(element["@id"]);
      if (id) this.raw.set(id, element);
    }
    for (const document of this.revision.documents) {
      const id = string(document["@id"]);
      if (!id) continue;
      if (document["@type"] === "SourcePathV0") {
        const path = string(document.path);
        if (path) this.sourcePaths.set(id, path);
      }
      if (
        ["ElementV0", "RelationshipV0"].includes(String(document["@type"]))
      ) {
        const nativeId = string(document.native_id);
        if (nativeId) {
          this.objects.set(nativeId, document);
          this.docIds.set(id, nativeId);
        }
      }
    }
    for (const [id, object] of this.objects) {
      const owner = this.native(ref(object.owner));
      if (owner) {
        this.byOwner.set(owner, [...(this.byOwner.get(owner) ?? []), id]);
      }
    }
    const documents = new Map(
      this.revision.documents.map((document) => [document["@id"], document]),
    );
    for (const document of this.revision.documents) {
      if (document["@type"] === "OriginV0") {
        const object = this.native(ref(document.object));
        if (object) {
          this.origins.set(object, [
            ...(this.origins.get(object) ?? []),
            document,
          ]);
        }
      }
      if (document["@type"] !== "RelationshipV0") continue;
      const id = string(document.native_id);
      if (!id) continue;
      const endpoints: Relation["endpoints"] = [];
      for (
        const endpointId of Array.isArray(document.endpoints)
          ? document.endpoints
          : []
      ) {
        const endpoint = documents.get(endpointId);
        const target = this.native(ref(endpoint?.target));
        if (!endpoint || !target) continue;
        endpoints.push({
          role: string(endpoint.role) ?? "unknown",
          position: typeof endpoint.position === "number"
            ? endpoint.position
            : 0,
          target,
        });
        const refs = this.references.get(target) ?? new Set<string>();
        refs.add(id);
        this.references.set(target, refs);
      }
      endpoints.sort((a, b) =>
        a.position - b.position || compare(a.target, b.target)
      );
      this.relations.set(id, {
        id,
        metaclass: string(document.metaclass) ?? "Unknown",
        ownerId: this.native(ref(document.owner)),
        endpoints,
      });
    }
    this.files = Object.keys(this.revision.sources).sort(compare).map((
      path,
    ) => ({
      path,
      sha256: this.revision.sourceHashes[path]!,
      characters: this.revision.sources[path]!.length,
      byteLength: encoder.encode(this.revision.sources[path]!).length,
    }));
  }

  native(value: string | undefined): string | undefined {
    return value &&
      (this.docIds.get(value) ?? (this.objects.has(value) ? value : undefined));
  }

  owner(id: string): string | undefined {
    return this.native(ref(this.objects.get(id)?.owner)) ??
      this.native(ref(this.raw.get(id)?.owner));
  }

  requireElement(id: unknown): string {
    requireModelContext(
      typeof id === "string" && characterCount(id) <= 512,
      "INVALID_REQUEST",
      "An elementId is required",
    );
    const native = this.native(id);
    requireModelContext(
      native,
      "NOT_FOUND",
      "Element is absent from this revision",
    );
    return native;
  }

  source(id: string): ModelContextElement["source"] {
    if (this.locations.has(id)) return this.locations.get(id);
    let current: string | undefined = id;
    const seen = new Set<string>();
    let path: string | undefined;
    while (current && !seen.has(current)) {
      seen.add(current);
      const paths = new Set<string>();
      const rawPath = string(this.raw.get(current)?.["sysx:sourceDocument"]);
      if (rawPath) paths.add(rawPath);
      for (const origin of this.origins.get(current) ?? []) {
        const sourcePath = this.sourcePaths.get(String(origin.source_path));
        if (sourcePath) paths.add(sourcePath);
      }
      requireModelContext(
        paths.size <= 1,
        "AMBIGUOUS_SOURCE",
        "Element has conflicting source origins",
      );
      if (paths.size) {
        path = [...paths][0]!;
        requireModelContext(
          Object.hasOwn(this.revision.sources, path),
          "AMBIGUOUS_SOURCE",
          "Source origin is outside this model snapshot",
        );
        break;
      }
      current = this.owner(current);
    }
    if (!path) {
      this.locations.set(id, undefined);
      return undefined;
    }
    const ranges: ModelSourceRange[] = [];
    const addRange = (values: unknown[]) => {
      if (values.every((value) => value === undefined)) return;
      requireModelContext(
        values.every((value) =>
          Number.isSafeInteger(value) && Number(value) > 0
        ),
        "INVALID_SOURCE_RANGE",
        "Incomplete source coordinates",
      );
      const [startLine, startColumn, endLine, endColumn] = values as number[];
      ranges.push({
        startLine: startLine!,
        startColumn: startColumn!,
        endLine: endLine!,
        endColumn: endColumn!,
        coordinateSystem: "utf8-bytes",
      });
    };
    const raw = this.raw.get(id);
    if (raw) {
      addRange([
        raw["sysx:sourceLine"],
        raw["sysx:sourceColumn"],
        raw["sysx:sourceEndLine"],
        raw["sysx:sourceEndColumn"],
      ]);
    }
    for (const origin of this.origins.get(id) ?? []) {
      addRange([
        origin.start_line,
        origin.start_column,
        origin.end_line,
        origin.end_column,
      ]);
    }
    requireModelContext(
      new Set(ranges.map((range) => JSON.stringify(range))).size <= 1,
      "AMBIGUOUS_SOURCE",
      "Element has conflicting source ranges",
    );
    const range = ranges[0];
    if (range) utf8SourceSpan(this.revision.sources[path]!, range);
    const location = { path, ...(range ? { range } : {}) };
    this.locations.set(id, location);
    return location;
  }

  summary(id: string): ModelContextElement {
    const object = this.objects.get(id)!;
    const raw = this.raw.get(id);
    const name = string(object.name) ?? string(raw?.declaredName);
    const qualifiedName = string(object.qualified_name) ??
      string(raw?.qualifiedName);
    return {
      id,
      metaclass: String(object.metaclass ?? raw?.["@type"] ?? "Unknown"),
      ...(name ? { name } : {}),
      ...(qualifiedName ? { qualifiedName } : {}),
      ...(this.owner(id) ? { ownerId: this.owner(id) } : {}),
      ...(this.source(id) ? { source: this.source(id) } : {}),
    };
  }

  sorted(ids: Iterable<string>): string[] {
    return [...ids].sort((a, b) => {
      const left = this.objects.get(a)!;
      const right = this.objects.get(b)!;
      return compare(
        String(left.qualified_name ?? left.name ?? a),
        String(right.qualified_name ?? right.name ?? b),
      ) || compare(a, b);
    });
  }
}

/** Read-only projection of already verified repository snapshots. No compiler,
 * writer, database query language or provider credentials reach the agent. */
export class ModelContextReader {
  readonly #repository: ModelContextRepository;
  readonly #maxCachedVersions: number;
  readonly #maxSourceBytes: number;
  readonly #maxInspectSourceBytes: number;
  readonly #cache = new Map<string, Promise<ModelIndex>>();

  constructor(
    repository: ModelContextRepository,
    options: ModelContextReaderOptions = {},
  ) {
    this.#repository = repository;
    this.#maxCachedVersions = boundedInteger(
      options.maxCachedVersions ?? 4,
      1,
      16,
      "Cache capacity",
    );
    this.#maxSourceBytes = boundedInteger(
      options.maxSourceBytes ?? 128 * 1024,
      1,
      1024 * 1024,
      "Source byte limit",
    );
    this.#maxInspectSourceBytes = boundedInteger(
      options.maxInspectSourceBytes ?? 24 * 1024,
      1,
      128 * 1024,
      "Inspection source byte limit",
    );
  }

  #remember(
    requested: string,
    load: () => Promise<ModelRevision>,
  ): Promise<ModelIndex> {
    version(requested);
    const key = requested.split(":")[1]!;
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const pending = load().then((revision) => {
      requireModelContext(
        revision.version === requested,
        "VERSION_MISMATCH",
        "Repository returned a different model revision",
      );
      return new ModelIndex(revision);
    });
    this.#cache.set(key, pending);
    while (this.#cache.size > this.#maxCachedVersions) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    pending.catch(() => {
      if (this.#cache.get(key) === pending) this.#cache.delete(key);
    });
    return pending;
  }

  async #index(requested?: string): Promise<ModelIndex> {
    if (requested !== undefined) {
      return await this.#remember(
        requested,
        () => this.#repository.at(requested),
      );
    }
    const revision = await this.#repository.current();
    version(revision.version);
    return await this.#remember(
      revision.version,
      () => Promise.resolve(revision),
    );
  }

  async overview(requested?: string): Promise<ModelContextOverview> {
    const index = await this.#index(requested);
    const roots = index.sorted(
      [...index.objects].filter(([id, object]) =>
        object.metaclass === "Package" && index.source(id) &&
        (!index.owner(id) || !index.source(index.owner(id)!))
      ).map(([id]) => id),
    );
    return structuredClone({
      version: requested ?? index.revision.version,
      sourceDigest: index.revision.sourceDigest,
      files: index.files,
      roots: {
        items: roots.slice(0, MAX_PAGE_SIZE).map((id) => index.summary(id)),
        total: roots.length,
        truncated: roots.length > MAX_PAGE_SIZE,
      },
      limits: {
        maxPageSize: MAX_PAGE_SIZE,
        maxSourceBytes: this.#maxSourceBytes,
        maxInspectSourceBytes: this.#maxInspectSourceBytes,
      },
      coverage: "bounded-discovery-not-exhaustive-impact",
    });
  }

  async query(input: ModelContextQuery): Promise<ModelContextQueryResult> {
    requireModelContext(
      input && typeof input === "object",
      "INVALID_REQUEST",
      "A model query is required",
    );
    const request = structuredClone(input);
    version(request.version);
    requireModelContext(
      ["search", "inspect", "references", "read_source"].includes(
        request.operation,
      ),
      "INVALID_REQUEST",
      "Unknown model query operation",
    );
    const offset = boundedInteger(request.offset ?? 0, 0, 1_000_000, "Offset");
    const limit = boundedInteger(
      request.limit ?? DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
      "Limit",
    );
    const index = await this.#index(request.version);
    const base = {
      version: request.version,
      sourceDigest: index.revision.sourceDigest,
    };
    const page = (total: number) => ({
      offset,
      limit,
      total,
      truncated: offset > 0 || offset + limit < total,
      ...(offset + limit < total ? { nextOffset: offset + limit } : {}),
    });
    if (request.operation === "read_source") {
      requireModelContext(
        request.offset === undefined && request.limit === undefined,
        "INVALID_REQUEST",
        "Source files must be read whole, without pagination",
      );
      requireModelContext(
        typeof request.path === "string" &&
          characterCount(request.path) <= 240 &&
          !request.path.startsWith("/") &&
          !request.path.split(/[\\/]/).some((part) => part === ".." || !part),
        "INVALID_REQUEST",
        "A relative model source path is required",
      );
      const file = index.files.find((file) => file.path === request.path);
      requireModelContext(
        file,
        "NOT_FOUND",
        "Source file is absent from this revision",
      );
      requireModelContext(
        file.byteLength <= this.#maxSourceBytes,
        "SOURCE_TOO_LARGE",
        "Source file exceeds the whole-file read limit",
      );
      return {
        operation: "read_source",
        ...base,
        ...file,
        content: index.revision.sources[file.path]!,
      };
    }
    if (request.operation === "search") {
      requireModelContext(
        request.query === undefined ||
          typeof request.query === "string" &&
            characterCount(request.query) <= 200,
        "INVALID_REQUEST",
        "Search query must be at most 200 characters",
      );
      const words = (request.query ?? "").trim().toLowerCase().split(/\s+/)
        .filter(Boolean);
      const matches = index.sorted(
        [...index.objects].filter(([id, object]) => {
          const haystack = [
            id,
            object.metaclass,
            object.name,
            object.qualified_name,
          ].join(" ").toLowerCase();
          return words.every((word) => haystack.includes(word));
        }).map(([id]) => id),
      );
      return structuredClone({
        operation: "search",
        ...base,
        ...page(matches.length),
        items: matches.slice(offset, offset + limit).map((id) =>
          index.summary(id)
        ),
      });
    }
    const id = index.requireElement(request.elementId);
    const selected = index.summary(id);
    if (request.operation === "references") {
      const relations = [...(index.references.get(id) ?? [])].sort(compare);
      const items: ModelContextRelation[] = relations.slice(
        offset,
        offset + limit,
      ).map((relationId) => {
        const relation = index.relations.get(relationId)!;
        return {
          id: relation.id,
          metaclass: relation.metaclass,
          ownerId: relation.ownerId,
          endpoints: relation.endpoints.slice(0, MAX_PAGE_SIZE).map((
            endpoint,
          ) => ({
            role: endpoint.role,
            position: endpoint.position,
            element: index.summary(endpoint.target),
          })),
          endpointsTruncated: relation.endpoints.length > MAX_PAGE_SIZE,
        };
      });
      return structuredClone({
        operation: "references",
        ...base,
        ...page(relations.length),
        selected,
        items,
        coverage: "stored-normalized-relations",
      });
    }
    const candidates = new Map<string, ModelContextInspection["reason"]>([[
      id,
      "selected",
    ]]);
    const owner = index.owner(id);
    if (owner) candidates.set(owner, "owner");
    for (const child of index.sorted(index.byOwner.get(id) ?? [])) {
      if (!candidates.has(child)) candidates.set(child, "owned");
    }
    for (
      const relationId of [...(index.references.get(id) ?? [])].sort(compare)
    ) {
      const relation = index.relations.get(relationId)!;
      if (!candidates.has(relationId)) candidates.set(relationId, "dependency");
      for (const endpoint of relation.endpoints) {
        if (!candidates.has(endpoint.target)) {
          candidates.set(endpoint.target, "dependency");
        }
      }
    }
    let remainingBytes = this.#maxInspectSourceBytes;
    const items: ModelContextInspection[] = [...candidates].slice(
      offset,
      offset + limit,
    ).map(([elementId, reason]) => {
      const element = index.summary(elementId);
      if (reason === "owner") {
        return { element, reason, sourceUnavailable: "summary-only" };
      }
      if (!element.source?.range) {
        return { element, reason, sourceUnavailable: "no-exact-range" };
      }
      const { path, range } = element.source;
      const content = utf8SourceSpan(index.revision.sources[path]!, range);
      const byteLength = encoder.encode(content).length;
      if (byteLength > remainingBytes) {
        return { element, reason, sourceUnavailable: "source-budget" };
      }
      remainingBytes -= byteLength;
      return {
        element,
        reason,
        source: {
          path,
          range,
          content,
          sha256: index.revision.sourceHashes[path]!,
        },
      };
    });
    return structuredClone({
      operation: "inspect",
      ...base,
      ...page(candidates.size),
      selected,
      items,
      coverage: "selected-owner-owned-and-direct-relations",
    });
  }
}

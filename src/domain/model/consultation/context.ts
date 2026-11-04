import type {
  BuildElementRef,
  BuildRef,
  ElementIriScope,
  ProjectionRef,
} from "../value-objects/element-ref.ts";
import type { NetworkImpactLimits } from "./network-impact.ts";

/** Host-composed ceilings, never an execution-history grant. */
export interface ModelContextCapabilities {
  networkImpact?: {
    scope: "own-history";
    limits: NetworkImpactLimits;
    maxPageSize: number;
    maxResponseCharacters: number;
  };
}

export type NetworkImpactConsultationQuery =
  & {
    operation: "network_impact";
    /** The current consultation pin, separate from historical endpoints. */
    version: string;
  }
  & ({
    action: "compare";
    operatorId: string;
    host: string;
    fromVersion: string;
    toVersion: string;
  } | {
    action: "details";
    analysisRef: string;
    view: "versions" | "transitions" | "witnesses" | "evidence" | "issues";
    cursor?: string;
    limit?: number;
  });
/** Read-only, version-pinned model discovery. A bounded result is not an
 * exhaustive impact analysis or a grant to edit any returned element. */
export type ModelContextOperation =
  | "search"
  | "inspect"
  | "references"
  | "read_source";

/** Pinned navigation and read-only queries leave the caller's working set untouched.
 * Loading/unloading source files and network analyses keep their ordered path. */
export function immutableModelConsultation(request: unknown): boolean {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const value = request as Record<string, unknown>;
  return typeof value.version === "string" && value.version.trim().length > 0 &&
    ["search", "inspect", "references", "query"].includes(
      String(value.operation),
    );
}

/** Graph pages are independent from the canonical source offset/limit. */
export interface ModelGraphSelection {
  direction?: "out" | "in";
  property?: string;
  limit?: number;
  cursor?: string;
}

export interface ModelContextQuery {
  operation: ModelContextOperation;
  version: string;
  query?: string;
  elementId?: string;
  path?: string;
  offset?: number;
  limit?: number;
  graph?: ModelGraphSelection;
  includeReferenceSites?: boolean;
}

export interface ModelExpressionQuery {
  operation: "query";
  version: string;
  expression: string;
  mode?: "toolkit" | "sparql";
}

export interface ModelSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** One-based UTF-8 byte columns; the end is exclusive. */
  coordinateSystem: "utf8-bytes";
}

export interface ModelContextElement {
  id: string;
  metaclass: string;
  name?: string;
  qualifiedName?: string;
  ownerId?: string;
  source?: { path: string; range?: ModelSourceRange };
}

export interface ModelContextOverview {
  version: string;
  sourceDigest: string;
  files: Array<{
    path: string;
    sha256: string;
    characters: number;
    byteLength: number;
  }>;
  roots: {
    items: ModelContextElement[];
    total: number;
    truncated: boolean;
  };
  limits: {
    maxPageSize: number;
    maxSourceBytes: number;
    maxInspectSourceBytes: number;
  };
  coverage: "bounded-discovery-not-exhaustive-impact";
  /** Added by the caller's turn-scoped working set, never by the reader. */
  loadedSources?: Array<{ path: string; characters: number }>;
  maxLoadedCharacters?: number;
}

/** Derived evidence cannot grant edit or execution authority. */
export type ModelSemanticEvidence = {
  state: "ready";
  advisory: true;
  version: string;
  build: BuildRef;
  projection: ProjectionRef;
  iri: string;
  scope: ElementIriScope;
  metaclass: string;
  readerVersion: string;
  neighbors: readonly {
    direction: "in" | "out";
    property: string;
    predicate: string;
    iri: string;
    ref?: BuildElementRef;
    scope?: ElementIriScope;
    /** Stable occurrence identity and zero-based list position when applicable. */
    occurrence?: string;
    position?: number;
    source?: {
      version: string;
      sourceDigest: string;
      elementId: string;
      path: string;
      range?: ModelSourceRange;
    };
    sourceUnavailable?: "library" | "unmapped";
  }[];
  /** Lookahead proves continuation; native truncation remains distinct.
   * This is independent from the canonical source result's pagination. */
  neighborPage: {
    readonly limit: number;
    readonly complete: boolean;
    readonly nativeTruncated?: boolean;
    readonly nextCursor?: string;
  };
  coverage: "bounded-direct-neighbors";
} | {
  state: "unavailable";
  advisory: true;
  version: string;
  build?: BuildRef;
  projection?: ProjectionRef;
  code: string;
  message: string;
  recovery: string;
};

interface ModelContextResultBase {
  semantic?: ModelSemanticEvidence;
  version: string;
  sourceDigest: string;
}

interface ModelContextPage {
  offset: number;
  limit: number;
  total: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface ModelContextRelation {
  id: string;
  metaclass: string;
  ownerId?: string;
  endpoints: Array<{
    role: string;
    position: number;
    element: ModelContextElement;
  }>;
  endpointsTruncated: boolean;
}

export interface ModelContextInspection {
  element: ModelContextElement;
  reason: "selected" | "owner" | "owned" | "dependency";
  source?: {
    path: string;
    sha256: string;
    range: ModelSourceRange;
    content: string;
  };
  sourceUnavailable?: "no-exact-range" | "source-budget" | "summary-only";
}

export type ModelContextQueryResult =
  | (ModelContextResultBase & ModelContextPage & {
    operation: "search";
    items: ModelContextElement[];
  })
  | (ModelContextResultBase & ModelContextPage & {
    operation: "inspect";
    selected: ModelContextElement;
    items: ModelContextInspection[];
    coverage: "selected-owner-owned-and-direct-relations";
    referenceSites?: import("../editing/tooling.ts").ReferenceSiteFingerprint[];
  })
  | (ModelContextResultBase & ModelContextPage & {
    operation: "references";
    selected: ModelContextElement;
    items: ModelContextRelation[];
    coverage: "stored-normalized-relations";
  })
  | (ModelContextResultBase & {
    operation: "read_source";
    path: string;
    sha256: string;
    characters: number;
    byteLength: number;
    content: string;
  });

/** The caller's own exact admitted contract bounds model consultation. */
export type ModelContextAccessErrorCode =
  | "MODEL_CONTEXT_AUTHORITY"
  | "MODEL_CONTEXT_CAPABILITY"
  | "MODEL_CONTEXT_CAPACITY"
  | "MODEL_CONTEXT_CONFIGURATION"
  | "MODEL_CONTEXT_INPUT"
  | "MODEL_CONTEXT_NOT_PINNED"
  | "MODEL_CONTEXT_RESPONSE_LIMIT"
  | "MODEL_CONTEXT_SCOPE"
  | "MODEL_CONTEXT_SOURCE"
  | "MODEL_CONTEXT_STALE_PIN"
  | "MODEL_CONTEXT_STALE_REQUEST"
  | "MODEL_CONTEXT_VERSION"
  | "MODEL_CONTEXT_WORKING_SET_LIMIT"
  | "REFERENCE_SITES_UNAVAILABLE"
  | "REFERENCE_SITES_TOO_LARGE";

export class ModelContextAccessError extends Error {
  readonly context = { authority: "model-read" } as const;
  readonly recovery =
    "Check the caller's current admitted model, source pin and consultation request, then retry within the advertised limits.";
  constructor(readonly code: ModelContextAccessErrorCode, message: string) {
    super(message);
    this.name = "ModelContextAccessError";
  }
}

export class ModelContextError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "VERSION_MISMATCH"
      | "NOT_FOUND"
      | "AMBIGUOUS_SOURCE"
      | "INVALID_SOURCE_RANGE"
      | "SOURCE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "ModelContextError";
  }
}

/** A navigation failure must not be mistaken for successful source-only data. */
export class ModelNavigationError extends Error {
  readonly code: string;
  readonly recovery: string;
  constructor(
    readonly evidence: Extract<ModelSemanticEvidence, { state: "unavailable" }>,
  ) {
    super(evidence.message);
    this.name = "ModelNavigationError";
    this.code = evidence.code;
    this.recovery = evidence.recovery;
  }
}

/** Preserve known refusal evidence without inventing a source pin or metadata. */
export function modelConsultationRefusalEvidence(error: unknown): {
  code?: string;
  version?: string;
  recovery?: string;
  context?: { authority: "model-read" };
  build?: BuildRef;
  projection?: ProjectionRef;
} {
  if (error instanceof ModelContextAccessError) {
    return {
      code: error.code,
      context: error.context,
      recovery: error.recovery,
    };
  }
  return error instanceof ModelNavigationError
    ? {
      code: error.code,
      version: error.evidence.version,
      recovery: error.recovery,
      ...(error.evidence.build ? { build: error.evidence.build } : {}),
      ...(error.evidence.projection
        ? { projection: error.evidence.projection }
        : {}),
    }
    : error && typeof error === "object" && "code" in error &&
        typeof error.code === "string"
    ? { code: error.code }
    : {};
}

/** A SELECT/ASK result, with explicit transport bounds and exact provenance. */
export interface ModelGraphQueryResult {
  operation: "query";
  mode: "sparql";
  version: string;
  sourceDigest: string;
  build: BuildRef;
  projection: ProjectionRef;
  limits: { maxResults: number; maxBytes: number; timeoutMs: number };
  result: { form: "boolean"; value: boolean } | {
    form: "solutions";
    variables: readonly string[];
    rows: readonly Readonly<Record<string, unknown>>[];
    truncated: boolean;
  };
}

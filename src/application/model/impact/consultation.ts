import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  NetworkImpactIssue,
  NetworkImpactLimits,
  NetworkImpactReport,
  NetworkImpactRequest,
} from "../../../domain/model/consultation/network-impact.ts";
import { validateNetworkImpactRequest } from "./analysis.ts";

const NETWORK_IMPACT_VIEWS = [
  "versions",
  "transitions",
  "witnesses",
  "evidence",
  "issues",
] as const;
export type NetworkImpactConsultationView = typeof NETWORK_IMPACT_VIEWS[number];

export type { NetworkImpactConsultationQuery } from "../../../domain/model/consultation/context.ts";
import type {
  ModelContextCapabilities,
  NetworkImpactConsultationQuery,
} from "../../../domain/model/consultation/context.ts";
import type {
  NetworkImpactConsultationBinding,
  NetworkImpactConsultationResponseBudget,
} from "./queries/inputs.ts";

class NetworkImpactConsultationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NetworkImpactConsultationError";
  }
}

type ReadMetadata = Omit<NetworkImpactReport["evidenceRead"], "issues">;
interface ResultBase {
  operation: "network_impact";
  version: string;
  analysisRef: string;
  expiresAt: string;
  request: NetworkImpactReport["request"];
  coverage: NetworkImpactReport["coverage"];
  /** Independent captured bounds; this is not a cross-store atomic snapshot. */
  evidenceRead: ReadMetadata;
}
export interface NetworkImpactConsultationSummary extends ResultBase {
  action: "compare";
  ruleVersion: NetworkImpactReport["ruleVersion"];
  limits: NetworkImpactLimits;
  lineage: Omit<NetworkImpactReport["lineage"], "versions">;
  counts: Record<NetworkImpactConsultationView, number>;
  views: readonly NetworkImpactConsultationView[];
}
export interface NetworkImpactConsultationPage extends ResultBase {
  action: "details";
  view: NetworkImpactConsultationView;
  items: unknown[];
  total: number;
  /** The effective item limit, after adapting to the remaining context. */
  limit: number;
  truncated: boolean;
  nextCursor?: string;
}
type NetworkImpactConsultationResult =
  | NetworkImpactConsultationSummary
  | NetworkImpactConsultationPage;

interface CapturedAnalysis {
  binding: string;
  owner: string;
  expiresAt: number;
  characters: number;
  summary: NetworkImpactConsultationSummary;
  rows: Record<NetworkImpactConsultationView, unknown[]>;
  cursors: Map<string, { view: NetworkImpactConsultationView; offset: number }>;
  nextCursors: Map<string, string>;
}

function requireValue(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new NetworkImpactConsultationError(code, message);
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Project a captured report into independently paginated metadata views. No
 * page consults the live stores again, and no source text enters these views. */
function rowsFor(
  report: NetworkImpactReport,
): Record<NetworkImpactConsultationView, unknown[]> {
  const issues: unknown[] = [];
  const addIssues = (
    scope: Record<string, unknown>,
    values: NetworkImpactIssue[],
  ) => {
    for (const issue of values) issues.push({ ...scope, issue });
  };
  addIssues({ scope: "analysis" }, report.issues);
  addIssues({ scope: "evidence-read" }, report.evidenceRead.issues);
  const witnesses: unknown[] = [];
  for (const frame of report.frames) {
    addIssues({ scope: "version", version: frame.version }, frame.issues);
    for (const path of frame.paths) {
      const route = {
        version: frame.version,
        pathId: path.id,
        channel: path.channel,
      };
      for (const witness of path.witnesses) {
        witnesses.push({ ...route, witness });
      }
      path.guards.forEach((guard, guardIndex) => {
        const { witnesses: values, ...metadata } = guard;
        witnesses.push({ ...route, guardIndex, guard: metadata });
        for (const witness of values) {
          witnesses.push({ ...route, guardIndex, witness });
        }
      });
    }
  }
  for (const transition of report.transitions) {
    addIssues({
      scope: "transition",
      fromVersion: transition.fromVersion,
      toVersion: transition.toVersion,
    }, transition.issues);
  }
  for (const evidence of report.evidence) {
    addIssues({ scope: "evidence", recordId: evidence.id }, evidence.issues);
  }
  return {
    versions: report.lineage.versions.map((entry) => {
      const frame = report.frames.find((frame) =>
        frame.version === entry.version
      );
      if (!frame) return { ...entry, frame: null };
      return {
        ...entry,
        frame: {
          ...frame,
          paths: frame.paths.map((path) => ({
            ...path,
            guards: path.guards.map(({ witnesses, ...guard }) => ({
              ...guard,
              witnessCount: witnesses.length,
            })),
            witnesses: undefined,
            witnessCount: path.witnesses.length,
          })),
        },
      };
    }),
    transitions: report.transitions.map((transition) => ({
      ...transition,
      changes: transition.changes.map(({ before, after, ...change }) => ({
        ...change,
        before: before &&
          {
            pathId: before.id,
            hostPermission: before.hostPermission,
            state: before.state,
          },
        after: after &&
          {
            pathId: after.id,
            hostPermission: after.hostPermission,
            state: after.state,
          },
      })),
    })),
    witnesses,
    evidence: report.evidence,
    issues,
  };
}

/** Bounded, request-isolated result storage around the existing analysis use
 * case. Composition owns its reader, evidence scope and calculation ceilings. */
export class NetworkImpactConsultation {
  readonly #results = new Map<string, CapturedAnalysis>();
  readonly #limits: NetworkImpactLimits;
  readonly #ttlMs: number;
  readonly #maxAnalyses: number;
  readonly #maxPageSize: number;
  readonly #maxResponseCharacters: number;
  readonly #maxRetainedCharacters: number;
  readonly #now: () => number;
  readonly #newReference: () => string;
  #pending = 0;

  constructor(
    readonly options: {
      analyze(
        input: NetworkImpactRequest,
        signal?: AbortSignal,
      ): Promise<NetworkImpactReport>;
      limits: NetworkImpactLimits;
      ttlMs?: number;
      maxAnalyses?: number;
      maxPageSize?: number;
      maxResponseCharacters?: number;
      /** Total JSON characters retained across captured analyses. */
      maxRetainedCharacters?: number;
      now?: () => number;
      newReference?: () => string;
    },
  ) {
    this.#limits = validateNetworkImpactRequest({
      operatorId: "configuration",
      host: "example.org",
      fromVersion: `commit:${"0".repeat(40)}`,
      toVersion: `commit:${"0".repeat(40)}`,
      limits: options.limits,
    });
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxAnalyses = options.maxAnalyses ?? 16;
    this.#maxPageSize = options.maxPageSize ?? 25;
    this.#maxResponseCharacters = options.maxResponseCharacters ?? 12_000;
    this.#maxRetainedCharacters = options.maxRetainedCharacters ?? 16_000_000;
    this.#now = options.now ?? Date.now;
    this.#newReference = options.newReference ?? (() => crypto.randomUUID());
    requireValue(
      [
        this.#ttlMs,
        this.#maxAnalyses,
        this.#maxPageSize,
        this.#maxResponseCharacters,
        this.#maxRetainedCharacters,
      ].every(positive) && this.#maxPageSize <= 50,
      "NETWORK_IMPACT_CONFIGURATION",
      "Network impact consultation ceilings must be positive bounded integers.",
    );
  }

  get capability(): NonNullable<ModelContextCapabilities["networkImpact"]> {
    return {
      scope: "own-history",
      limits: { ...this.#limits },
      maxPageSize: this.#maxPageSize,
      maxResponseCharacters: this.#maxResponseCharacters,
    };
  }

  #budget(options: NetworkImpactConsultationResponseBudget): number {
    const maximum = options.maxResponseCharacters ??
      this.#maxResponseCharacters;
    const overhead = options.responseOverheadCharacters ?? 0;
    requireValue(
      positive(maximum) && Number.isSafeInteger(overhead) && overhead >= 0,
      "NETWORK_IMPACT_RESPONSE_LIMIT",
      "The decision has no valid response budget.",
    );
    const budget = Math.min(this.#maxResponseCharacters, maximum) - overhead;
    requireValue(
      budget > 0,
      "NETWORK_IMPACT_RESPONSE_LIMIT",
      "The decision has no remaining context for network impact consultation.",
    );
    return budget;
  }

  #fits(result: unknown, maximum: number): boolean {
    return JSON.stringify(result).length <= maximum;
  }

  #prune(owner?: string, binding?: string): void {
    const now = this.#now();
    for (const [reference, result] of this.#results) {
      if (
        result.expiresAt <= now ||
        owner === result.owner && binding !== result.binding
      ) this.#results.delete(reference);
    }
  }

  #retainedCharacters(): number {
    return [...this.#results.values()].reduce(
      (sum, result) => sum + result.characters,
      0,
    );
  }

  async consult(
    binding: NetworkImpactConsultationBinding,
    query: NetworkImpactConsultationQuery,
    options: NetworkImpactConsultationResponseBudget = {},
  ): Promise<NetworkImpactConsultationResult> {
    const bound = structuredClone(binding);
    const request = structuredClone(query);
    requireValue(
      bound && typeof bound === "object" &&
        Object.keys(bound).length === 7 &&
        [
          "projectId",
          "callerId",
          "contractDigest",
          "admittedVersion",
          "consultationVersion",
          "requestKey",
          "evidenceScopeId",
        ].every((key) => {
          const value = bound[key as keyof NetworkImpactConsultationBinding];
          return typeof value === "string" && !!value.trim();
        }),
      "NETWORK_IMPACT_SCOPE",
      "Network impact consultation requires a host-resolved evidence scope and exact caller binding.",
    );
    requireValue(
      request && request.operation === "network_impact" &&
        request.version === bound.consultationVersion,
      "NETWORK_IMPACT_INPUT",
      "Use the current consultation pin independently from historical endpoints.",
    );
    const common = ["operation", "version", "action"];
    const keys = request.action === "compare"
      ? [...common, "operatorId", "host", "fromVersion", "toVersion"]
      : [...common, "analysisRef", "view", "cursor", "limit"];
    requireValue(
      Object.keys(request).every((key) => keys.includes(key)),
      "NETWORK_IMPACT_INPUT",
      "Network impact consultation does not accept extra source or calculation selectors.",
    );
    const budget = this.#budget(options);
    options.signal?.throwIfAborted();
    this.#prune();
    const bindingKey = canonical(bound);
    const owner = canonical([bound.projectId, bound.callerId]);
    if (request.action === "compare") {
      requireValue(
        request.operatorId === bound.callerId,
        "NETWORK_IMPACT_SCOPE",
        "Only the calling operator's own execution history is covered by this consultation.",
      );
      validateNetworkImpactRequest(request);
      this.#prune(owner, bindingKey);
      requireValue(
        this.#results.size + this.#pending < this.#maxAnalyses,
        "NETWORK_IMPACT_CAPACITY",
        "The network impact result capacity has been reached.",
      );
      this.#pending++;
      try {
        const report = await this.options.analyze({
          operatorId: request.operatorId,
          host: request.host,
          fromVersion: request.fromVersion,
          toVersion: request.toVersion,
          limits: { ...this.#limits },
        }, options.signal);
        options.signal?.throwIfAborted();
        requireValue(
          canonical(report.request) ===
            canonical({
              operatorId: request.operatorId,
              host: request.host,
              fromVersion: request.fromVersion,
              toVersion: request.toVersion,
            }),
          "NETWORK_IMPACT_RESULT",
          "The analysis returned a different request identity.",
        );
        const capturedRows = rowsFor(report);
        const analysisRef = `network-impact:${this.#newReference()}`;
        requireValue(
          !this.#results.has(analysisRef),
          "NETWORK_IMPACT_CAPACITY",
          "A unique analysis reference could not be allocated.",
        );
        const expiresAt = this.#now() + this.#ttlMs;
        const { issues: _issues, ...evidenceRead } = report.evidenceRead;
        const { versions: _versions, ...lineage } = report.lineage;
        const summary: NetworkImpactConsultationSummary = {
          operation: "network_impact",
          version: bound.consultationVersion,
          action: "compare",
          analysisRef,
          expiresAt: new Date(expiresAt).toISOString(),
          request: report.request,
          ruleVersion: report.ruleVersion,
          limits: report.limits,
          coverage: report.coverage,
          lineage,
          evidenceRead,
          counts: Object.fromEntries(
            NETWORK_IMPACT_VIEWS.map((
              view,
            ) => [view, capturedRows[view].length]),
          ) as Record<NetworkImpactConsultationView, number>,
          views: NETWORK_IMPACT_VIEWS,
        };
        requireValue(
          this.#fits(summary, budget),
          "NETWORK_IMPACT_RESPONSE_LIMIT",
          "The network impact summary exceeds the remaining decision context.",
        );
        const characters = JSON.stringify(capturedRows).length +
          JSON.stringify(summary).length;
        this.#prune();
        requireValue(
          this.#retainedCharacters() + characters <=
            this.#maxRetainedCharacters,
          "NETWORK_IMPACT_RESULT_LIMIT",
          "The calculated metadata exceeds the retained result budget.",
        );
        this.#results.set(analysisRef, {
          binding: bindingKey,
          owner,
          expiresAt,
          characters,
          summary: structuredClone(summary),
          rows: structuredClone(capturedRows),
          cursors: new Map(),
          nextCursors: new Map(),
        });
        return structuredClone(summary);
      } finally {
        this.#pending--;
      }
    }
    requireValue(
      request.action === "details" && typeof request.analysisRef === "string" &&
        NETWORK_IMPACT_VIEWS.includes(request.view) &&
        (request.cursor === undefined || typeof request.cursor === "string") &&
        (request.limit === undefined ||
          positive(request.limit) && request.limit <= this.#maxPageSize),
      "NETWORK_IMPACT_INPUT",
      "Invalid bounded network impact detail request.",
    );
    this.#prune(owner, bindingKey);
    const captured = this.#results.get(request.analysisRef);
    requireValue(
      captured && captured.binding === bindingKey,
      "NETWORK_IMPACT_REFERENCE",
      "The network impact reference is expired, foreign or belongs to a stale consultation request.",
    );
    const cursor = request.cursor === undefined
      ? undefined
      : captured.cursors.get(request.cursor);
    requireValue(
      request.cursor === undefined || cursor?.view === request.view,
      "NETWORK_IMPACT_CURSOR",
      "The cursor does not belong to this analysis view.",
    );
    const offset = cursor?.offset ?? 0;
    const rows = captured.rows[request.view];
    let limit = Math.min(
      request.limit ?? this.#maxPageSize,
      rows.length - offset,
    );
    const {
      operation,
      version,
      analysisRef,
      expiresAt,
      request: analyzed,
      coverage,
      evidenceRead,
    } = captured.summary;
    // Sizing must not retain cursors for rejected candidates. Reserve the
    // largest advertised cursor string so the accepted token fits as well.
    const cursorPlaceholder = "0".repeat(256);
    const page = (): NetworkImpactConsultationPage => {
      const nextOffset = offset + limit;
      const nextCursor = nextOffset < rows.length
        ? cursorPlaceholder
        : undefined;
      return {
        operation,
        version,
        analysisRef,
        expiresAt,
        request: analyzed,
        coverage,
        evidenceRead,
        action: "details",
        view: request.view,
        items: rows.slice(offset, nextOffset),
        total: rows.length,
        limit,
        truncated: nextOffset < rows.length,
        ...(nextCursor ? { nextCursor } : {}),
      };
    };
    let result = page();
    while (!this.#fits(result, budget) && limit > 1) {
      limit--;
      result = page();
    }
    requireValue(
      this.#fits(result, budget),
      "NETWORK_IMPACT_RESPONSE_LIMIT",
      "One complete metadata item or its provenance exceeds the remaining decision context; no item was truncated.",
    );
    const nextOffset = offset + limit;
    const nextKey = `${request.view}:${nextOffset}`;
    const existingCursor = captured.nextCursors.get(nextKey);
    if (result.truncated && existingCursor) {
      result = { ...result, nextCursor: existingCursor };
    } else if (result.truncated) {
      const nextCursor = this.#newReference();
      requireValue(
        /^[A-Za-z0-9_-]{1,256}$/.test(nextCursor) &&
          !captured.cursors.has(nextCursor),
        "NETWORK_IMPACT_CURSOR",
        "A unique bounded page cursor could not be allocated.",
      );
      const position = { view: request.view, offset: nextOffset };
      const characters = JSON.stringify([nextCursor, position]).length +
        JSON.stringify([nextKey, nextCursor]).length;
      requireValue(
        this.#retainedCharacters() + characters <= this.#maxRetainedCharacters,
        "NETWORK_IMPACT_RESULT_LIMIT",
        "The page cursor exceeds the retained result budget.",
      );
      captured.cursors.set(nextCursor, position);
      captured.nextCursors.set(nextKey, nextCursor);
      captured.characters += characters;
      result = { ...result, nextCursor };
    }
    return structuredClone(result);
  }
}

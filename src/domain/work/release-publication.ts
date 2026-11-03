/** Durable observations of an accepted Release preparation. This is neither an
 * execution grant nor a continuously running-worker indicator. */
export type ReleasePublicationOutcome =
  | "pending"
  | "preparing"
  | "completed"
  | "incomplete"
  | "failed"
  | "refused";
type ReleasePublicationStep =
  | "acceptance"
  | "preparation"
  | "recovery"
  | "tag-verification"
  | "asset-retention"
  | "manifest-finalization";
export type ReleasePublicationIssue =
  | "TAG_UNAVAILABLE"
  | "SOURCE_STALE"
  | "EXACT_ASSET_UNAVAILABLE"
  | "PREREQUISITES_REQUIRED"
  | "PUBLICATION_FAILED"
  | "CAPTURE_CHANGED";
export interface ReleasePublicationEvent {
  sequence: number;
  attempt: number;
  step: ReleasePublicationStep;
  status: "started" | "completed" | "incomplete" | "failed" | "refused";
  at: string;
  /** Source member ordinal only; no draft, binding, private path or exception. */
  member?: number;
  issue?: ReleasePublicationIssue;
}
export interface ReleasePublication {
  format: "assembly-release-publication-v1";
  outcome: ReleasePublicationOutcome;
  attempt: number;
  /** Internal CAS ownership token, excluded from every public view. */
  runId?: string;
  updatedAt: string;
  nextSequence: number;
  historyTruncated: boolean;
  events: ReleasePublicationEvent[];
}
export type ReleasePublicationView = Omit<ReleasePublication, "runId">;
const steps = new Set([
  "acceptance",
  "preparation",
  "recovery",
  "tag-verification",
  "asset-retention",
  "manifest-finalization",
]);
const outcomes = new Set([
  "pending",
  "preparing",
  "completed",
  "incomplete",
  "failed",
  "refused",
]);
const statuses = new Set([
  "started",
  "completed",
  "incomplete",
  "failed",
  "refused",
]);
const issues = new Set([
  "TAG_UNAVAILABLE",
  "SOURCE_STALE",
  "EXACT_ASSET_UNAVAILABLE",
  "PREREQUISITES_REQUIRED",
  "PUBLICATION_FAILED",
  "CAPTURE_CHANGED",
]);
export const RELEASE_PUBLICATION_HISTORY_LIMIT = 256;
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
/** Fail closed on corrupted progress: no raw JSON fields cross the read boundary. */
export function assertReleasePublication(
  value: unknown,
): asserts value is ReleasePublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Release publication");
  }
  const p = value as ReleasePublication;
  if (
    Object.keys(p).some((key) =>
      ![
        "format",
        "outcome",
        "attempt",
        "runId",
        "updatedAt",
        "nextSequence",
        "historyTruncated",
        "events",
      ].includes(key)
    ) ||
    p.format !== "assembly-release-publication-v1" ||
    !outcomes.has(p.outcome) ||
    !Number.isSafeInteger(p.attempt) || p.attempt < 0 ||
    !Number.isSafeInteger(p.nextSequence) || p.nextSequence < 1 ||
    !timestamp(p.updatedAt) || typeof p.historyTruncated !== "boolean" ||
    p.runId !== undefined &&
      (typeof p.runId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(p.runId)) ||
    !Array.isArray(p.events) ||
    p.events.length > RELEASE_PUBLICATION_HISTORY_LIMIT
  ) throw new Error("Invalid Release publication");
  let previous = 0;
  for (const event of p.events) {
    if (
      !event || Object.keys(event).some((key) =>
        !["sequence", "attempt", "step", "status", "at", "member", "issue"]
          .includes(key)
      ) ||
      !Number.isSafeInteger(event.sequence) || event.sequence <= previous ||
      event.sequence >= p.nextSequence ||
      !Number.isSafeInteger(event.attempt) ||
      event.attempt < 0 || event.attempt > p.attempt ||
      !steps.has(event.step) ||
      !statuses.has(event.status) || !timestamp(event.at) ||
      event.member !== undefined &&
        (!Number.isSafeInteger(event.member) || event.member < 0) ||
      event.issue !== undefined && !issues.has(event.issue)
    ) {
      throw new Error("Invalid Release publication event");
    }
    previous = event.sequence;
  }
}
export function publicationEvent(
  prior: ReleasePublication | undefined,
  event: Omit<ReleasePublicationEvent, "sequence" | "attempt" | "at">,
  outcome: ReleasePublicationOutcome,
  at: string,
  runId?: string,
): ReleasePublication {
  if (prior) assertReleasePublication(prior);
  const sequence = prior?.nextSequence ?? 1;
  const starting = runId !== undefined && prior?.runId !== runId;
  const attempt = (prior?.attempt ?? 0) + (starting ? 1 : 0);
  const events = [...(prior?.events ?? []), {
    ...event,
    sequence,
    attempt,
    at,
  }];
  const result: ReleasePublication = {
    format: "assembly-release-publication-v1",
    outcome,
    attempt,
    ...(runId ? { runId } : prior?.runId ? { runId: prior.runId } : {}),
    updatedAt: at,
    nextSequence: sequence + 1,
    historyTruncated: prior?.historyTruncated === true ||
      events.length > RELEASE_PUBLICATION_HISTORY_LIMIT,
    events: events.slice(-RELEASE_PUBLICATION_HISTORY_LIMIT),
  };
  assertReleasePublication(result);
  return result;
}
export function releasePublicationView(
  value: ReleasePublication,
): ReleasePublicationView {
  assertReleasePublication(value);
  const { runId: _privateRun, ...publicValue } = value;
  return structuredClone(publicValue);
}

import { shortDate } from "../dates.ts";
import { computed, signal } from "@preact/signals";
import type { Fetcher } from "../workbench/api.ts";

/**
 * Cases: the units of work the central agent opens (Case #N). This module is
 * the only reader of the backend contract (`/api/cases`, SSE `cases`, the
 * `caseId` of messages); its parser is strict on the fields it uses and
 * ignores fields it does not know, so the contract can still grow.
 */
export type CaseKind = "request" | "job" | "watch";
export type CaseVerdict = "accepted" | "rejected";
export type CaseStatus =
  | "open"
  | "waiting"
  | "closed-done"
  | "closed-abandoned";

/** How a Case is named on screen, by kind and by state. */
export const caseKindLabel: Record<CaseKind, string> = {
  request: "Request",
  job: "Job",
  watch: "Watch",
};
export const caseStatusLabel: Record<CaseStatus, string> = {
  open: "Open",
  waiting: "Waiting",
  "closed-done": "Done",
  "closed-abandoned": "Abandoned",
};

export interface CaseRecord {
  id: string;
  number: number;
  type: CaseKind;
  objective: string;
  owner: string;
  status: CaseStatus;
  initialExecutionOutcome?: "refused";
  createdAt: string;
  closedAt?: string;
  closedBy?: string;
  verdict?: CaseVerdict;
  openedFrom: { conversationId: string; messageId?: string };
  modelPin: { digest: string; repositoryVersion?: string };
  budget?: { budgetId: string; scopeId: string };
  /** Present on a Job once the backend serves it (phase 1: Request only). */
  job?: JobDetails;
  /** Present on a Watch once the backend serves it (phase 1: Request only). */
  watch?: WatchDetails;
}

/**
 * Job and Watch pages are ready before the backend serves these types (it
 * answers NOT_SUPPORTED_YET today). Their details follow this expected shape;
 * a Case without them still shows its common facts.
 */
export type JobStepState =
  | "done"
  | "running"
  | "judgment"
  | "pending"
  | "failed"
  | "skipped";
export interface JobStep {
  id: string;
  label: string;
  state: JobStepState;
  /** A judgment point waiting for a person: one button per option. */
  judgment?: { question: string; options: { id: string; label: string }[] };
}
export interface JobRun {
  id: string;
  startedAt: string;
  outcome: "done" | "failed" | "running" | "abandoned";
}
export interface JobDetails {
  schedule?: string;
  steps: JobStep[];
  runs: JobRun[];
}
export interface WatchWake {
  at: string;
  changed: boolean;
  summary?: string;
}
export interface WatchDetails {
  state: "watching" | "paused" | "stopped";
  nextWakeAt?: string;
  wakes: WatchWake[];
}

export interface CasesSnapshot {
  systemId: string;
  cases: CaseRecord[];
}

interface CaseDetail {
  status: "loading" | "ready" | "not-found" | "error";
  record?: CaseRecord;
  error?: string;
}

const kinds: readonly string[] = ["request", "job", "watch"];
const statuses: readonly string[] = [
  "open",
  "waiting",
  "closed-done",
  "closed-abandoned",
];
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const timestamp = (value: unknown): value is string =>
  identity(value) && Number.isFinite(Date.parse(value));

const stepStates: readonly string[] = [
  "done",
  "running",
  "judgment",
  "pending",
  "failed",
  "skipped",
];
const runOutcomes: readonly string[] = [
  "done",
  "failed",
  "running",
  "abandoned",
];
const watchStates: readonly string[] = ["watching", "paused", "stopped"];

function parseJob(value: unknown): JobDetails {
  const invalid = () => new Error("The job received is unreadable.");
  if (
    !object(value) || !Array.isArray(value.steps) ||
    !Array.isArray(value.runs) ||
    (value.schedule !== undefined && !identity(value.schedule))
  ) throw invalid();
  const steps = value.steps.map((step): JobStep => {
    if (
      !object(step) || !identity(step.id) || !identity(step.label) ||
      typeof step.state !== "string" || !stepStates.includes(step.state)
    ) throw invalid();
    const judgment = step.judgment;
    if (
      judgment !== undefined &&
      (!object(judgment) || !identity(judgment.question) ||
        !Array.isArray(judgment.options) ||
        !judgment.options.every((option) =>
          object(option) && identity(option.id) && identity(option.label)
        ))
    ) throw invalid();
    return {
      id: step.id,
      label: step.label,
      state: step.state as JobStepState,
      ...(object(judgment)
        ? {
          judgment: {
            question: judgment.question as string,
            options: (judgment.options as { id: string; label: string }[])
              .map(({ id, label }) => ({ id, label })),
          },
        }
        : {}),
    };
  });
  const runs = value.runs.map((run): JobRun => {
    if (
      !object(run) || !identity(run.id) || !timestamp(run.startedAt) ||
      typeof run.outcome !== "string" || !runOutcomes.includes(run.outcome)
    ) throw invalid();
    return {
      id: run.id,
      startedAt: run.startedAt,
      outcome: run.outcome as JobRun["outcome"],
    };
  });
  return {
    ...(identity(value.schedule) ? { schedule: value.schedule } : {}),
    steps,
    runs,
  };
}

function parseWatch(value: unknown): WatchDetails {
  const invalid = () => new Error("The watch received is unreadable.");
  if (
    !object(value) || typeof value.state !== "string" ||
    !watchStates.includes(value.state) ||
    (value.nextWakeAt !== undefined && !timestamp(value.nextWakeAt)) ||
    !Array.isArray(value.wakes)
  ) throw invalid();
  return {
    state: value.state as WatchDetails["state"],
    ...(timestamp(value.nextWakeAt) ? { nextWakeAt: value.nextWakeAt } : {}),
    wakes: value.wakes.map((wake): WatchWake => {
      if (
        !object(wake) || !timestamp(wake.at) ||
        typeof wake.changed !== "boolean" ||
        (wake.summary !== undefined && typeof wake.summary !== "string")
      ) throw invalid();
      return {
        at: wake.at,
        changed: wake.changed,
        ...(typeof wake.summary === "string" ? { summary: wake.summary } : {}),
      };
    }),
  };
}

function parseCase(value: unknown): CaseRecord {
  const invalid = () => new Error("The cases received are unreadable.");
  if (!object(value)) throw invalid();
  const { openedFrom, modelPin, budget } = value;
  if (
    !identity(value.id) || !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 || typeof value.type !== "string" ||
    !kinds.includes(value.type) ||
    !identity(value.objective) || !identity(value.owner) ||
    typeof value.status !== "string" || !statuses.includes(value.status) ||
    value.initialExecutionOutcome !== undefined &&
      (value.initialExecutionOutcome !== "refused" ||
        value.type !== "request" ||
        !["open", "waiting"].includes(value.status)) ||
    !timestamp(value.createdAt) ||
    (value.closedAt !== undefined && !timestamp(value.closedAt)) ||
    (value.closedBy !== undefined && !identity(value.closedBy)) ||
    (value.verdict !== undefined &&
      (value.status !== "closed-done" || !identity(value.closedBy) ||
        !["accepted", "rejected"].includes(value.verdict as string))) ||
    !object(openedFrom) || !identity(openedFrom.conversationId) ||
    (openedFrom.messageId !== undefined && !identity(openedFrom.messageId)) ||
    !object(modelPin) || !identity(modelPin.digest) ||
    (modelPin.repositoryVersion !== undefined &&
      !identity(modelPin.repositoryVersion)) ||
    (budget !== undefined &&
      (!object(budget) || !identity(budget.budgetId) ||
        !identity(budget.scopeId)))
  ) throw invalid();
  // Only known fields are kept: unknown ones are ignored, never trusted.
  return {
    id: value.id,
    number: value.number as number,
    type: value.type as CaseKind,
    objective: value.objective,
    owner: value.owner,
    status: value.status as CaseStatus,
    ...(value.initialExecutionOutcome === "refused"
      ? { initialExecutionOutcome: "refused" as const }
      : {}),
    createdAt: value.createdAt,
    ...(value.closedAt !== undefined ? { closedAt: value.closedAt } : {}),
    ...(value.closedBy !== undefined
      ? { closedBy: value.closedBy as string }
      : {}),
    ...(value.verdict !== undefined
      ? { verdict: value.verdict as CaseVerdict }
      : {}),
    openedFrom: {
      conversationId: openedFrom.conversationId,
      ...(openedFrom.messageId !== undefined
        ? { messageId: openedFrom.messageId as string }
        : {}),
    },
    modelPin: {
      digest: modelPin.digest,
      ...(modelPin.repositoryVersion !== undefined
        ? { repositoryVersion: modelPin.repositoryVersion as string }
        : {}),
    },
    ...(object(budget)
      ? {
        budget: {
          budgetId: budget.budgetId as string,
          scopeId: budget.scopeId as string,
        },
      }
      : {}),
    ...(value.type === "job" && value.job !== undefined
      ? { job: parseJob(value.job) }
      : {}),
    ...(value.type === "watch" && value.watch !== undefined
      ? { watch: parseWatch(value.watch) }
      : {}),
  };
}

/**
 * Wakes as the page shows them, newest first: each change on its own, and a
 * run of wakes without change folded into one line.
 */
export type WakeGroup =
  | { kind: "change"; wake: WatchWake }
  | { kind: "quiet"; count: number; from: string; to: string };
export function groupWakes(wakes: readonly WatchWake[]): WakeGroup[] {
  const groups: WakeGroup[] = [];
  const newest = [...wakes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const wake of newest) {
    const last = groups.at(-1);
    if (wake.changed) groups.push({ kind: "change", wake });
    else if (last?.kind === "quiet") {
      last.count++;
      last.from = wake.at;
    } else groups.push({ kind: "quiet", count: 1, from: wake.at, to: wake.at });
  }
  return groups;
}

/**
 * A Case is named by what was asked, not by its number: the first sentence of
 * the objective, without polite openers, cut at a word boundary.
 */
export function caseTitle(
  record: Pick<CaseRecord, "objective">,
  max = 48,
): string {
  // Openers go first, so "Hi! Can you…" keeps its subject.
  const asked = record.objective.trim().replace(
    /^(?:(?:hi|hello|hey|please|bonjour|salut|stp|svp)[,!.\s]+)*(?:(?:can|could|would) you|peux-tu|pourrais-tu|est-ce que tu peux)?\s*/i,
    "",
  );
  const sentence = asked.split(/(?<=[.?!])\s|\n/)[0] ?? "";
  const plain = sentence.replace(/[?.!\s]+$/, "").trim();
  const text = plain || record.objective.trim() || "Untitled";
  const named = text[0].toLocaleUpperCase() + text.slice(1);
  if ([...named].length <= max) return named;
  const cut = [...named].slice(0, max - 1).join("");
  const word = cut.replace(/\s+\S*$/, "");
  return `${word.length >= max / 2 ? word : cut}…`;
}

/** "3 Nov, 19:52": the day and time of an event. */
export function timeLabel(at: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "in 3 hours", "yesterday", or a date: enough to place an event. */
export function since(at: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(at) - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return Math.abs(seconds) >= 7 * 86400
        ? shortDate(at)
        : format.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

/** One line for a Job or a Watch in its Dock stack: when, and what it found. */
export function caseDetail(record: CaseRecord, now = Date.now()): string {
  if (record.type === "job" && record.job) {
    const last = record.job.runs.at(-1);
    return [
      record.job.schedule,
      last ? `last run ${last.outcome}, ${since(last.startedAt, now)}` : null,
    ].filter(Boolean).join(" · ");
  }
  if (record.type === "watch" && record.watch) {
    // The last change, not the last quiet check, says what the Watch found.
    const wake = record.watch.wakes.findLast((entry) =>
      entry.changed && entry.summary
    );
    return [
      record.watch.state === "watching" && record.watch.nextWakeAt
        ? `next check ${since(record.watch.nextWakeAt, now)}`
        : record.watch.state,
      wake?.summary,
    ].filter(Boolean).join(" · ");
  }
  return "";
}

/**
 * The central agent in a few words, without an avatar: what it works on, or
 * whether it waits for the person, or nothing.
 */
export function agentActivity(input: {
  busy: boolean;
  openCase: Pick<CaseRecord, "objective" | "status"> | null;
  decisionWaiting: boolean;
}): string {
  if (input.busy) {
    return input.openCase
      ? `Working on ${caseTitle(input.openCase, 32)}`
      : "Working";
  }
  if (input.decisionWaiting || input.openCase) return "Waiting for you";
  return "Idle";
}

/** Rejects ambiguous identities: a tile and its #N must name one Case. */
export function parseCasesSnapshot(value: unknown): CasesSnapshot {
  if (
    !object(value) || !identity(value.systemId) || !Array.isArray(value.cases)
  ) {
    throw new Error("The cases received are unreadable.");
  }
  const cases = value.cases.flatMap((entry) => {
    try {
      return [parseCase(entry)];
    } catch {
      // One unreadable Case must not hide the other valid records.
      return [];
    }
  });
  if (
    new Set(cases.map((entry) => entry.id)).size !== cases.length ||
    new Set(cases.map((entry) => `${entry.owner}#${entry.number}`)).size !==
      cases.length
  ) throw new Error("The cases received are ambiguous.");
  return { systemId: value.systemId, cases };
}

export function isOpenCase(record: Pick<CaseRecord, "status">): boolean {
  return record.status === "open" || record.status === "waiting";
}

/** The Case a message or event belongs to, when the host recorded one. */
export function messageCaseId(message: object): string | undefined {
  const id = (message as { caseId?: unknown }).caseId;
  return identity(id) ? id : undefined;
}

/**
 * Where a Case opens: a Request on the Requests page, selected; a Job or a Watch
 * on its own page. A Case whose kind is not known yet is read as a Request.
 */
export function caseHref(id: string, type: CaseKind = "request"): string {
  const query = new URLSearchParams({ case: id });
  return type === "request" ? `/cases?${query}` : `/chat?${query}`;
}

/** A new Request on the Requests page, starting from this Release. */
export function newRequestHref(releaseId: string): string {
  return `/cases?${new URLSearchParams({ from: releaseId })}`;
}

/** A sub-agent's messages in a Request: the Requests page reads them, read-only. */
export function caseAgentHref(caseId: string, agentId: string): string {
  return `/cases?${new URLSearchParams({ case: caseId, agent: agentId })}`;
}

export interface CasesPort {
  /** `null` when the served backend does not offer Cases yet (404). */
  read(): Promise<CasesSnapshot | null>;
  /** `null` when this Case does not exist (404). */
  readOne(id: string): Promise<CaseRecord | null>;
  close(
    id: string,
    outcome: "done" | "abandoned",
    verdict?: CaseVerdict,
  ): Promise<void>;
  /** Runtime actions on a Job or a Watch; none of them grants a right. */
  act(id: string, action: CaseAction): Promise<void>;
}

/** What a person can ask of a Job (run) or a Watch (pause, resume, stop). */
export type CaseAction = "run" | "pause" | "resume" | "stop";

export function createCasesApi(
  fetcher: Fetcher = (path, init) => fetch(path, init),
): CasesPort {
  async function failure(response: Response, fallback: string) {
    const body: unknown = await response.json().catch(() => ({}));
    const error = object(body) && object(body.error) ? body.error : undefined;
    return new Error(
      typeof error?.message === "string" ? error.message : fallback,
    );
  }
  return {
    async read() {
      const response = await fetcher("/api/cases", { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw await failure(
          response,
          `Cases unavailable (${response.status}).`,
        );
      }
      return parseCasesSnapshot(await response.json());
    },
    async readOne(id) {
      const response = await fetcher(`/api/cases/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw await failure(response, `Case unavailable (${response.status}).`);
      }
      const record = parseCase(await response.json());
      if (record.id !== id) {
        throw new Error("The Case received does not match.");
      }
      return record;
    },
    async close(id, outcome, verdict) {
      const response = await fetcher(
        `/api/cases/${encodeURIComponent(id)}/close`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome, verdict }),
        },
      );
      if (!response.ok) {
        throw await failure(response, "The Case could not be closed.");
      }
    },
    async act(id, action) {
      const response = await fetcher(
        `/api/cases/${encodeURIComponent(id)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) {
        throw await failure(response, `The ${action} action failed.`);
      }
    },
  };
}

/** `/chat?case=new`: a Case not opened yet, i.e. the Requests page, nothing selected. */
export const NEW_CASE = "new";

/** A closed Request stays in reach this long before leaving the Dock. */
export const RECENTLY_CLOSED_MS = 24 * 60 * 60 * 1000;

/**
 * The Cases read model of one workbench. `supported` stays `null` until the
 * first answer, then `false` on a backend without Cases: the desk keeps its
 * previous behaviour and shows no error for an absent feature.
 */
export function createCases(
  options: { port?: CasesPort; now?: () => number },
) {
  const now = options.now ?? Date.now;
  // Closed Requests expire with time, not only with new snapshots: the desk
  // ticks this clock (see `tick`).
  const clock = signal(now());
  const acting = signal<string | null>(null);
  const snapshot = signal<CasesSnapshot | null>(null);
  const supported = signal<boolean | null>(null);
  const error = signal("");
  const closing = signal<string | null>(null);
  const details = signal<ReadonlyMap<string, CaseDetail>>(new Map());
  let lifecycle = 0;
  // The contract has no revision: order reads when they start and SSE events
  // when they arrive, so an older response cannot undo any newer accepted read.
  let sequence = 0;
  let acceptedSequence = 0;
  let collectionSequence = 0;
  let flight: Promise<void> | null = null;
  const detailFlights = new Map<string, Promise<void>>();
  const detailInvalidations = new Map<string, number>();
  let queued = false;
  /** Open Cases, oldest first: numbers only grow, so this is arrival order. */
  const open = computed(() =>
    (snapshot.value?.cases ?? []).filter(isOpenCase).sort((a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
    )
  );
  /** Requests closed within the last day, oldest closure first. */
  const recentlyClosed = computed(() => {
    const since = clock.value - RECENTLY_CLOSED_MS;
    return (snapshot.value?.cases ?? []).filter((record) =>
      record.type === "request" && !isOpenCase(record) &&
      record.closedAt !== undefined && Date.parse(record.closedAt) >= since
    ).sort((a, b) =>
      Date.parse(a.closedAt!) - Date.parse(b.closedAt!) || a.number - b.number
    );
  });
  function byId(id: string | null | undefined): CaseRecord | null {
    return snapshot.value?.cases.find((entry) => entry.id === id) ??
      (id ? details.value.get(id)?.record : null) ?? null;
  }
  function accept(value: unknown) {
    // Every SSE arrival invalidates reads started before it, including a
    // malformed event for which the caller will request a fresh snapshot.
    acceptedSequence = ++sequence;
    collectionSequence = acceptedSequence;
    apply(parseCasesSnapshot(value));
  }
  function apply(next: CasesSnapshot) {
    const cached = new Map(details.peek());
    for (const [id, detail] of cached) {
      const record = next.cases.find((entry) => entry.id === id);
      if (record) cached.set(id, { status: "ready", record });
      // A disappearing open Case needs its detail reread; its cached open
      // status cannot establish whether the Case has since closed.
      else if (detail.record && isOpenCase(detail.record)) cached.delete(id);
    }
    details.value = cached;
    snapshot.value = next;
    supported.value = true;
    error.value = "";
  }
  function refresh(): Promise<void> {
    if (!options.port) return Promise.resolve();
    queued = true;
    if (flight) return flight;
    const requestLifecycle = lifecycle;
    const task = (async () => {
      while (queued && requestLifecycle === lifecycle) {
        queued = false;
        const requestedSequence = ++sequence;
        try {
          const next = await options.port!.read();
          if (requestLifecycle !== lifecycle) return;
          if (requestedSequence < acceptedSequence) {
            // A detail cannot fill the Dock: reread the collection unless a
            // newer collection/SSE snapshot has already supplied it.
            queued ||= requestedSequence > collectionSequence;
            continue;
          }
          if (next === null) {
            acceptedSequence = requestedSequence;
            collectionSequence = requestedSequence;
            supported.value = false;
            snapshot.value = null;
          } else {
            const parsed = parseCasesSnapshot(next);
            acceptedSequence = requestedSequence;
            collectionSequence = requestedSequence;
            apply(parsed);
          }
        } catch (cause) {
          if (
            requestLifecycle === lifecycle &&
            requestedSequence < acceptedSequence
          ) queued ||= requestedSequence > collectionSequence;
          if (
            requestLifecycle === lifecycle &&
            requestedSequence >= acceptedSequence
          ) {
            error.value = cause instanceof Error
              ? cause.message
              : "Cases unavailable.";
          }
        }
      }
    })().finally(() => {
      if (flight === task) flight = null;
    });
    flight = task;
    return task;
  }
  function detailStatus(id: string) {
    return details.value.get(id)?.status;
  }
  function detailError(id: string): string {
    return details.value.get(id)?.error ?? "";
  }
  function setDetail(id: string, detail: CaseDetail) {
    details.value = new Map(details.peek()).set(id, detail);
  }
  /** Read a direct link or a closed Case omitted from the Dock collection. */
  function ensure(id: string): Promise<void> {
    return readDetail(id, false);
  }
  function readDetail(id: string, invalidated: boolean): Promise<void> {
    if (invalidated) {
      detailInvalidations.set(id, (detailInvalidations.get(id) ?? 0) + 1);
    } else if (byId(id)) return Promise.resolve();
    const existing = detailFlights.get(id);
    if (existing) return existing;
    const requestLifecycle = lifecycle;
    setDetail(id, { status: "loading" });
    const task = (async () => {
      while (requestLifecycle === lifecycle) {
        const requestedSequence = ++sequence;
        const invalidation = detailInvalidations.get(id);
        try {
          const record = await options.port?.readOne(id) ?? null;
          if (requestLifecycle !== lifecycle) return;
          if (requestedSequence < collectionSequence) {
            if (!detailInvalidations.has(id) && byId(id)) return;
            continue;
          }
          // Other Cases' details are independent; the global watermark still
          // prevents an older collection from overwriting any updated row.
          acceptedSequence = Math.max(acceptedSequence, requestedSequence);
          setDetail(
            id,
            record ? { status: "ready", record } : { status: "not-found" },
          );
          // A targeted reread also updates the Dock's existing row, including
          // closure. Direct links outside its collection remain detail-only.
          const collection = snapshot.peek();
          if (collection?.cases.some((entry) => entry.id === id)) {
            snapshot.value = {
              ...collection,
              cases: record
                ? collection.cases.map((entry) =>
                  entry.id === id ? record : entry
                )
                : collection.cases.filter((entry) => entry.id !== id),
            };
          }
        } catch (cause) {
          if (requestLifecycle !== lifecycle) return;
          if (requestedSequence < collectionSequence) continue;
          setDetail(id, {
            status: "error",
            error: cause instanceof Error ? cause.message : "Case unavailable.",
          });
        }
        if (invalidation !== detailInvalidations.get(id)) continue;
        return;
      }
    })().finally(() => {
      if (detailFlights.get(id) === task) {
        detailFlights.delete(id);
        detailInvalidations.delete(id);
      }
    });
    detailFlights.set(id, task);
    return task;
  }
  /** Coalesced reread of one known Case without fetching its full history. */
  function refreshOne(id: string): Promise<void> {
    return readDetail(id, true);
  }
  async function close(
    id: string,
    outcome: "done" | "abandoned",
    verdict?: CaseVerdict,
  ) {
    const record = byId(id);
    if (!options.port || !record || !isOpenCase(record) || closing.peek()) {
      return false;
    }
    closing.value = id;
    error.value = "";
    try {
      await options.port.close(id, outcome, verdict);
      // A direct-link Case may live only in the detail cache, outside the
      // collection. Its pre-command record must not survive the reread.
      if (details.peek().has(id)) {
        const next = new Map(details.peek());
        next.delete(id);
        details.value = next;
      }
      await refresh();
      if (!byId(id)) await ensure(id);
      return true;
    } catch (cause) {
      error.value = cause instanceof Error
        ? cause.message
        : "The Case could not be closed.";
      return false;
    } finally {
      closing.value = null;
    }
  }
  /** Advance the clock that ages closed Requests out of the Dock. */
  function tick(at = now()) {
    clock.value = at;
  }
  /** One action at a time per desk; the SSE event confirms the new state. */
  async function act(id: string, action: CaseAction) {
    const record = byId(id);
    if (!options.port || !record || !isOpenCase(record) || acting.peek()) {
      return false;
    }
    acting.value = id;
    error.value = "";
    try {
      await options.port.act(id, action);
      await refresh();
      return true;
    } catch (cause) {
      error.value = cause instanceof Error
        ? cause.message
        : `The ${action} action failed.`;
      return false;
    } finally {
      acting.value = null;
    }
  }
  function dispose() {
    lifecycle++;
    queued = false;
    flight = null;
    detailFlights.clear();
    detailInvalidations.clear();
    details.value = new Map();
  }
  return {
    snapshot,
    supported,
    error,
    closing,
    acting,
    open,
    recentlyClosed,
    tick,
    act,
    byId,
    accept,
    refresh,
    ensure,
    refreshOne,
    detailStatus,
    detailError,
    close,
    dispose,
  };
}
export type CasesStore = ReturnType<typeof createCases>;

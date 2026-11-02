import type { GraphSnapshot } from "./types.ts";

export interface LiveStatus {
  connected: boolean;
  stale: boolean;
  message: string;
}
export interface LiveSync {
  request(): Promise<void>;
  open(): Promise<void>;
  disconnect(): void;
  modelError(reason: string): void;
  dispose(): void;
}
export interface LiveSource {
  addEventListener(
    type: string,
    listener: (event: { data: string }) => unknown,
  ): void;
  onopen: (() => unknown) | null;
  onerror: (() => unknown) | null;
  close?(): void;
}

/** Coalesce model events without allowing an earlier read to clear a newer error. */
export function createLiveSync(options: {
  readState(): Promise<GraphSnapshot>;
  getDigest(): string;
  getActivityDigest?(): string;
  applyState(state: GraphSnapshot, changed: boolean): void;
  onStatus(status: LiveStatus): void;
}): LiveSync {
  let running: Promise<void> | null = null;
  let queued = false,
    connected = false,
    stale = true,
    epoch = 0,
    disposed = false;
  let message = "Connecting";
  const status = () => {
    if (!disposed) options.onStatus({ connected, stale, message });
  };
  function invalidate(reason: string) {
    epoch++;
    stale = true;
    message = reason;
    status();
  }
  async function drain() {
    while (queued && !disposed) {
      queued = false;
      const readEpoch = epoch;
      try {
        const fresh = await options.readState();
        if (disposed) return;
        if (fresh.error) throw new Error(String(fresh.error));
        if (
          !fresh.graph || !Array.isArray(fresh.graph.nodes) ||
          !Array.isArray(fresh.graph.edges) ||
          typeof fresh.projectionDigest !== "string"
        ) {
          throw new Error("Invalid native projection");
        }
        options.applyState(
          fresh,
          fresh.projectionDigest !== options.getDigest() ||
            (fresh.activityDigest || "") !==
              (options.getActivityDigest?.() || ""),
        );
        if (readEpoch === epoch) {
          stale = !connected;
          message = connected ? "" : "Connection interrupted";
          status();
        }
      } catch (error) {
        stale = true;
        message = error instanceof Error ? error.message : String(error);
        status();
      }
    }
  }
  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    queued = true;
    if (!running) {
      running = Promise.resolve().then(drain).finally(() => {
        running = null;
      });
    }
    return running;
  }
  return {
    request,
    open() {
      connected = true;
      stale = true;
      message = "Refreshing";
      status();
      return request();
    },
    disconnect() {
      connected = false;
      invalidate("Connection interrupted");
    },
    modelError(reason) {
      invalidate(String(reason || "Model read unavailable"));
    },
    dispose() {
      disposed = true;
      queued = false;
      epoch++;
    },
  };
}
export function bindLiveSource(source: LiveSource, sync: LiveSync): void {
  const reconcile = (event: { data: string }) => {
    try {
      const data: { error?: string } = JSON.parse(event.data);
      if (data.error) sync.modelError(data.error);
    } catch { /* The reconciliation read validates the projection. */ }
    return sync.request();
  };
  source.addEventListener("model", reconcile);
  source.addEventListener("model-activity", reconcile);
  source.addEventListener("model-error", (event) => {
    let message = "Model read unavailable";
    try {
      const data: { error?: string; message?: string } = JSON.parse(event.data);
      message = data.message || data.error || message;
    } catch { /* Retain the explicit unavailable status. */ }
    sync.modelError(message);
  });
  source.onopen = () => sync.open();
  source.onerror = () => sync.disconnect();
}

export function graphSource(
  source: string,
): { path: string; historical: boolean } {
  const input = new URL(source, "https://workbench.invalid");
  const selectors = [...input.searchParams.keys()];
  if (
    input.origin !== "https://workbench.invalid" ||
    input.pathname !== "/api/model-graph" ||
    selectors.length > 1 ||
    selectors.some((key) => !["revision", "modelVersion"].includes(key)) ||
    input.hash
  ) {
    throw new Error("Invalid projection source");
  }
  return {
    path: input.pathname + input.search,
    historical: selectors.length > 0,
  };
}

type TransportRecord = Record<string, unknown>;
const transportRecord = (value: unknown): value is TransportRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const text = (value: unknown): value is string => typeof value === "string";
const oneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === "string" && choices.includes(value);
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text);
const referenceIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(identity);
const optional = (
  value: TransportRecord,
  keys: string[],
  validate: (field: unknown) => boolean,
): boolean =>
  keys.every((key) => value[key] === undefined || validate(value[key]));

/** Identity uniqueness is local to each scenario/session, never inferred from labels. */
function uniqueIds(records: unknown[]): boolean {
  const ids = new Set<string>();
  for (const record of records) {
    if (
      !transportRecord(record) || !identity(record.id) || ids.has(record.id)
    ) {
      return false;
    }
    ids.add(record.id);
  }
  return true;
}

function sequenceParticipant(value: unknown, observed: boolean): boolean {
  if (
    !transportRecord(value) || !identity(value.id) || !text(value.name) ||
    !optional(value, ["typeId", "typeName"], text) ||
    !optional(value, ["nativeId"], identity) ||
    value.origin !== undefined &&
      !oneOf(value.origin, ["native", "host", "external"])
  ) return false;
  if (!observed) return true;
  return text(value.typeId) && text(value.typeName) &&
    oneOf(value.origin, ["native", "host", "external"]) &&
    (value.origin !== "native" || value.nativeId === value.id);
}

function sequenceEvidence(value: unknown): boolean {
  return transportRecord(value) && referenceIds(value.nativeSourceIds) &&
    optional(value, ["messageId", "eventId"], identity) &&
    optional(value, ["sourceContextCount"], nonnegativeInteger);
}

function sequenceMessage(
  value: unknown,
  participants: Set<string>,
  observed: boolean,
): boolean {
  if (
    !transportRecord(value) || !identity(value.id) || !text(value.name) ||
    !identity(value.from) || !participants.has(value.from) ||
    !identity(value.to) || !participants.has(value.to) ||
    !optional(value, ["payloadId", "payloadName", "at"], text) ||
    !optional(value, [
      "recordId",
      "sourceEventId",
      "targetEventId",
      "eventKind",
      "actionId",
      "modelDigest",
      "repositoryVersion",
    ], identity) ||
    !optional(value, ["sourceIds"], referenceIds) ||
    !optional(value, ["evidence"], sequenceEvidence)
  ) return false;
  if (!observed) {
    return value.kind === undefined || value.kind === "message";
  }
  if (
    !oneOf(value.kind, ["message", "event"]) ||
    !text(value.at) || !identity(value.recordId) ||
    !text(value.payloadId) || !text(value.payloadName) ||
    !transportRecord(value.evidence) ||
    !referenceIds(value.evidence.nativeSourceIds) ||
    !nonnegativeInteger(value.evidence.sourceContextCount) ||
    !optional(value.evidence, ["messageId", "eventId"], identity)
  ) return false;
  // The projector may retain an invalid timestamp with a diagnostic. It must
  // remain a recorded string, not be replaced or silently removed at transport.
  if (value.kind === "event") {
    return value.from === value.to && identity(value.eventKind) &&
      value.evidence.eventId === value.recordId &&
      value.evidence.messageId === undefined &&
      (value.sourceEventId === undefined ||
        value.sourceEventId === value.recordId);
  }
  return value.evidence.messageId === value.recordId &&
    value.evidence.eventId === undefined;
}

function graphSequence(value: unknown, observed: boolean): boolean {
  if (
    !transportRecord(value) || !identity(value.id) || !text(value.name) ||
    !optional(value, ["doc", "qualifiedName"], text) ||
    !optional(value, ["nativeId"], identity) ||
    !optional(value, ["sourceIds"], referenceIds) ||
    !optional(value, ["diagnostics"], strings) ||
    value.ordering !== undefined && !oneOf(value.ordering, [
        "native-partial-order",
        "declaration",
        "cyclic",
        "non-linearizable",
      ]) ||
    !Array.isArray(value.lifelines) || !uniqueIds(value.lifelines) ||
    !value.lifelines.every((line) => sequenceParticipant(line, observed)) ||
    !Array.isArray(value.messages) || !uniqueIds(value.messages)
  ) return false;
  const participants = new Set(
    value.lifelines.map((line) => (line as TransportRecord).id as string),
  );
  if (
    !value.messages.every((message) =>
      sequenceMessage(message, participants, observed)
    )
  ) {
    return false;
  }
  if (!observed) return value.origin === undefined || value.origin === "native";
  if (
    value.origin !== "observed" || !nonnegativeInteger(value.revision) ||
    typeof value.busy !== "boolean" || !text(value.phase) ||
    !strings(value.diagnostics) || !nonnegativeInteger(value.total) ||
    !nonnegativeInteger(value.omitted) || value.limit !== 150 ||
    value.messages.length > value.limit ||
    value.total !== value.messages.length + value.omitted ||
    !optional(
      value,
      ["lastActivityAt"],
      (at) => text(at) && Number.isFinite(Date.parse(at)),
    )
  ) return false;
  const recordIds = value.messages.map((message) =>
    (message as TransportRecord).recordId
  );
  return new Set(recordIds).size === recordIds.length;
}

function graphSequences(value: unknown, observed: boolean): boolean {
  return Array.isArray(value) && uniqueIds(value) &&
    value.every((sequence) => graphSequence(sequence, observed));
}

/** Reject broken transport records before traversing native identities or edges. */
export function parseGraphSnapshot(value: unknown): GraphSnapshot {
  const object = (record: unknown): record is Record<string, unknown> =>
    Boolean(record && typeof record === "object" && !Array.isArray(record));
  if (
    !object(value) || !object(value.graph) ||
    typeof value.projectionDigest !== "string" ||
    !optional(value, ["activityDigest"], identity) ||
    value.projectionDigestScope !== undefined &&
      !oneOf(value.projectionDigestScope, ["native", "legacy-with-activity"]) ||
    typeof value.version !== "string" ||
    !(value.history === null || object(value.history) &&
        (typeof value.history.modelVersion === "string" ||
          Number.isSafeInteger(value.history.revision))) ||
    !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges) ||
    !value.graph.nodes.every((node) =>
      object(node) && typeof node.id === "string"
    ) ||
    !value.graph.edges.every((edge) =>
      object(edge) &&
      ["id", "source", "target", "kind"].every((key) =>
        typeof edge[key] === "string"
      )
    ) ||
    value.graph.views !== undefined && !Array.isArray(value.graph.views) ||
    value.graph.sequences !== undefined &&
      !graphSequences(value.graph.sequences, false) ||
    value.graph.executionSequences !== undefined &&
      !graphSequences(value.graph.executionSequences, true) ||
    value.graph.sequenceDiagnostics !== undefined &&
      !strings(value.graph.sequenceDiagnostics) ||
    value.error !== null && typeof value.error !== "string"
  ) {
    throw new Error("Invalid native projection");
  }
  return value as unknown as GraphSnapshot;
}

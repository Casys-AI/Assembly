import { signal } from "@preact/signals";
import type {
  ConversationsSnapshot,
  OperatorTool,
  OperatorToolsSnapshot,
} from "../../../../src/application/work/operators/conversation-types.ts";

export interface OperatorToolDecision {
  agentId: string;
  candidateId: string;
  candidateDigest: string;
  expectedRevision: number;
  verdict: "approve" | "refuse";
  reason: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const text = (value: unknown): value is string => typeof value === "string";
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
/** The reason a decision made in a conversation carries when none is typed. */
export const admissionReason = (verdict: "approve" | "refuse") =>
  verdict === "approve"
    ? "Admission explicitly approved in the system conversation."
    : "Admission explicitly refused in the system conversation.";
export const operatorToolKey = (
  tool: Pick<OperatorTool, "agentId" | "candidate">,
) => JSON.stringify([tool.agentId, tool.candidate.id]);

/** Read-only catalog descriptors: validate structure without interpreting their schemas. */
function objectInputSchema(schema: unknown): schema is Record<string, unknown> {
  if (
    !object(schema) || schema.type !== "object" || !object(schema.properties)
  ) return false;
  const properties = schema.properties;
  return Object.values(properties).every((property) =>
    object(property) && text(property.type) &&
    (property.description === undefined || text(property.description))
  ) && Array.isArray(schema.required) && schema.required.every((name) =>
    text(name) && Object.hasOwn(properties, name)
  );
}

/** The native network consultation has exactly two flat, closed input variants. */
function networkImpactInputSchema(schema: unknown): boolean {
  if (
    !object(schema) || Object.keys(schema).length !== 1 ||
    !Array.isArray(schema.oneOf) || schema.oneOf.length !== 2
  ) return false;
  const actions = new Set<string>();
  for (const branch of schema.oneOf) {
    if (
      !objectInputSchema(branch) || branch.additionalProperties !== false ||
      !object(branch.properties)
    ) return false;
    const properties = branch.properties;
    if (
      Object.keys(properties).length > 16 ||
      !Object.values(properties).every((property) =>
        object(property) &&
        text(property.type) && ["string", "integer"].includes(property.type) &&
        (property.const === undefined || text(property.const)) &&
        (property.pattern === undefined || text(property.pattern)) &&
        (property.enum === undefined ||
          Array.isArray(property.enum) && property.enum.length <= 16 &&
            property.enum.every(text)) &&
        ["minLength", "maxLength", "minimum", "maximum"].every((name) =>
          property[name] === undefined || revision(property[name])
        )
      )
    ) return false;
    if (
      !object(properties.operation) ||
      properties.operation.const !== "network_impact" ||
      !object(properties.action) || !text(properties.action.const) ||
      !["compare", "details"].includes(properties.action.const)
    ) return false;
    const required = branch.required as string[];
    if (
      required.length > 16 || new Set(required).size !== required.length ||
      !["operation", "version", "action"].every((name) =>
        required.includes(name)
      ) || actions.has(properties.action.const)
    ) return false;
    actions.add(properties.action.const);
  }
  return actions.size === 2;
}

/** Native catalog occurrences are unique by owner and candidate, not by label. */
export function parseOperatorToolsSnapshot(
  value: unknown,
): OperatorToolsSnapshot {
  const invalid = () => new Error("The operator catalog is unreadable.");
  if (
    !object(value) || !id(value.systemId) || !id(value.version) ||
    !Array.isArray(value.tools)
  ) throw invalid();
  const keys = new Set<string>();
  for (const entry of value.tools) {
    if (
      !object(entry) || !id(entry.agentId) || !text(entry.agentName) ||
      !revision(entry.revision) || !object(entry.candidate)
    ) throw invalid();
    const candidate = entry.candidate;
    if (
      !id(candidate.id) || !id(candidate.digest) || !text(candidate.name) ||
      !text(candidate.description) || !text(candidate.kind) ||
      !text(candidate.code) || !text(candidate.createdAt) ||
      !revision(candidate.baseCatalogRevision) || !text(candidate.stage) ||
      ![
        "proposed",
        "testing",
        "reviewing",
        "awaiting-admission",
        "refused",
        "activating",
        "active",
        "failed",
      ].includes(candidate.stage)
    ) throw invalid();
    if (
      candidate.requiredAuthority !== undefined &&
      (!text(candidate.requiredAuthority) ||
        !["human", "builder", "reviewer"].includes(candidate.requiredAuthority))
    ) throw invalid();
    if (candidate.error !== undefined && !text(candidate.error)) {
      throw invalid();
    }
    if (
      candidate.tests !== undefined &&
      (!object(candidate.tests) ||
        typeof candidate.tests.passed !== "boolean" ||
        !Array.isArray(candidate.tests.checks) ||
        !candidate.tests.checks.every((check) =>
          object(check) && text(check.name) && text(check.detail) &&
          typeof check.passed === "boolean"
        ))
    ) throw invalid();
    if (
      candidate.review !== undefined &&
      (!object(candidate.review) || !id(candidate.review.candidateDigest) ||
        !text(candidate.review.reason) ||
        !text(candidate.review.verdict) ||
        !["approve", "refuse"].includes(candidate.review.verdict))
    ) throw invalid();
    if (
      candidate.admission !== undefined &&
      (!object(candidate.admission) || !text(candidate.admission.reason) ||
        !text(candidate.admission.authority) ||
        !["human", "builder", "reviewer", "delegate"].includes(
          candidate.admission.authority,
        ))
    ) throw invalid();
    const key = JSON.stringify([entry.agentId, candidate.id]);
    if (keys.has(key)) throw invalid();
    keys.add(key);
  }
  if (value.modelTools !== undefined) {
    if (!Array.isArray(value.modelTools)) throw invalid();
    const modelKeys = new Set<string>();
    for (const entry of value.modelTools) {
      if (
        !object(entry) || !id(entry.agentId) || !text(entry.agentName) ||
        !object(entry.tool)
      ) throw invalid();
      const tool = entry.tool;
      if (
        !id(tool.id) || !text(tool.name) || !text(tool.description) ||
        !text(tool.operation) || ![
          "search",
          "inspect",
          "references",
          "read_source",
          "unload_sources",
          "query",
          "network_impact",
        ].includes(tool.operation) ||
        !(tool.operation === "network_impact"
          ? networkImpactInputSchema(tool.inputSchema)
          : objectInputSchema(tool.inputSchema))
      ) throw invalid();
      const key = JSON.stringify([entry.agentId, tool.id]);
      if (modelKeys.has(key)) throw invalid();
      modelKeys.add(key);
    }
  }
  return value as unknown as OperatorToolsSnapshot;
}

export function createOperatorTools(options: {
  currentSystemId(): string | null;
  canWrite(): boolean;
  conversations(): ConversationsSnapshot | null;
  port?: {
    read(): Promise<OperatorToolsSnapshot | null>;
    decide(command: OperatorToolDecision): Promise<{ accepted: boolean }>;
  };
}) {
  const snapshot = signal<OperatorToolsSnapshot | null>(null);
  const error = signal("");
  const loading = signal(false);
  const stale = signal(true);
  const pendingKeys = signal<string[]>([]);
  let lifecycle = 0, generation = 0, readFailed = false;
  let flight: Promise<void> | null = null;
  let queued = false, lastInvalidation = "";
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  function accept(value: unknown) {
    const next = parseOperatorToolsSnapshot(value);
    const changedSystem = snapshot.peek()?.systemId !== next.systemId;
    generation++;
    snapshot.value = next;
    stale.value = false;
    if (readFailed || changedSystem) error.value = "";
    if (changedSystem) pendingKeys.value = [];
    readFailed = false;
  }
  function refresh(): Promise<void> {
    clearTimeout(scheduled);
    scheduled = undefined;
    if (!options.port) return Promise.resolve();
    queued = true;
    if (flight) return flight;
    const requestLifecycle = lifecycle;
    loading.value = true;
    const task = (async () => {
      do {
        queued = false;
        const requestedGeneration = generation;
        try {
          const next = await options.port!.read();
          if (requestLifecycle !== lifecycle) return;
          if (requestedGeneration === generation) {
            if (next) accept(next);
            else if (!snapshot.peek()) stale.value = false;
          }
        } catch (cause) {
          if (
            requestLifecycle === lifecycle && requestedGeneration === generation
          ) {
            error.value = cause instanceof Error
              ? cause.message
              : "Catalogue unavailable.";
            readFailed = true;
            stale.value = true;
          }
        }
      } while (queued && requestLifecycle === lifecycle);
    })().finally(() => {
      if (flight === task) flight = null;
      if (requestLifecycle === lifecycle) loading.value = false;
    });
    flight = task;
    return task;
  }
  function invalidate(systemId: string, version: string) {
    const key = JSON.stringify([systemId, version]);
    if (lastInvalidation === key) return;
    lastInvalidation = key;
    generation++;
    stale.value = true;
    if (!options.port) return;
    // One event-driven read per short burst; no interval or additional stream.
    scheduled ??= setTimeout(() => {
      scheduled = undefined;
      void refresh();
    }, 80);
  }
  function canDecide(tool: OperatorTool) {
    const current = snapshot.value;
    const key = operatorToolKey(tool);
    if (
      !current || current.systemId !== options.currentSystemId() ||
      !options.canWrite() || loading.value || stale.value ||
      pendingKeys.value.includes(key)
    ) return false;
    const exact = current.tools.find((entry) => operatorToolKey(entry) === key);
    if (
      !exact || exact.revision !== tool.revision ||
      exact.candidate.digest !== tool.candidate.digest ||
      exact.candidate.stage !== "awaiting-admission" ||
      exact.candidate.requiredAuthority !== "human"
    ) return false;
    const owner = options.conversations()?.conversations.find((entry) =>
      entry.agentId === exact.agentId
    );
    return !owner || !owner.busy && owner.revision === exact.revision;
  }
  async function decide(
    tool: OperatorTool,
    verdict: "approve" | "refuse",
    reason?: string,
  ) {
    if (!options.port || !canDecide(tool)) return false;
    const requestLifecycle = lifecycle, key = operatorToolKey(tool);
    const requestSystemId = snapshot.peek()!.systemId;
    pendingKeys.value = [...pendingKeys.peek(), key];
    error.value = "";
    try {
      const acknowledgement = await options.port.decide({
        agentId: tool.agentId,
        candidateId: tool.candidate.id,
        candidateDigest: tool.candidate.digest,
        expectedRevision: tool.revision,
        verdict,
        reason: reason || admissionReason(verdict),
      });
      if (!acknowledgement.accepted) {
        throw new Error("The decision was not confirmed.");
      }
      if (
        requestLifecycle !== lifecycle ||
        requestSystemId !== options.currentSystemId()
      ) return true;
      stale.value = true;
      await refresh();
      return true;
    } catch (cause) {
      if (
        requestLifecycle === lifecycle &&
        requestSystemId === options.currentSystemId()
      ) {
        error.value = cause instanceof Error
          ? cause.message
          : "Decision not confirmed.";
        // Reconcile the owner's CAS state without retrying the command.
        stale.value = true;
        await refresh();
      }
      return false;
    } finally {
      if (
        requestLifecycle === lifecycle &&
        requestSystemId === options.currentSystemId()
      ) {
        pendingKeys.value = pendingKeys.peek().filter((pending) =>
          pending !== key
        );
      }
    }
  }
  function dispose() {
    lifecycle++;
    clearTimeout(scheduled);
    scheduled = undefined;
    flight = null;
    queued = false;
    loading.value = false;
    pendingKeys.value = [];
    lastInvalidation = "";
  }
  return {
    snapshot,
    error,
    loading,
    stale,
    pendingKeys,
    accept,
    refresh,
    invalidate,
    canDecide,
    decide,
    dispose,
  };
}

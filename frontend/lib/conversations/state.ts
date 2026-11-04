import { batch, computed, type Signal, signal } from "@preact/signals";
import type {
  AgentConversation,
  AgentMessageCommand,
  ConversationsSnapshot,
} from "../../../src/domain/work/records/conversations.ts";
import { readEvolutionRecord } from "./evolution.ts";
import { retryOnceAfterStale, sendErrorMessage } from "../api-error.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Reject ambiguous identities before using a record to select a command target. */
export function parseConversationsSnapshot(
  value: unknown,
): ConversationsSnapshot {
  const invalid = () => new Error("The conversations received are unreadable.");
  if (
    !object(value) || !identity(value.systemId) || !identity(value.version) ||
    !identity(value.defaultAgentId) || !Array.isArray(value.conversations)
  ) throw invalid();
  const agents = new Set<string>(), nativeIds = new Set<string>();
  for (const conversation of value.conversations) {
    if (
      !object(conversation) || !identity(conversation.agentId) ||
      !identity(conversation.nativeId) || agents.has(conversation.agentId) ||
      nativeIds.has(conversation.nativeId) ||
      typeof conversation.name !== "string" ||
      typeof conversation.responsibility !== "string" ||
      typeof conversation.primary !== "boolean" ||
      typeof conversation.canSend !== "boolean" ||
      !revision(conversation.revision) ||
      typeof conversation.busy !== "boolean" ||
      typeof conversation.phase !== "string" ||
      conversation.initialExecutionOutcome !== undefined &&
        conversation.initialExecutionOutcome !== "refused" ||
      typeof conversation.modelDigest !== "string" ||
      conversation.readOnlyReason !== undefined &&
        typeof conversation.readOnlyReason !== "string" ||
      conversation.repositoryVersion !== undefined &&
        !identity(conversation.repositoryVersion) ||
      conversation.designerScopeId !== undefined &&
        !identity(conversation.designerScopeId) ||
      !Array.isArray(conversation.messages)
    ) throw invalid();
    if (conversation.operatorTeam !== undefined) {
      const team = conversation.operatorTeam;
      if (
        !object(team) ||
        !["parentOperatorId", "requestOwnerId", "requestId"].every((key) =>
          identity(team[key])
        ) ||
        team.creationPolicyId !== undefined && !identity(team.creationPolicyId)
      ) throw invalid();
    }
    agents.add(conversation.agentId);
    nativeIds.add(conversation.nativeId);
    const messages = new Set<string>();
    for (const message of conversation.messages) {
      if (
        !object(message) || !identity(message.id) || messages.has(message.id) ||
        !["user", "assistant", "tool"].includes(String(message.role)) ||
        typeof message.role !== "string" || typeof message.text !== "string" ||
        typeof message.at !== "string"
      ) throw invalid();
      if (message.work !== undefined) {
        const work = message.work;
        if (
          !object(work) ||
          ![
            "callerId",
            "correlationId",
            "invocationId",
            "behaviorId",
            "targetNativeId",
          ].every((key) => identity(work[key])) || !object(work.modelVersion) ||
          !identity(work.modelVersion.digest) ||
          !identity(work.modelVersion.repositoryVersion)
        ) throw invalid();
      }
      messages.add(message.id);
    }
  }
  if (!agents.has(value.defaultAgentId)) throw invalid();
  if (value.evolutions !== undefined) {
    const projection = value.evolutions;
    if (
      !object(projection) || !identity(projection.version) ||
      typeof projection.truncated !== "boolean" ||
      (projection.error !== undefined &&
        typeof projection.error !== "string") ||
      !Array.isArray(projection.items) ||
      projection.items.length > 64 || projection.items.some((record) =>
        !readEvolutionRecord(record)
      ) ||
      new Set(projection.items.map((record) => record.dossierId)).size !==
        projection.items.length
    ) throw invalid();
  }
  return value as unknown as ConversationsSnapshot;
}

/**
 * Whether an agent can take a human message. An operator without a general
 * human entry still continues an open Request it owns: the host checks that
 * Request, so a message naming one is only offered to a runtime-owned agent.
 */
export function takesHumanMessage(
  agent: Pick<AgentConversation, "canSend" | "runtimeOwned">,
  caseId?: string | null,
): boolean {
  return agent.canSend ||
    typeof caseId === "string" && agent.runtimeOwned === true;
}

/** The earliest readable message time, or Infinity for a silent thread. */
function firstMessageAt(conversation: AgentConversation): number {
  return Math.min(
    ...conversation.messages.map((message) => Date.parse(message.at))
      .filter(Number.isFinite),
  );
}

interface ConversationPort {
  read(): Promise<ConversationsSnapshot | null>;
  send(command: AgentMessageCommand): Promise<{ accepted: boolean }>;
}

/** Agent selection is local; source-owned contact rights stay in the read model. */
export function createAgentConversations(options: {
  draft: Signal<string>;
  canWrite(): boolean;
  currentSystemId?(): string | null;
  onAccepted?(snapshot: ConversationsSnapshot): void;
  port?: ConversationPort;
}) {
  const snapshot = signal<ConversationsSnapshot | null>(null);
  const selectedAgentId = signal<string | null>(null);
  const pinnedAgentIds = signal<string[]>([]);
  /** Arrival rank of each conversation, fixed once when it first appears. */
  const arrivals = signal(new Map<string, number>());
  let arrivalRank = 0;
  const pendingAgentIds = signal<string[]>([]);
  const readError = signal("");
  const writeErrors = signal(new Map<string, string>());
  const loading = signal(false);
  const selected = computed(() =>
    snapshot.value?.conversations.find((entry) =>
      entry.agentId === selectedAgentId.value
    ) || null
  );
  /**
   * Whether a human message to this exact agent would be accepted now; with a
   * `caseId`, a message continuing that Request.
   */
  function targetCanSend(
    agentId: string | null | undefined,
    caseId?: string | null,
  ): boolean {
    const current = snapshot.value;
    const agent = current?.conversations.find((entry) =>
      entry.agentId === agentId
    );
    return Boolean(
      agent && takesHumanMessage(agent, caseId) && !agent.busy &&
        (!options.currentSystemId ||
          current?.systemId === options.currentSystemId()) &&
        !readError.value && options.canWrite(),
    );
  }
  function canSendTo(
    agentId: string | null | undefined,
    caseId?: string | null,
  ): boolean {
    return !pendingAgentIds.value.includes(agentId ?? "") &&
      targetCanSend(agentId, caseId);
  }
  const canSend = computed(() => canSendTo(selectedAgentId.value));
  // One draft per agent, whichever panel shows it; the selected agent's draft
  // lives in the shared composer signal, every other one here.
  const drafts = signal(new Map<string, string>());
  function storeDraft(draftKey: string, text: string) {
    if ((drafts.peek().get(draftKey) ?? "") === text) return;
    drafts.value = new Map(drafts.peek()).set(draftKey, text);
  }
  const key = (
    source: ConversationsSnapshot | null,
    agent: AgentConversation | null,
  ) =>
    source && agent
      ? JSON.stringify([source.systemId, agent.nativeId])
      : "legacy";
  const currentKey = () => key(snapshot.peek(), selected.peek());
  const agentOf = (source: ConversationsSnapshot | null, agentId: string) =>
    source?.conversations.find((entry) => entry.agentId === agentId) ?? null;
  /** The draft for this exact agent, in the central or a side panel alike. */
  function draftFor(agentId: string): string {
    const agent = agentOf(snapshot.value, agentId);
    if (!agent) return "";
    if (agentId === selectedAgentId.value) return options.draft.value;
    return drafts.value.get(key(snapshot.value, agent)) ?? "";
  }
  function setDraft(agentId: string, text: string) {
    const agent = agentOf(snapshot.peek(), agentId);
    if (!agent) return;
    if (agentId === selectedAgentId.peek()) options.draft.value = text;
    else storeDraft(key(snapshot.peek(), agent), text);
  }
  /** The read error, or the last unconfirmed send to this exact agent. */
  function errorFor(agentId: string | null | undefined): string {
    const agent =
      snapshot.value?.conversations.find((entry) =>
        entry.agentId === agentId
      ) ?? null;
    return [writeErrors.value.get(key(snapshot.value, agent)), readError.value]
      .filter(Boolean).join(" ");
  }
  const error = computed(() => errorFor(selectedAgentId.value));
  function writeError(key: string, message: string) {
    const next = new Map(writeErrors.peek());
    if (message) next.set(key, message);
    else next.delete(key);
    writeErrors.value = next;
  }
  let lifecycle = 0, generation = 0;
  let flight: Promise<void> | null = null;
  let queued = false;

  function accept(value: unknown) {
    const next = parseConversationsSnapshot(value);
    const previous = snapshot.peek();
    const oldKey = currentKey();
    storeDraft(oldKey, options.draft.peek());
    const sameSystem = previous?.systemId === next.systemId;
    // The contact point is followed when it moves; another explicit choice stays.
    const candidateId =
      sameSystem && selectedAgentId.peek() !== previous?.defaultAgentId
        ? selectedAgentId.peek()
        : null;
    const nextId =
      next.conversations.some((entry) => entry.agentId === candidateId)
        ? candidateId!
        : next.defaultAgentId;
    generation++;
    const present = new Set(next.conversations.map((entry) => entry.agentId));
    const seen = new Map(
      [...(sameSystem ? arrivals.peek() : [])].filter(([id]) =>
        present.has(id)
      ),
    );
    // Newcomers of one read are ranked once, by first message then catalogue.
    next.conversations
      .map((entry, index) => ({ entry, index, at: firstMessageAt(entry) }))
      .filter(({ entry }) => !seen.has(entry.agentId))
      .sort((a, b) => (a.at - b.at) || a.index - b.index)
      .forEach(({ entry }) => seen.set(entry.agentId, ++arrivalRank));
    batch(() => {
      snapshot.value = next;
      selectedAgentId.value = nextId;
      arrivals.value = seen;
      const newKey = currentKey();
      if (newKey !== oldKey) {
        // Until the first catalogue read, the existing composer addresses the
        // default conversation. Its in-progress draft must survive that read.
        if (
          !previous && !drafts.peek().has(newKey) &&
          (!options.currentSystemId ||
            next.systemId === options.currentSystemId())
        ) {
          storeDraft(newKey, options.draft.peek());
        }
        options.draft.value = drafts.peek().get(newKey) || "";
      }
      if (!sameSystem) pinnedAgentIds.value = [next.defaultAgentId];
      else {
        const available = new Set(
          next.conversations.map((entry) => entry.agentId),
        );
        pinnedAgentIds.value = pinnedAgentIds.peek().filter((id) =>
          available.has(id)
        );
      }
      readError.value = "";
    });
    options.onAccepted?.(next);
  }

  function select(agentId: string) {
    if (
      !snapshot.peek()?.conversations.some((entry) =>
        entry.agentId === agentId
      ) ||
      agentId === selectedAgentId.peek()
    ) return;
    storeDraft(currentKey(), options.draft.peek());
    batch(() => {
      selectedAgentId.value = agentId;
      options.draft.value = drafts.peek().get(currentKey()) || "";
    });
  }

  function restorePins(value: unknown) {
    if (!Array.isArray(value) || !value.every(identity)) return;
    const available = new Set(
      snapshot.peek()?.conversations.map((entry) => entry.agentId),
    );
    pinnedAgentIds.value = [...new Set(value)].filter((id) =>
      available.has(id)
    );
  }
  function togglePin(agentId: string) {
    if (
      !snapshot.peek()?.conversations.some((entry) => entry.agentId === agentId)
    ) return;
    pinnedAgentIds.value = pinnedAgentIds.peek().includes(agentId)
      ? pinnedAgentIds.peek().filter((id) => id !== agentId)
      : [...pinnedAgentIds.peek(), agentId];
  }

  function refresh(): Promise<void> {
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
          if (next && requestedGeneration === generation) accept(next);
        } catch (cause) {
          if (
            requestLifecycle === lifecycle && requestedGeneration === generation
          ) {
            readError.value = cause instanceof Error
              ? cause.message
              : "Conversations unavailable.";
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

  async function sendTo(
    agentId: string,
    text: string,
    clearDraft = false,
    caseId?: string | null,
  ): Promise<boolean> {
    const current = snapshot.peek();
    const agent = current?.conversations.find((entry) =>
      entry.agentId === agentId
    );
    if (
      !options.port || !agent || !canSendTo(agentId, caseId) || !text.trim()
    ) {
      return false;
    }
    const submittedKey = key(current, agent);
    const submitted = submittedKey === currentKey()
      ? options.draft.peek()
      : drafts.peek().get(submittedKey) ?? "";
    const requestLifecycle = lifecycle;
    pendingAgentIds.value = [...pendingAgentIds.peek(), agent.agentId];
    writeError(submittedKey, "");
    try {
      const acknowledgement = await retryOnceAfterStale(
        (target: AgentConversation = agent) =>
          options.port!.send({
            agentId: target.agentId,
            text: text.trim(),
            expectedRevision: target.revision,
            // A named Case continues that Request; `null` opens a new one.
            ...(typeof caseId === "string"
              ? { caseId }
              : caseId === null
              ? { newConversation: true as const }
              : {}),
          }),
        async () => {
          const beforeRead = snapshot.peek();
          await refresh();
          const fresh = agentOf(snapshot.peek(), agentId);
          return snapshot.peek() !== beforeRead &&
              key(snapshot.peek(), fresh) === submittedKey &&
              targetCanSend(agentId, caseId)
            ? fresh
            : null;
        },
      );
      if (!acknowledgement.accepted) {
        throw new Error("The message was not confirmed.");
      }
      if (requestLifecycle !== lifecycle) return true;
      if (clearDraft && currentKey() === submittedKey) {
        if (options.draft.peek() === submitted) options.draft.value = "";
      } else if (
        clearDraft && (drafts.peek().get(submittedKey) ?? "") === submitted
      ) {
        storeDraft(submittedKey, "");
      }
      await refresh();
      return true;
    } catch (cause) {
      if (requestLifecycle === lifecycle) {
        writeError(
          submittedKey,
          sendErrorMessage(cause, "Message not confirmed."),
        );
      }
      return false;
    } finally {
      if (requestLifecycle === lifecycle) {
        pendingAgentIds.value = pendingAgentIds.peek().filter((id) =>
          id !== agent.agentId
        );
      }
    }
  }

  function send(
    text = options.draft.peek(),
    caseId?: string | null,
  ): Promise<boolean> {
    const agentId = selected.peek()?.agentId;
    // Only the designer's conversation owns the shared draft.
    return agentId
      ? sendTo(agentId, text, caseId === undefined, caseId)
      : Promise.resolve(false);
  }

  function dispose() {
    lifecycle++;
    queued = false;
    flight = null;
    loading.value = false;
    pendingAgentIds.value = [];
  }
  return {
    snapshot,
    selectedAgentId,
    selected,
    pinnedAgentIds,
    arrivals,
    pendingAgentIds,
    canSend,
    canSendTo,
    draftFor,
    setDraft,
    error,
    errorFor,
    loading,
    accept,
    select,
    restorePins,
    togglePin,
    refresh,
    send,
    sendTo,
    dispose,
  };
}

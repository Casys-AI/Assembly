import { isCaseChangeDecision } from "../conversations/case-change.ts";
import {
  isReleaseCatalogueInvalidation,
  RELEASE_CATALOGUE_INVALIDATED,
} from "../../../src/application/work/saved-systems/notifications.ts";
import {
  isProviderResourceInvalidation,
  PROVIDER_RESOURCES_INVALIDATED,
} from "../../../src/application/telemetry/provider-resource-notifications.ts";
import { createRequests } from "../requests/requests.ts";
import { batch, computed, signal } from "@preact/signals";
import type { SystemRuntimeState } from "../../../src/domain/work/dialogue.ts";
import type { ProjectionSnapshot } from "../../../src/domain/work/history.ts";
import { createWorkbenchApi } from "./api.ts";
import { createAgentConversations } from "../conversations/state.ts";
import { createDecisionLock } from "../model/sources/command.ts";
import { type CasesPort, createCases, createCasesApi } from "../cases/cases.ts";
import { createPins } from "./pins.ts";
import { createCaseSeen } from "../cases/seen.ts";
import { createModelLive, type ModelLive, modelLive } from "../model/live.ts";
import {
  CASE_MODEL_VERSION,
  type CaseModelVersion,
  isCaseModelVersion,
} from "../../../src/application/work/request-spaces/case-model-notifications.ts";
import {
  admissionReason,
  createOperatorTools,
  operatorToolKey,
} from "../system/tools/decisions.ts";
import {
  aggregatePendingDecisions,
  aggregateRequestDecisions,
  createPendingProposals,
} from "../decide/pending.ts";
import {
  type ChatProposalApi,
  createChatProposalApi,
  createChatProposals,
  operatorsIdle,
} from "../conversations/proposals.ts";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import type {
  CaseChangeStatus,
  DecisionCommand,
  Fetcher,
  HistoryEntry,
  Verdict,
  WorkbenchApi,
} from "./api.ts";

export interface WorkbenchEventSource {
  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void;
  close(): void;
}
export interface WorkbenchOptions {
  api?: WorkbenchApi;
  fetch?: Fetcher;
  eventSourceFactory?: (path: string) => WorkbenchEventSource;
  initialState?: SystemRuntimeState | null;
  proposalApi?: ChatProposalApi;
  casesPort?: CasesPort;
}
export type GraphSourceSelection = { modelVersion: string };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isState = (value: unknown): value is SystemRuntimeState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SystemRuntimeState>;
  return Number.isSafeInteger(state.revision) && Number(state.revision) >= 0 &&
    Array.isArray(state.messages) && Array.isArray(state.candidates);
};

/** One store per mounted workbench; construction is safe during server rendering. */
export function createWorkbenchState(options: WorkbenchOptions = {}) {
  const api = options.api ?? createWorkbenchApi(options.fetch);
  const current = signal<SystemRuntimeState | null>(
    options.initialState ?? null,
  );
  const draft = signal("");
  const performanceGeneration = signal(0);
  const releaseCatalogueGeneration = signal(0);
  const connection = signal<"connecting" | "live" | "reconnecting" | "closed">(
    "connecting",
  );
  const pending = signal(false);
  const loading = signal(!current.value);
  const localError = signal("");
  const historyEntries = signal<HistoryEntry[]>([]);
  const historyLoading = signal(false);
  const historyError = signal("");
  const selectedRevision = signal<number | null>(null);
  const inspected = signal<SystemRuntimeState | null>(null);
  const historicalProjection = signal<ProjectionSnapshot | null>(null);
  const historicalLoading = signal(false);
  const graphSourceSelection = signal<GraphSourceSelection | null>(null);
  const readOnly = computed(() => selectedRevision.value !== null);
  const displayed = computed(() =>
    readOnly.value ? inspected.value : current.value
  );
  const canAct = computed(() =>
    Boolean(current.value) && !current.value?.busy &&
    !pending.value && !readOnly.value
  );
  const decisionProposals = createPendingProposals({
    systemId: () => current.value?.id || null,
    read: async (signal) => {
      const response = await (options.fetch ?? fetch)("/api/model-revisions", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Model proposals could not be loaded.");
      return await response.json();
    },
  });
  // Cases pinned to the left of the Dock, per system and per viewer.
  const pins = createPins();
  // What the viewer has already seen of each Case, per system.
  const caseSeen = createCaseSeen();
  const cases = createCases({
    port: options.casesPort ?? createCasesApi(options.fetch),
  });
  const requests = createRequests({ fetch: options.fetch });
  // One "decision in flight" lock for every decision command of the workbench.
  const decisionLock = createDecisionLock();
  const agentConversations = createAgentConversations({
    draft,
    canWrite: () => !readOnly.value && !pending.value,
    currentSystemId: () => current.value?.id || null,
    onAccepted: (snapshot) => {
      if (source) {
        operatorTools.invalidate(snapshot.systemId, snapshot.version);
        decisionProposals.invalidate();
      }
    },
    ...(api.readConversations && api.sendAgentMessage
      ? { port: { read: api.readConversations, send: api.sendAgentMessage } }
      : {}),
  });
  const operatorTools = createOperatorTools({
    currentSystemId: () => current.value?.id || null,
    canWrite: () => !readOnly.value && !pending.value,
    conversations: () => agentConversations.snapshot.value,
    ...(api.readOperatorTools && api.decideOperatorTool
      ? {
        port: { read: api.readOperatorTools, decide: api.decideOperatorTool },
      }
      : {}),
  });
  const visibleOperatorTools = computed(() =>
    !readOnly.value &&
      operatorTools.snapshot.value?.systemId === current.value?.id
      ? operatorTools.snapshot.value
      : null
  );
  const chatProposals = createChatProposals({
    api: options.proposalApi ?? createChatProposalApi(options.fetch),
    systemId: () => current.value?.id || null,
    canWrite: () => canAct.value,
    canAdopt: () =>
      operatorsIdle(agentConversations.snapshot.value?.conversations),
    afterChange: async () => {
      await Promise.all([
        refresh(),
        refreshPendingDecisions(),
      ]);
    },
    lock: decisionLock,
  });
  /** The shared gate of every decision control: writable and nothing in flight. */
  const decisionsOpen = computed(() =>
    !readOnly.value && !pending.value && !chatProposals.inFlight.value
  );
  /** Tool admissions go through the shared lock like every other decision. */
  function decideOperatorTool(
    owner: Parameters<typeof operatorTools.decide>[0],
    verdict: Verdict,
    reason?: string,
  ) {
    if (!decisionsOpen.peek()) return Promise.resolve(false);
    return decisionLock.track(async () => {
      const decided = await operatorTools.decide(owner, verdict, reason);
      // A confirmed tool decision writes the shared sources: stale every thread
      // before the lock opens, as revision decisions do.
      if (decided) void chatProposals.invalidate();
      return decided;
    });
  }
  let caseFenceVersion = 0;
  let caseFenceSystem = current.peek()?.id;
  const releaseCaseFences = [
    requests.context.subscribe(() => {
      caseFenceVersion++;
    }),
    requests.sessionReady.subscribe(() => {
      caseFenceVersion++;
    }),
    requests.sessionGeneration.subscribe(() => {
      caseFenceVersion++;
    }),
    current.subscribe((value) => {
      if (value?.id !== caseFenceSystem) {
        caseFenceSystem = value?.id;
        caseFenceVersion++;
      }
    }),
  ];
  const pendingChanges = signal<string[]>([]);
  const caseChangeStatuses = signal(
    new Map<string, { value: CaseChangeStatus; stamp: string }>(),
  );
  const caseChangeErrors = signal(
    new Map<string, { message: string; stamp: string }>(),
  );
  const changeKey = (caseId: string, agentId: string, changeId: string) =>
    JSON.stringify([caseId, agentId, changeId]);
  const caseStatusReads = new Map<string, number>();
  const invalidateCaseStatusReads = (key: string) => {
    const next = (caseStatusReads.get(key) ?? 0) + 1;
    caseStatusReads.set(key, next);
    return next;
  };
  const caseStamp = () =>
    JSON.stringify([
      epoch,
      caseFenceVersion,
      current.peek()?.id ?? null,
      requests.context.peek(),
      requests.sessionGeneration.peek(),
      requests.sessionReady.peek(),
    ]);
  const validCaseStatus = (
    value: CaseChangeStatus,
    caseId: string,
    changeId: string,
  ) =>
    value && value.caseId === caseId && value.changeId === changeId &&
    typeof value.canResume === "boolean" &&
    [
      "pending",
      "decision-recorded",
      "publication-pending",
      "published-awaiting-adoption",
      "adopted",
      "refused-awaiting-continuation",
      "refused",
      "blocked",
    ].includes(value.status);
  const caseChangeStatus = (
    caseId: string,
    agentId: string,
    changeId: string,
  ) => {
    const item = caseChangeStatuses.value.get(
      changeKey(caseId, agentId, changeId),
    );
    return item?.stamp === caseStamp() ? item.value : undefined;
  };
  const caseChangeError = (
    caseId: string,
    agentId: string,
    changeId: string,
  ) => {
    const item = caseChangeErrors.value.get(
      changeKey(caseId, agentId, changeId),
    );
    return item?.stamp === caseStamp() ? item.message : "";
  };
  async function loadCaseChangeStatus(
    caseId: string,
    agentId: string,
    changeId: string,
  ) {
    if (!api.readCaseChangeStatus || !requests.sessionReady.peek()) return;
    const stamp = caseStamp(), key = changeKey(caseId, agentId, changeId);
    const read = invalidateCaseStatusReads(key);
    const currentRead = () =>
      stamp === caseStamp() && caseStatusReads.get(key) === read;
    try {
      const value = await api.readCaseChangeStatus(agentId, changeId, caseId);
      if (!currentRead()) return;
      if (!validCaseStatus(value, caseId, changeId)) {
        throw new Error("The decision status is unavailable.");
      }
      caseChangeStatuses.value = new Map(caseChangeStatuses.peek()).set(key, {
        value,
        stamp,
      });
      const errors = new Map(caseChangeErrors.peek());
      errors.delete(key);
      caseChangeErrors.value = errors;
    } catch (cause) {
      if (!currentRead()) return;
      const statuses = new Map(caseChangeStatuses.peek());
      statuses.delete(key);
      caseChangeStatuses.value = statuses;
      caseChangeErrors.value = new Map(caseChangeErrors.peek()).set(key, {
        message: messageOf(cause),
        stamp,
      });
    }
  }
  async function resumeCaseChange(
    caseId: string,
    agentId: string,
    changeId: string,
  ) {
    const key = changeKey(caseId, agentId, changeId), stamp = caseStamp();
    const status = caseChangeStatus(caseId, agentId, changeId);
    if (
      !api.resumeCaseChange || !status?.canResume ||
      ![
        "decision-recorded",
        "publication-pending",
        "published-awaiting-adoption",
        "blocked",
        "refused-awaiting-continuation",
      ].includes(status.status) || !requests.sessionReady.peek() ||
      !decisionsOpen.peek() || pendingChanges.peek().includes(key)
    ) return false;
    pendingChanges.value = [...pendingChanges.peek(), key];
    invalidateCaseStatusReads(key);
    try {
      const value = await decisionLock.track(() =>
        api.resumeCaseChange!(agentId, changeId, caseId)
      );
      if (stamp !== caseStamp()) return false;
      invalidateCaseStatusReads(key);
      if (!validCaseStatus(value, caseId, changeId)) {
        throw new Error("The decision outcome is unknown.");
      }
      caseChangeStatuses.value = new Map(caseChangeStatuses.peek()).set(key, {
        value,
        stamp,
      });
      await Promise.all([
        requests.refresh(caseId),
        requests.refreshScope(caseId),
      ]);
      if (stamp !== caseStamp()) return false;
      await loadCaseChangeStatus(caseId, agentId, changeId);
      return stamp === caseStamp();
    } catch (cause) {
      if (stamp === caseStamp()) {
        invalidateCaseStatusReads(key);
        caseChangeErrors.value = new Map(caseChangeErrors.peek()).set(key, {
          message: messageOf(cause),
          stamp,
        });
        await Promise.all([
          requests.refresh(caseId),
          requests.refreshScope(caseId),
        ]);
        if (stamp === caseStamp()) {
          await loadCaseChangeStatus(caseId, agentId, changeId);
        }
      }
      return false;
    } finally {
      pendingChanges.value = pendingChanges.peek().filter((item) =>
        item !== key
      );
    }
  }
  const changeError = signal("");
  const caseChangeResult = signal<
    { caseId: string; agentId: string; message: string; stamp: string } | null
  >(null);
  const caseChangeNotice = (caseId: string, agentId: string) => {
    const result = caseChangeResult.value;
    return result?.caseId === caseId && result.agentId === agentId &&
        result.stamp === caseStamp()
      ? result.message
      : "";
  };
  async function decideOperatorChange(
    conversation: AgentConversation,
    changeId: string,
    verdict: Verdict,
    caseId?: string,
  ) {
    const key = JSON.stringify([
      caseId ?? null,
      conversation.agentId,
      changeId,
    ]);
    const exact =
      (caseId
        ? requests.snapshots.value.get(caseId)
        : conversationSnapshot.value)?.conversations.find((entry) =>
          entry.agentId === conversation.agentId
        );
    const context = exact?.proposalContext;
    const change = context?.changes.find((entry) => entry.id === changeId);
    if (
      !api.decideOperatorChange || !decisionsOpen.peek() || !exact ||
      exact.busy ||
      exact.revision !== conversation.revision || !context ||
      context.configurationRevision !==
        conversation.proposalContext?.configurationRevision ||
      change?.status !== "pending" ||
      (caseId !== undefined &&
        !isCaseChangeDecision(change, caseId, conversation.agentId)) ||
      JSON.stringify(change) !== JSON.stringify(
          conversation.proposalContext?.changes.find((entry) =>
            entry.id === changeId
          ),
        ) ||
      (verdict === "approve" &&
        change.baseRevision !== context.configurationRevision) ||
      pendingChanges.value.includes(key)
    ) return false;
    pendingChanges.value = [...pendingChanges.value, key];
    changeError.value = "";
    caseChangeResult.value = null;
    const stamp = caseId ? caseStamp() : "";
    if (caseId) invalidateCaseStatusReads(key);
    try {
      const result = await decisionLock.track(async () => {
        const outcome = await api.decideOperatorChange!({
          agentId: conversation.agentId,
          changeId,
          ...(caseId ? { caseId } : {}),
          verdict,
          expectedRevision: conversation.revision,
          configurationRevision: change.baseRevision,
        });
        // A confirmed mandate decision changes the sources: advance the shared
        // generation before the lock opens, so no thread acts on the old one.
        if (!caseId && outcome.accepted) void chatProposals.invalidate();
        return outcome;
      });
      if (caseId) {
        if (stamp !== caseStamp()) return false;
        invalidateCaseStatusReads(key);
        if (
          result.caseId !== caseId || result.changeId !== changeId ||
          ![
            "refused-awaiting-continuation",
            "refused",
            "published-awaiting-adoption",
            "adopted",
            "blocked",
          ].includes(result.status ?? "")
        ) {
          throw new Error("The decision outcome is unknown.");
        }
        caseChangeResult.value = {
          caseId,
          agentId: conversation.agentId,
          stamp,
          message: "Decision sent; checking application status.",
        };
        await Promise.all([
          requests.refresh(caseId),
          requests.refreshScope(caseId),
        ]);
        if (stamp !== caseStamp()) return false;
        await loadCaseChangeStatus(caseId, conversation.agentId, changeId);
        return stamp === caseStamp();
      }
      if (!result.accepted) throw new Error("The decision was not confirmed.");
      await Promise.all([refresh(), agentConversations.refresh()]);
      return true;
    } catch (cause) {
      if (caseId) {
        if (stamp !== caseStamp()) return false;
        invalidateCaseStatusReads(key);
        caseChangeResult.value = {
          caseId,
          agentId: conversation.agentId,
          stamp,
          message: messageOf(cause),
        };
        await Promise.all([
          requests.refresh(caseId),
          requests.refreshScope(caseId),
        ]);
        if (stamp === caseStamp()) {
          await loadCaseChangeStatus(caseId, conversation.agentId, changeId);
        }
      } else {
        changeError.value = messageOf(cause);
        await agentConversations.refresh();
      }
      return false;
    } finally {
      pendingChanges.value = pendingChanges.value.filter((entry) =>
        entry !== key
      );
    }
  }
  const currentCounts = computed(() => {
    const state = current.value;
    const conversations = agentConversations.snapshot.value;
    const catalogue = operatorTools.snapshot.value;
    const tools = catalogue && state && catalogue.systemId === state.id
      ? [
        ...new Map(catalogue.tools.map((tool) => [operatorToolKey(tool), tool]))
          .values(),
      ]
      : null;
    const agents = conversations && state && conversations.systemId === state.id
      ? conversations.conversations
      : null;
    return {
      agentCount: agents
        ? new Set(agents.map((agent) => agent.nativeId)).size
        : state
        ? 1 + Number(Boolean(state.configuration?.reviewer))
        : 0,
      activeToolCount: tools
        ? tools.filter((tool) => tool.candidate.stage === "active").length +
          (catalogue?.modelTools?.length ?? 0)
        : (state?.candidates.filter((candidate) => candidate.stage === "active")
          .length || 0) + (state?.modelTools?.length ?? 0),
      messageCount: agents
        ? agents.reduce((count, agent) => count + agent.messages.length, 0)
        : state?.messages.length || 0,
    };
  });
  const pendingDecisions = computed(() =>
    aggregatePendingDecisions({
      state: current.value,
      conversations: agentConversations.snapshot.value,
      tools: operatorTools.snapshot.value,
      proposals: decisionProposals.visible(),
    })
  );
  // What waits in the Requests: their Branch Operators run apart from main, so
  // the decisions above never hold them.
  const requestDecisions = computed(() =>
    aggregateRequestDecisions(requests.snapshots.value)
  );
  const pendingDecisionCount = computed(() => pendingDecisions.value.length);
  const pendingDecisionsLoading = computed(() =>
    loading.value || decisionProposals.loading.value ||
    agentConversations.loading.value ||
    operatorTools.loading.value
  );
  const pendingDecisionsError = computed(() =>
    decisionProposals.error.value ||
    (agentConversations.error.value ||
        operatorTools.stale.value && operatorTools.error.value
      ? "Some decisions could not be loaded."
      : "")
  );
  const conversationSnapshot = computed(() =>
    !readOnly.value &&
      agentConversations.snapshot.value?.systemId === current.value?.id
      ? agentConversations.snapshot.value
      : null
  );
  const selectedConversation = computed(() =>
    conversationSnapshot.value ? agentConversations.selected.value : null
  );
  const canChat = computed(() =>
    !readOnly.value &&
    (agentConversations.snapshot.value
      ? agentConversations.canSend.value
      : canAct.value)
  );
  const error = computed(() =>
    localError.value || (!readOnly.value && current.value?.error) || ""
  );
  const graphRequestUrl = computed(() =>
    graphSourceSelection.value
      ? `/api/model-graph?modelVersion=${
        encodeURIComponent(graphSourceSelection.value.modelVersion)
      }`
      : readOnly.value && historicalProjection.value
      ? `/api/model-graph?revision=${selectedRevision.value}`
      : "/api/model-graph"
  );
  const modelCaption = computed(() =>
    graphSourceSelection.value
      ? `Saved model · SysML version ${graphSourceSelection.value.modelVersion} · read-only`
      : !readOnly.value
      ? "Current model · updated live"
      : historicalProjection.value
      ? `Rebuilt model · revision ${selectedRevision.value} · read-only`
      : `No graph saved for revision ${selectedRevision.value} · the current model stays shown`
  );

  let epoch = 0;
  let historyRequest = 0;
  let source: WorkbenchEventSource | null = null;
  let stateFlight: Promise<void> | null = null;
  let historyFlight: Promise<void> | null = null;
  let historyAgain = false;
  let proposalPoll: ReturnType<typeof setInterval> | undefined;
  let releaseSessionFollow: (() => void) | undefined;

  // Each Case's model as the host tells it (`case-model-version`): a Case's
  // pages follow it exactly as the main pages follow `model-version`. The
  // announcement is the Case's executing version as `head`, with its branch.
  const caseModels = new Map<string, { live: ModelLive; followers: number }>();
  function caseModelLive(caseId: string): ModelLive {
    let entry = caseModels.get(caseId);
    if (!entry) {
      const inner = createModelLive();
      const counted: { live: ModelLive; followers: number } = {
        followers: 0,
        live: {
          follow(read) {
            counted.followers++;
            const stop = inner.follow(read);
            let stopped = false;
            return () => {
              if (stopped) return;
              stopped = true;
              counted.followers--;
              stop();
            };
          },
          accept: (data) => inner.accept(data),
        },
      };
      entry = counted;
      caseModels.set(caseId, entry);
    }
    return entry.live;
  }
  function tellCase(caseId: string, head: string, branchVersion: string) {
    caseModelLive(caseId).accept(JSON.stringify({ head, branchVersion }));
  }
  /** The host says a Case's model moved: its held scope is read again (what
   * the pages show stays until the answer) and its pages follow the new head. */
  function acceptCaseModel(value: CaseModelVersion) {
    if (requests.scopes.peek().has(value.caseId)) {
      void requests.loadScope(value.caseId);
    }
    tellCase(value.caseId, value.executionVersion, value.branchVersion);
  }
  /** A reconnection may have missed what the host said of the Cases shown or
   * held: each is read again, and its pages hear its head as it now stands. */
  function resyncCases() {
    const shown = [...caseModels].filter(([, entry]) => entry.followers > 0)
      .map(([caseId]) => caseId);
    for (
      const caseId of new Set([...requests.scopes.peek().keys(), ...shown])
    ) {
      void requests.loadScope(caseId).then(() => {
        const scope = requests.scopes.peek().get(caseId);
        if (scope) {
          tellCase(caseId, scope.executionVersion, scope.branchVersion);
        }
      });
    }
  }

  function acceptState(value: unknown) {
    const next = value && typeof value === "object" && "state" in value
      ? value.state
      : value;
    if (!isState(next)) {
      throw new Error(
        "The received state is unreadable. Reconnecting to the system state…",
      );
    }
    if (!current.value || next.revision >= current.value.revision) {
      current.value = next;
      if (source) decisionProposals.invalidate();
    }
  }

  /**
   * Evolution changed the sources (it already advanced the proposal generation
   * through `chatProposals.invalidate`): reread the runtime views and decisions.
   */
  async function sourcesChanged() {
    await Promise.all([refresh(), refreshHistory(), refreshPendingDecisions()]);
  }

  async function refreshPendingDecisions() {
    await Promise.all([
      agentConversations.refresh(),
      operatorTools.refresh(),
      decisionProposals.refresh(),
    ]);
  }

  function refresh(): Promise<void> {
    if (stateFlight) return stateFlight;
    const requestEpoch = epoch;
    const flight = (async () => {
      try {
        const next = await api.readState();
        if (requestEpoch === epoch) acceptState(next);
      } catch (err) {
        if (requestEpoch === epoch) localError.value = messageOf(err);
      } finally {
        if (requestEpoch === epoch) loading.value = false;
      }
    })();
    stateFlight = flight;
    void flight.finally(() => {
      if (stateFlight === flight) stateFlight = null;
    });
    return flight;
  }

  function refreshHistory(): Promise<void> {
    if (historyFlight) {
      historyAgain = true;
      return historyFlight;
    }
    const requestEpoch = epoch;
    historyLoading.value = true;
    const flight = (async () => {
      try {
        do {
          historyAgain = false;
          const result = await api.readHistory();
          if (requestEpoch !== epoch) return;
          batch(() => {
            historyEntries.value = result.revisions;
            historyError.value = "";
          });
        } while (historyAgain);
      } catch (err) {
        if (requestEpoch === epoch) {
          historyError.value = `History unavailable: ${messageOf(err)}`;
        }
      } finally {
        if (requestEpoch === epoch) historyLoading.value = false;
      }
    })();
    historyFlight = flight;
    void flight.finally(() => {
      if (historyFlight === flight) historyFlight = null;
    });
    return flight;
  }

  function resetToCurrent() {
    historyRequest++;
    batch(() => {
      selectedRevision.value = null;
      inspected.value = null;
      historicalProjection.value = null;
      historicalLoading.value = false;
      graphSourceSelection.value = null;
      localError.value = "";
    });
  }

  async function selectRevision(revision: number | null) {
    if (revision === null) {
      resetToCurrent();
      return;
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      localError.value = "Invalid revision.";
      return;
    }
    const request = ++historyRequest;
    const requestEpoch = epoch;
    batch(() => {
      selectedRevision.value = revision;
      inspected.value = null;
      historicalProjection.value = null;
      graphSourceSelection.value = null;
      historicalLoading.value = true;
      localError.value = "";
    });
    try {
      const result = await api.readRevision(revision);
      if (request !== historyRequest || requestEpoch !== epoch) return;
      if (!isState(result.state) || result.state.revision !== revision) {
        throw new Error("The received revision does not match the request.");
      }
      batch(() => {
        inspected.value = result.state;
        historicalProjection.value = result.projection;
      });
    } catch (err) {
      if (request === historyRequest && requestEpoch === epoch) {
        localError.value = messageOf(err);
      }
    } finally {
      if (request === historyRequest && requestEpoch === epoch) {
        historicalLoading.value = false;
      }
    }
  }

  function inspectSourceVersion(modelVersion: string) {
    if (!modelVersion.trim()) return;
    graphSourceSelection.value = { modelVersion };
  }

  async function executeWrite(
    action: () => Promise<unknown>,
    onAccepted?: () => void,
  ) {
    if (!canAct.value) return false;
    const requestEpoch = epoch;
    batch(() => {
      pending.value = true;
      localError.value = "";
    });
    let accepted = false;
    try {
      await action();
      accepted = true;
      if (requestEpoch !== epoch) return true;
      onAccepted?.();
      await Promise.all([refresh(), refreshHistory()]);
    } catch (err) {
      if (requestEpoch === epoch) localError.value = messageOf(err);
    } finally {
      if (requestEpoch === epoch) pending.value = false;
    }
    return accepted;
  }

  /**
   * `caseId` names the Request the message continues; `null` opens a new one.
   * Without it, the host keeps its historical behaviour.
   */
  function sendMessage(text = draft.value, caseId?: string | null) {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve(false);
    if (agentConversations.snapshot.peek()) {
      return agentConversations.send(trimmed, caseId);
    }
    const submittedDraft = draft.value;
    return executeWrite(() => api.sendMessage(trimmed, caseId), () => {
      if (caseId === undefined && draft.value === submittedDraft) {
        draft.value = "";
      }
    });
  }

  function decide(
    kind: "candidate" | "change",
    id: string,
    verdict: Verdict,
    expectedRevision: number,
    candidateDigest?: string,
  ) {
    if (!canAct.value || !decisionsOpen.peek()) return Promise.resolve(false);
    if (current.value!.revision !== expectedRevision) {
      localError.value =
        "The state changed. Review the proposal before deciding.";
      return Promise.resolve(false);
    }
    if (
      kind === "candidate" && (!candidateDigest ||
        current.value!.candidates.find((candidate) => candidate.id === id)
            ?.digest !== candidateDigest)
    ) {
      localError.value =
        "The tool changed. Review the proposal before deciding.";
      return Promise.resolve(false);
    }
    const command: DecisionCommand = kind === "candidate"
      ? {
        kind,
        candidateId: id,
        candidateDigest: candidateDigest!,
        expectedRevision,
        verdict,
        reason: admissionReason(verdict),
      }
      : { kind, changeId: id, expectedRevision, verdict };
    return decisionLock.track(() => executeWrite(() => api.decide(command)));
  }

  function dispose() {
    epoch++;
    for (const release of releaseCaseFences) release();
    historyRequest++;
    clearInterval(proposalPoll);
    proposalPoll = undefined;
    releaseSessionFollow?.();
    releaseSessionFollow = undefined;
    source?.close();
    source = null;
    stateFlight = null;
    historyFlight = null;
    historyAgain = false;
    agentConversations.dispose();
    operatorTools.dispose();
    chatProposals.dispose();
    decisionProposals.dispose();
    cases.dispose();
    requests.dispose();
    batch(() => {
      connection.value = "closed";
      pending.value = false;
      historyLoading.value = false;
      historicalLoading.value = false;
    });
  }

  /** Opens the one event stream of this lifecycle, replacing any open one. */
  function connect(lifecycle: number) {
    const factory = options.eventSourceFactory ??
      ((path: string) => new EventSource(path));
    try {
      const opened = factory("/api/events");
      source = opened;
      // A stream let go (closed, or replaced for a new session) says nothing.
      const current = () => epoch === lifecycle && source === opened;
      opened.addEventListener("open", () => {
        if (!current()) return;
        // Only the first connection has nothing to have missed of the Cases.
        const reconnected = connection.peek() !== "connecting";
        // Even a same-head reconnect must retire failed or cached source reads.
        // The generation survives connection transitions coalesced by rendering.
        void chatProposals.invalidate();
        connection.value = "live";
        performanceGeneration.value++;
        releaseCatalogueGeneration.value++;
        void refresh();
        void refreshHistory();
        void agentConversations.refresh();
        void operatorTools.refresh();
        void decisionProposals.refresh();
        void cases.refresh();
        if (reconnected) resyncCases();
      });
      opened.addEventListener(PROVIDER_RESOURCES_INVALIDATED, (event) => {
        if (!current()) return;
        try {
          if (isProviderResourceInvalidation(JSON.parse(event.data ?? ""))) {
            performanceGeneration.value++;
          }
        } catch {
          // Invalid advisory data supplies no selection or permission.
        }
      });
      opened.addEventListener(RELEASE_CATALOGUE_INVALIDATED, (event) => {
        if (!current()) return;
        try {
          if (isReleaseCatalogueInvalidation(JSON.parse(event.data ?? ""))) {
            releaseCatalogueGeneration.value++;
          }
        } catch {
          // Advisory data never supplies catalogue content or authority.
        }
      });
      opened.addEventListener("cases", (event) => {
        if (!current()) return;
        try {
          cases.accept(JSON.parse(event.data ?? ""));
        } catch {
          void cases.refresh();
        }
      });
      opened.addEventListener("conversations", (event) => {
        if (!current()) return;
        try {
          agentConversations.accept(JSON.parse(event.data ?? ""));
        } catch {
          void agentConversations.refresh();
        }
      });
      opened.addEventListener("state", (event) => {
        if (!current()) return;
        try {
          acceptState(JSON.parse(event.data ?? ""));
        } catch (err) {
          localError.value = messageOf(err);
          void refresh();
        }
        void refreshHistory();
      });
      // The model's pages follow the host's word on it (lib/model-live.ts)
      // over this connection: they open none of their own.
      opened.addEventListener("model-version", (event) => {
        if (current()) modelLive.accept(event.data);
      });
      // A Case's pages follow its own word the same way, over the same
      // connection. Only a valid announcement is heard.
      opened.addEventListener(CASE_MODEL_VERSION, (event) => {
        if (!current()) return;
        let value: unknown;
        try {
          value = JSON.parse(event.data ?? "");
        } catch {
          return;
        }
        if (isCaseModelVersion(value)) acceptCaseModel(value);
      });
      opened.addEventListener("error", () => {
        if (current()) connection.value = "reconnecting";
      });
    } catch (err) {
      connection.value = "reconnecting";
      localError.value = messageOf(err);
    }
  }

  function start() {
    if (source) return dispose;
    const lifecycle = ++epoch;
    connection.value = "connecting";
    connect(lifecycle);
    // The host tells a Request owner's Case events only to a stream opened
    // with the owner's session: a new session opens the stream again.
    let session = requests.sessionGeneration.peek();
    releaseSessionFollow = requests.sessionGeneration.subscribe((next) => {
      if (next === session || epoch !== lifecycle) return;
      session = next;
      source?.close();
      connect(lifecycle);
    });
    // Source proposal decisions can leave runtime state and conversations unchanged.
    // Poll only their existing endpoint, skipping ticks while a read is in flight.
    clearInterval(proposalPoll);
    proposalPoll = setInterval(() => {
      if (epoch === lifecycle && !decisionProposals.loading.peek()) {
        void decisionProposals.refresh();
      }
    }, 30_000);
    void refresh();
    void refreshHistory();
    void agentConversations.refresh();
    void operatorTools.refresh();
    void decisionProposals.refresh();
    void cases.refresh();
    return () => {
      if (epoch === lifecycle) dispose();
    };
  }

  return {
    cases,
    requests,
    pins,
    caseSeen,
    chatProposals,
    decideOperatorChange,
    pendingChanges,
    changeError,
    caseChangeResult,
    caseChangeNotice,
    caseChangeStatus,
    caseChangeError,
    loadCaseChangeStatus,
    resumeCaseChange,
    current,
    displayed,
    draft,
    connection,
    caseModelLive,
    performanceGeneration,
    releaseCatalogueGeneration,
    pending,
    loading,
    localError,
    error,
    historyEntries,
    historyLoading,
    historyError,
    selectedRevision,
    inspected,
    historicalProjection,
    historicalLoading,
    readOnly,
    canAct,
    canChat,
    selectedConversation,
    conversationSnapshot,
    agentConversations,
    operatorTools,
    visibleOperatorTools,
    currentCounts,
    pendingDecisions,
    requestDecisions,
    pendingDecisionCount,
    pendingDecisionsLoading,
    pendingDecisionsError,
    refreshPendingDecisions,
    sourcesChanged,
    decisionsOpen,
    decideOperatorTool,
    graphSourceSelection,
    graphRequestUrl,
    modelCaption,
    refresh,
    refreshHistory,
    selectRevision,
    resetToCurrent,
    inspectSourceVersion,
    sendMessage,
    decide,
    start,
    dispose,
  };
}
export type WorkbenchState = ReturnType<typeof createWorkbenchState>;

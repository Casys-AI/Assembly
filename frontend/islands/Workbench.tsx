import { WorkspaceVersion } from "../components/workbench/WorkspaceVersion.tsx";
import {
  requestVersionInfo,
  type VersionInfo,
} from "../lib/workbench/version-label.ts";
import { createRevisionApi } from "../lib/model/revisions/api.ts";
import { type ModelLive, modelLive } from "../lib/model/live.ts";
import {
  type CaseModelScope,
  caseSourceMetadataRevision,
  readCaseModelScope,
} from "../lib/case-model-scope.ts";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentConversation } from "../../src/application/work/operators/conversation-types.ts";
import {
  type AgentDetail,
  AgentHeader,
} from "../components/conversations/AgentHeader.tsx";
import { ChatView } from "../components/conversations/ChatView.tsx";
import { CasesPage } from "../components/cases/CasesPage.tsx";
import {
  Dock,
  type DockPlace,
  type DockStackGroup,
  type DockWork,
} from "../components/workbench/Dock.tsx";
import { ActivityPlace } from "../components/decide/ActivityPlace.tsx";
import { ModelSpace } from "../components/model/ModelSpace.tsx";
import { SystemFrame } from "../components/system/SystemFrame.tsx";
import { ModelLinkContext } from "../components/view/ModelContextLink.tsx";
import { type CaseActions, CaseView } from "../components/cases/CaseView.tsx";
import { AppMenu } from "../components/workbench/AppMenu.tsx";
import {
  agentActivity,
  caseAgentHref,
  caseDetail,
  caseHref,
  caseKindLabel,
  type CaseRecord,
  caseTitle,
  isOpenCase,
} from "../lib/cases/cases.ts";
import {
  arrivalOrder,
  conversationHref,
  deskLocation,
  graphAddress,
  modelHref,
  monogram,
  PLACE_PATH,
  systemHref,
} from "../lib/workbench/desk.ts";
import {
  caseHasPendingDecision,
  type PendingDecision,
} from "../lib/decide/pending.ts";
import { placeOfPath, viewHref } from "../lib/workbench/view-location.ts";
import {
  currentContextModelHref,
  modelConversationHidden,
  modelConversationHref,
  modelInspectionVersion,
  modelPlaceConversationHref,
  modelShowsGlobalMain,
  modelViewContext,
  reopenModelViewContext,
  unavailableModelScope,
  withModelViewContext,
} from "../lib/workbench/model-context.ts";
import {
  createWorkbenchState,
  type WorkbenchState,
} from "../lib/workbench/state.ts";

// Fresh 1.1.2 preserves CSS HMR only for imports reachable from an island.
// Link the global styles in dev; production keeps the normal client entry.
if (import.meta.hot) void import("../client.ts");

export type WorkspaceView = "chat" | "tools" | "system" | "model" | "activity";

/** Read-only peer sessions can own runtimes; recorded audit threads do not. */
export function runtimeRevisionOperators(
  operators: readonly AgentConversation[] = [],
): AgentConversation[] {
  return operators.filter((operator) => operator.runtimeOwned !== false);
}

export function viewFromPath(path: string): WorkspaceView {
  if (path === "/tools") return "tools";
  // A place is read from its own path or from an earlier address of it.
  return placeOfPath(path) ?? "chat";
}

export function synchronizeModelLocation(
  state: WorkbenchState,
  query: Record<string, string>,
): void | Promise<void> {
  if (query.caseBranch) return;
  if (query.modelVersion) {
    state.inspectSourceVersion(query.modelVersion);
  } else if (query.revision && /^\d+$/.test(query.revision)) {
    // A source inspection may retain the same runtime revision underneath it.
    // Returning to that revision must reveal its graph without fetching it again.
    state.graphSourceSelection.value = null;
    const revision = Number(query.revision);
    if (revision !== state.selectedRevision.peek()) {
      return state.selectRevision(revision);
    }
  } else if (
    state.selectedRevision.peek() !== null ||
    state.graphSourceSelection.peek()
  ) state.resetToCurrent();
}

/** A Request never mounts the Designer's execution-history graph. */
export function workbenchGraphShown(
  graphHome: string | null,
  caseId: string | null,
  unavailable: boolean,
): boolean {
  return graphHome !== null && !caseId && !unavailable;
}

/** A direct Case link can name a closed Case absent from the Dock collection. */
export function synchronizeCaseLocation(
  state: WorkbenchState,
  caseId: string | null,
): void | Promise<void> {
  if (caseId) {
    const known = state.cases.byId(caseId);
    return known && known.type !== "request"
      ? state.cases.ensure(caseId)
      : state.requests.cases.ensure(caseId);
  }
}

export { conversationHref };

function currentInspectionHref(href: string, url: URL): string {
  return viewHref(href, {
    branch: url.searchParams.get("branch"),
    version: modelInspectionVersion(url),
    modelVersion: null,
    commit: null,
    proposal: null,
    revision: null,
  });
}

/**
 * Puts the address of what the desk now shows in the address bar, without a
 * navigation: the page was already rendered, a reload must land on it.
 */
function showAddress(href: string): void {
  try {
    if (location.pathname + location.search !== href) {
      history.replaceState(history.state, "", href);
    }
  } catch {
    // An address that cannot be rewritten only costs a reload to the same page.
  }
}

/** Where an opened Dock item goes when it is closed; the conversation stays. */
const deskHome = "/";

function CloseLink(
  { label, href = deskHome }: { label: string; href?: string },
) {
  return (
    <a class="desk-close" href={href} aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="m4.5 4.5 7 7m0-7-7 7" />
      </svg>
    </a>
  );
}

/**
 * The desk: a calm workspace with the Dock at the bottom. The circle opens the
 * conversation with the central agent; Dock items open beside it, or alone.
 */
/** Classify only against an observed admitted head; absent evidence stays neutral. */
export function releaseSourceContext(source: string, head: string | null): {
  label: string;
  divergent: boolean;
} {
  return head === null
    ? { label: "release source", divergent: false }
    : head === source
    ? { label: "current release source", divergent: false }
    : { label: "historical release source", divergent: true };
}

export function useReleaseSourceHead(
  key: string | null,
  { connection = "live", generation = 0, live = modelLive }: {
    connection?: WorkbenchState["connection"]["value"];
    generation?: number;
    live?: ModelLive;
  } = {},
): string | null {
  const [releaseHead, setReleaseHead] = useState<
    { key: string; version: string } | null
  >(null);
  useEffect(() => {
    setReleaseHead(null);
    // Wait for the first open so it does not duplicate an initialization read.
    if (!key || connection !== "live") return;
    let active = true;
    let announced = false;
    const stop = live.follow(({ version }) => {
      announced = true;
      setReleaseHead({ key, version });
    });
    // Following does not replay a head announced before this page opened.
    // Reconnects also reread: an unchanged announcement may be deduplicated.
    createRevisionApi().files().then((result) => {
      if (active && !announced) {
        setReleaseHead({ key, version: result.version });
      }
    }, () => {
      if (active && !announced) setReleaseHead(null);
    });
    return () => {
      active = false;
      stop();
    };
  }, [key, connection, generation, live]);
  return connection === "live" && releaseHead?.key === key
    ? releaseHead.version
    : null;
}

/** Hold open Request conversations for decision badges on every page. */
export function useOpenRequestReads(state: WorkbenchState, started: boolean) {
  const sessionReady = state.requests.sessionReady.value;
  const openKey = state.requests.cases.open.value.map((record) => record.id)
    .join("\n");
  const scope = JSON.stringify([
    state.current.value?.id,
    state.requests.context.value,
    state.requests.sessionGeneration.value,
  ]);
  const held = useRef({ scope, releases: new Map<string, () => void>() });
  useEffect(() => () => {
    for (const release of held.current.releases.values()) release();
    held.current.releases.clear();
  }, [state]);
  useEffect(() => {
    const desired = new Set(
      started && sessionReady
        ? state.requests.cases.open.peek().map((r) => r.id)
        : [],
    );
    for (const [caseId, release] of held.current.releases) {
      if (held.current.scope !== scope || !desired.has(caseId)) {
        release();
        held.current.releases.delete(caseId);
      }
    }
    held.current.scope = scope;
    for (const caseId of desired) {
      if (!held.current.releases.has(caseId)) {
        held.current.releases.set(caseId, state.requests.retain(caseId));
      }
    }
  }, [state, started, sessionReady, scope, openKey]);
}

/** Keep the selected Request mounted while another surface is visible. */
export function useParkedRequestSelection(
  selected: { caseId: string; agentId: string | null } | null,
  useParked: boolean,
): { caseId: string; agentId: string | null } | null {
  const parked = useRef<{ caseId: string; agentId: string | null } | null>(
    null,
  );
  if (selected) parked.current = selected;
  return useParked ? parked.current : null;
}

export function designerConversationShown(input: {
  modelOpen: boolean;
  modelSplit: boolean;
  contextCaseId: string | null;
  showCases: boolean;
  scheduledCase: boolean;
  sideAgent: boolean;
  talking: boolean;
  caseSelected?: boolean;
  globalMainSelected?: boolean;
  mainHidden?: boolean;
}): boolean {
  return input.modelOpen
    ? input.modelSplit &&
      (!input.contextCaseId || input.globalMainSelected === true)
    : input.showCases
    ? !input.mainHidden
    : !input.scheduledCase && !input.sideAgent && input.talking;
}

export function Workspace(
  { state, started, initialUrl }: {
    state: WorkbenchState;
    started: boolean;
    initialUrl: string;
  },
) {
  const location = useMemo(() => new URL(initialUrl, "http://localhost"), [
    initialUrl,
  ]);
  const active = viewFromPath(location.pathname);
  // Every direct entry (Main, System, Model or Case) reads the backend runtime
  // mode before using its development-only session endpoint. Views share the
  // existing Requests connection and its in-flight initialization.
  useEffect(() => {
    if (!started || state.requests.sessionReady.peek()) return;
    let mounted = true;
    void state.requests.prepareConnection().then((ready) => {
      if (mounted && ready) void state.requests.cases.refresh();
    });
    return () => {
      mounted = false;
    };
  }, [
    state,
    started,
    state.requests.sessionReady.value,
    state.connection.value,
  ]);
  const current = state.current.value;
  const connection = state.connection.value;
  const model = current?.executionModel;
  // sourceModelIdentity omits this qualified name for the default SysML system.
  const systemName = model?.identity.systemQualifiedName ||
    current?.model?.systemQualifiedName ||
    (model?.identity || current?.model
      ? "ASELiveBuilder::liveBuilder"
      : "Workspace");
  const modelVersion = model?.version.repositoryVersion;
  const modelDigest = model?.version.digest;
  const versionLabel = modelVersion
    ? `Model ${modelVersion.replace(/^commit:/, "").slice(0, 8)} · in service`
    : modelDigest
    ? `Model digest ${modelDigest.slice(0, 8)} · in service`
    : "Model version unavailable";
  const everyone = state.agentConversations.snapshot.value;
  const roster = everyone && everyone.systemId === current?.id
    ? everyone
    : null;
  // The circle, the header and every send address the selected conversation,
  // which follows the contact point whenever an admitted version moves it.
  const centralId = roster
    ? state.agentConversations.selectedAgentId.value
    : null;
  const central =
    roster?.conversations.find((entry) => entry.agentId === centralId) ?? null;
  const centralName = central?.name || model?.operator?.name || "Agent";
  // Reading a past revision: the conversation panel names that era's agent.
  const historicalRevision = state.readOnly.value
    ? state.selectedRevision.value
    : null;
  const panelName = historicalRevision === null
    ? centralName
    : state.displayed.value?.executionModel?.operator?.name || "Agent";
  const desk = useMemo(() => deskLocation(location, centralId), [
    location,
    centralId,
  ]);
  const item = desk.item;
  const modelOpen = item?.kind === "system" || item?.kind === "model";
  const modelSplit = modelOpen && !modelConversationHidden(location);
  const globalMainSelected = modelOpen && modelShowsGlobalMain(location);
  const addressContext = modelViewContext(location);
  // These are Case references only. Scoped model readers are still unavailable.
  const contextCaseId = modelOpen ? addressContext.caseId : null;
  const sideAgentId = item?.kind === "agent" ? item.agentId : null;
  // A Case is named by `/cases?case=` or by `/chat?case=`. A Request is read on
  // the Requests page, selected; a Job or a Watch has its own page. Until its
  // record loads, a Case address is read as a Request.
  const namedCaseId = item?.kind === "case" || item?.kind === "cases"
    ? item.caseId ?? null
    : contextCaseId;
  const recordFor = (id: string | null | undefined) => {
    const request = state.requests.cases.byId(id ?? null);
    const main = state.cases.byId(id ?? null);
    return request ?? (main?.type !== "request" ? main : null);
  };
  const namedCase = recordFor(namedCaseId);
  const scheduledCase = namedCase && namedCase.type !== "request"
    ? namedCase
    : null;
  const showCases = (item?.kind === "cases" || item?.kind === "case") &&
    !scheduledCase;
  // The first message on the Requests page, nothing selected, opens a Case: the
  // page follows it locally, until the address says otherwise.
  const [startedCase, setStartedCase] = useState<string | null>(null);
  useEffect(() => setStartedCase(null), [initialUrl]);
  // The list is `/cases`, which the page may already have been loaded on: the
  // address then does not change, so the links to it let the Case go.
  const backToList = () => setStartedCase(null);
  const selectedCaseId = showCases ? startedCase ?? namedCaseId : contextCaseId;
  // A sub-agent's messages in the Case are read by `&agent=`; a Case just
  // started here has none.
  const namedAgentId = item?.kind === "cases" && !startedCase
    ? item.agentId ?? null
    : modelOpen
    ? addressContext.agentId
    : null;
  const wantedCaseId = startedCase ?? namedCaseId;
  useEffect(() => {
    if (started && wantedCaseId) {
      void synchronizeCaseLocation(state, wantedCaseId);
    }
  }, [started, wantedCaseId, recordFor(wantedCaseId)?.id]);
  // `/cases?from=`: the next catalogue read selects that Release for a new Request.
  const startFrom = item?.kind === "cases" ? item.startFrom : undefined;
  useEffect(() => {
    if (startFrom) state.requests.startFrom(startFrom);
  }, [startFrom]);
  // Each kind of Case keeps one address once its record says which it is: a
  // Request opened by `/chat?case=` moves to the Requests page's, and keeps the
  // sub-agent it reads.
  useEffect(() => {
    if (started && namedCase && !modelOpen) {
      const caseAddress = namedCase.type === "request" && namedAgentId
        ? caseAgentHref(namedCase.id, namedAgentId)
        : caseHref(namedCase.id, namedCase.type);
      showAddress(
        viewHref(caseAddress, {
          main: location.searchParams.get("main") === "hidden"
            ? "hidden"
            : null,
        }),
      );
    }
  }, [started, namedCase?.id, namedCase?.type, namedAgentId, modelOpen]);
  // The parked subtree stays mounted even when full Main or another agent is
  // shown. A visible Requests list must still show its own empty selection.
  const requestSelection = useParkedRequestSelection(
    selectedCaseId && !scheduledCase
      ? { caseId: selectedCaseId, agentId: namedAgentId }
      : null,
    !selectedCaseId && !showCases && !scheduledCase,
  );
  const selectedAgents = useRef(new Map<string, string | null>());
  if (selectedCaseId) selectedAgents.current.set(selectedCaseId, namedAgentId);
  const conversationContext = {
    caseId: selectedCaseId ?? scheduledCase?.id ?? null,
    agentId: namedAgentId,
  };
  const contextRecord = recordFor(conversationContext.caseId);
  const contextName = conversationContext.caseId
    ? contextRecord
      ? `${caseKindLabel[contextRecord.type]} · ${
        caseTitle(contextRecord, Number.MAX_SAFE_INTEGER)
      }`
      : "Request"
    : "Main Operator";
  const contextTint = conversationContext.caseId ? "request" : "designer";
  const fullConversationHref = conversationContext.caseId
    ? namedAgentId
      ? caseAgentHref(conversationContext.caseId, namedAgentId)
      : caseHref(conversationContext.caseId, scheduledCase?.type)
    : conversationHref();
  // A page close follows the conversation actually shown; page-only closes to
  // the neutral desk without reopening a hidden conversation.
  const closePanelHref = !modelSplit
    ? deskHome
    : !contextCaseId || globalMainSelected
    ? conversationHref()
    : viewHref(fullConversationHref, { main: "hidden" });
  const closeConversationHref = modelSplit
    ? modelPlaceConversationHref(location.pathname + location.search, true)
    : showCases
    ? viewHref(location.pathname + location.search, { main: "hidden" })
    : deskHome;
  const inspectedVersion = modelOpen ? modelInspectionVersion(location) : null;
  const creatingRelease = modelOpen &&
    location.searchParams.get("page") === "releases" &&
    location.searchParams.get("create") === "1";
  const mainReleaseKey = creatingRelease && inspectedVersion &&
      !location.searchParams.has("caseBranch") &&
      !unavailableModelScope(location.searchParams)
    ? inspectedVersion
    : null;
  const releaseHeadVersion = useReleaseSourceHead(mainReleaseKey, {
    connection,
    generation: state.connectionGeneration.value,
  });
  const mainReleaseContext = mainReleaseKey
    ? releaseSourceContext(mainReleaseKey, releaseHeadVersion)
    : null;
  const sessionReady = state.requests.sessionReady.value;
  const scopeKey =
    modelOpen && contextCaseId && !location.searchParams.has("branch")
      ? JSON.stringify([
        contextCaseId,
        inspectedVersion ?? null,
        sessionReady,
        caseSourceMetadataRevision(contextCaseId),
      ])
      : null;
  const [caseScope, setCaseScope] = useState<
    { key: string; scope?: CaseModelScope }
  >({ key: "" });
  useEffect(() => {
    if (!scopeKey || !contextCaseId) return;
    let active = true;
    readCaseModelScope(contextCaseId, inspectedVersion ?? undefined).then(
      (scope) => {
        if (active) setCaseScope({ key: scopeKey, scope });
      },
      () => {
        if (active) setCaseScope({ key: scopeKey });
      },
    );
    return () => {
      active = false;
    };
  }, [scopeKey]);
  const resolvedScope = scopeKey === caseScope.key
    ? caseScope.scope
    : undefined;
  const modelScopeUnavailable = modelOpen &&
    unavailableModelScope(location.searchParams) && !resolvedScope;
  const selectedRequestScope = selectedCaseId
    ? state.requests.scopes.value.get(selectedCaseId)
    : undefined;
  const titleCaseId = modelOpen ? contextCaseId : selectedCaseId;
  const titleRecord = titleCaseId ? recordFor(titleCaseId) : null;
  const titleVersion: VersionInfo = titleCaseId
    ? requestVersionInfo(
      titleRecord ?? { id: titleCaseId },
      modelOpen ? resolvedScope : selectedRequestScope,
    )
    : {
      source: { kind: "main" },
      version: modelScopeUnavailable
        ? undefined
        : inspectedVersion ?? modelVersion,
      inService: modelVersion,
      readOnly: Boolean(inspectedVersion),
    };
  const requestShown = showCases ||
    Boolean(
      modelSplit && contextCaseId && !scheduledCase && !globalMainSelected,
    );
  const pins = state.pins;
  // Pins and seen marks belong to the host system, whichever collection says it.
  const pinScope = state.cases.snapshot.value?.systemId ??
    state.requests.context.value?.systemId;
  useEffect(() => {
    pins.load(pinScope);
    state.caseSeen.load(pinScope);
  }, [pinScope]);
  // Present conversations only: a historical inspection has no peer threads.
  const sideAgent = sideAgentId
    ? state.conversationSnapshot.value?.conversations.find((entry) =>
      entry.agentId === sideAgentId
    ) ?? null
    : null;
  const sideName = sideAgent?.name ||
    roster?.conversations.find((entry) => entry.agentId === sideAgentId)
      ?.name ||
    "Conversation";
  // The Model place reopens on the page and the revision last read there.
  const modelPlaceHref = useRef(modelHref());
  const systemPlaceHref = useRef(systemHref());
  if (item?.kind === "system") {
    systemPlaceHref.current = location.pathname + location.search;
  }
  if (item?.kind === "model") {
    modelPlaceHref.current = location.pathname + location.search;
  }
  // The page that draws the graph keeps its revision inspections on its address.
  const graphHome = graphAddress(item);
  const graphShown = workbenchGraphShown(
    graphHome,
    contextCaseId,
    modelScopeUnavailable,
  );
  const [talking, setTalking] = useState(desk.talk);
  const designerShown = designerConversationShown({
    modelOpen,
    modelSplit,
    contextCaseId,
    showCases,
    scheduledCase: Boolean(scheduledCase),
    sideAgent: Boolean(sideAgentId),
    talking,
    caseSelected: Boolean(selectedCaseId),
    globalMainSelected,
    mainHidden: location.searchParams.get("main") === "hidden",
  });
  // Details asked by the address go to the agent they name.
  const [centralDetail, setCentralDetail] = useState<AgentDetail | null>(
    desk.item ? null : desk.details,
  );
  const [sideDetail, setSideDetail] = useState<AgentDetail | null>(
    desk.item?.kind === "agent" ? desk.details : null,
  );
  const panel = useRef<HTMLElement>(null);
  const circle = useRef<HTMLElement>(null);
  const centralNameButton = useRef<HTMLButtonElement>(null);
  const sideNameButton = useRef<HTMLButtonElement>(null);
  const focusComposer = useRef(false);

  function openConversation() {
    focusComposer.current = true;
    setTalking(true);
  }
  function closeConversation() {
    const inside = panel.current?.contains(document.activeElement);
    setTalking(false);
    setCentralDetail(null);
    if (inside) circle.current?.focus();
  }
  const loadedAt = useRef(initialUrl);
  useEffect(() => {
    // A link that leads to the conversation (a decision to take, say) opens it
    // as the circle does, with the cursor in the composer. The address the page
    // loaded with only opens it: its central agent may be known a moment later.
    if (desk.talk && !talking) {
      if (loadedAt.current === initialUrl) setTalking(true);
      else openConversation();
    }
    loadedAt.current = initialUrl;
    if (desk.details && !desk.item) setCentralDetail(desk.details);
  }, [initialUrl, centralId]);
  useEffect(
    () => setSideDetail(item?.kind === "agent" ? desk.details : null),
    [item?.kind, sideAgentId, desk.details],
  );
  useEffect(() => {
    if (historicalRevision !== null) setCentralDetail(null);
  }, [historicalRevision]);
  // Closed Requests leave the Dock after a day, even when nothing else moves.
  useEffect(() => {
    const timer = setInterval(() => {
      state.cases.tick();
      state.requests.cases.tick();
    }, 60_000);
    return () => clearInterval(timer);
  }, [state]);
  useOpenRequestReads(state, started);
  useEffect(() => {
    if (!talking || !focusComposer.current) return;
    focusComposer.current = false;
    panel.current?.querySelector<HTMLTextAreaElement>(
      ".composer-input:not(:disabled)",
    )?.focus();
  }, [talking]);
  useEffect(() => {
    if (!talking && !centralDetail && !sideDetail) return;
    // The topmost layer closes first.
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || event.defaultPrevented || event.isComposing
      ) return;
      event.preventDefault();
      if (sideDetail) {
        setSideDetail(null);
        sideNameButton.current?.focus();
      } else if (centralDetail) {
        setCentralDetail(null);
        centralNameButton.current?.focus();
      } else closeConversation();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [talking, centralDetail, sideDetail]);
  useEffect(() => {
    if (!started) return;
    // A historical inspection belongs to the graph; elsewhere the desk is live.
    if (graphShown) {
      void synchronizeModelLocation(
        state,
        Object.fromEntries(location.searchParams),
      );
    } else if (state.readOnly.peek() || state.graphSourceSelection.peek()) {
      state.resetToCurrent();
    }
  }, [graphShown, initialUrl, started]);

  const decisions = state.pendingDecisions.value;
  const operators = arrivalOrder(
    (roster?.conversations ?? []).filter((entry) =>
      entry.agentId !== centralId
    ),
    state.agentConversations.arrivals.value,
  );
  // With Cases, the Dock shows open Cases; other operators are reached from the
  // Case that uses them and from the central agent's name. Without Cases (an
  // older backend answers 404), the Dock keeps the operator conversations.
  const caseTile = (record: CaseRecord): DockWork => {
    const opened = (scheduledCase?.id ?? selectedCaseId) === record.id;
    const owner =
      (record.type === "request"
        ? state.requests.snapshots.value.get(record.id)?.conversations
        : roster?.conversations)?.find((entry) =>
          entry.nativeId === record.owner
        );
    const kind = record.type === "request"
      ? "Case"
      : record.type === "job"
      ? "Job"
      : "Watch";
    return {
      kind: "case",
      caseType: record.type,
      id: record.id,
      name: `${kind} · ${caseTitle(record)}`,
      tile: monogram(caseTitle(record)),
      busy: owner?.busy ?? false,
      pending: caseHasPendingDecision(
        record,
        openCases,
        owner?.agentId,
        decisions,
      ),
      active: opened && (!modelOpen || modelSplit),
      href: modelOpen
        ? modelConversationHref(
          location.pathname + location.search,
          conversationContext,
          {
            caseId: record.id,
            agentId: selectedAgents.current.get(record.id) ?? null,
          },
          record.type === "request" && selectedAgents.current.get(record.id)
            ? caseAgentHref(record.id, selectedAgents.current.get(record.id)!)
            : caseHref(record.id, record.type),
        )
        : opened
        ? conversationHref()
        : record.type === "request"
        ? viewHref(caseHref(record.id, record.type), {
          main: location.searchParams.get("main") === "hidden"
            ? "hidden"
            : null,
        })
        : caseHref(record.id, record.type),
    };
  };
  const withCases = state.cases.supported.value === true ||
    state.requests.cases.supported.value === true;
  const caseActions: CaseActions = {
    run: (id) => void state.cases.act(id, "run"),
    pause: (id) => void state.cases.act(id, "pause"),
    resume: (id) => void state.cases.act(id, "resume"),
    stop: (id) => void state.cases.act(id, "stop"),
    busy: state.cases.acting.value,
  };
  const openCases = withCases
    ? [
      ...state.cases.open.value.filter((record) => record.type !== "request"),
      ...state.requests.cases.open.value,
    ]
    : [];
  // A decision recorded in an open Case waits on that Case, its tile and its
  // page; the agent's own circle lights for what waits in its conversation.
  const waitsInCase = (decision: PendingDecision) =>
    decision.caseId !== undefined &&
    openCases.some((record) => record.id === decision.caseId);
  const pendingFor = (agentId: string) =>
    decisions.some((decision) =>
      decision.agentId === agentId && !waitsInCase(decision)
    );
  // Jobs and Watches stand on the right of the logo, each kind behind one
  // button that unfolds vertically; Requests are conversations, on the left.
  const scheduled = (type: "job" | "watch") =>
    openCases.filter((record) => record.type === type).map((record) => ({
      ...caseTile(record),
      name: caseTitle(record),
      detail: caseDetail(record),
    }));
  const stacks: DockStackGroup[] = withCases
    ? [{
      id: "jobs",
      label: "Jobs",
      items: scheduled("job"),
      empty:
        `No jobs yet. Ask ${centralName} for something to do on a schedule.`,
    }, {
      id: "watches",
      label: "Watches",
      items: scheduled("watch"),
      empty: `No watches yet. Ask ${centralName} to keep an eye on something.`,
    }]
    : [];
  // A Request closed within the day stays reachable, dimmed, next to the logo:
  // the first work to join the pile when space runs out.
  const closedTile = (record: CaseRecord): DockWork => ({
    ...caseTile(record),
    busy: false,
    pending: false,
    closed: true,
  });
  // Left of the logo, as in a Mac Dock: every open Request, on every page, and
  // the Cases the person pinned (any kind). The Dock puts pinned ones next to
  // the Requests button and piles the oldest unpinned Requests when crowded.
  const pinnedCases = pins.ids.value.flatMap((id) => {
    const record = recordFor(id);
    return record ? [record] : [];
  });
  const openRequests = openCases
    .filter((record) => record.type === "request" && !pins.has(record.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const work: DockWork[] = withCases
    ? [
      ...openRequests.map(caseTile),
      ...pinnedCases.map((record) => ({
        ...(isOpenCase(record) ? caseTile(record) : closedTile(record)),
        pinned: true,
      })),
    ]
    : operators.map((entry) => {
      const opened = sideAgentId === entry.agentId;
      return {
        kind: "agent",
        id: entry.agentId,
        name: entry.name,
        busy: entry.busy,
        pending: pendingFor(entry.agentId),
        active: opened,
        href: opened ? deskHome : conversationHref(entry.agentId),
      };
    });
  // An owned Request can explain waiting, but the backend does not identify
  // which Case is running. A busy header must therefore stay unnumbered.
  const centralBusy = Boolean(central ? central.busy : current?.busy);
  const waitingCase =
    state.cases.open.value.find((record) =>
      record.owner === central?.nativeId && record.type === "request"
    ) ?? null;
  const centralActivity = agentActivity({
    busy: centralBusy,
    openCase: centralBusy ? null : waitingCase,
    decisionWaiting: central
      ? pendingFor(central.agentId)
      : decisions.some((decision) => !decision.agentId),
  });
  const team = operators.map((entry) => ({
    agentId: entry.agentId,
    name: entry.name,
    busy: entry.busy,
    href: conversationHref(entry.agentId),
  }));
  const placeHref = (saved: string) =>
    modelPlaceConversationHref(
      withModelViewContext(
        modelOpen
          ? currentInspectionHref(
            reopenModelViewContext(saved, conversationContext),
            location,
          )
          : reopenModelViewContext(saved, conversationContext),
        conversationContext,
      ),
      modelOpen && modelConversationHidden(location),
      modelOpen
        ? globalMainSelected
        : Boolean(showCases && selectedCaseId && designerShown),
    );
  const places: DockPlace[] = [
    {
      id: "system",
      label: "System",
      href: item?.kind === "system"
        ? closePanelHref
        : placeHref(systemPlaceHref.current),
      context: { name: contextName, tint: contextTint },
      pending: false,
      active: item?.kind === "system",
    },
    {
      id: "model",
      label: "Model",
      href: item?.kind === "model"
        ? closePanelHref
        : placeHref(modelPlaceHref.current),
      context: { name: contextName, tint: contextTint },
      pending: decisions.some((decision) => decision.kind === "proposal"),
      active: item?.kind === "model",
    },
    {
      id: "activity",
      label: "Activity",
      href: item?.kind === "activity" ? deskHome : PLACE_PATH.activity,
      pending: false,
      active: item?.kind === "activity",
      count: state.pendingDecisionCount.value,
    },
  ];
  const connectionLabel = connection === "live"
    ? "Live"
    : connection === "connecting"
    ? "Connecting…"
    : connection === "closed"
    ? "Disconnected"
    : "Reconnecting…";

  return (
    <div class="workbench desk">
      <header class="desk-titlebar">
        <div class="desk-titlebar-start">
          <AppMenu
            systemName={systemName}
            version={versionLabel}
            provider={current?.provider}
          />
        </div>
        <div class="workspace-identity">
          <WorkspaceVersion
            followHead={modelOpen && !titleCaseId && !inspectedVersion &&
              !modelScopeUnavailable &&
              location.searchParams.get("page") !== "graph"}
            info={{
              ...titleVersion,
              qualifiedName: systemName,
              modelDigest: !titleCaseId && titleVersion.version === modelVersion
                ? modelDigest
                : undefined,
            }}
          />
        </div>
        <div class="desk-titlebar-end">
          {modelOpen && contextCaseId && (
            <a
              class="button"
              href={conversationHref()}
              aria-label="Leave Request context"
            >
              Leave Request
            </a>
          )}
          {/* The connection shows only when something is wrong. */}
          {(connection === "reconnecting" || connection === "closed") && (
            <div class="connection" id="connection" role="status">
              <span class="dot" />
              <span id="connection-label">{connectionLabel}</span>
            </div>
          )}
        </div>
      </header>
      <p class="error" id="error" role="alert" hidden={!state.error.value}>
        {state.error.value}
      </p>
      {modelOpen && inspectedVersion &&
        (!creatingRelease ||
          Boolean(
            resolvedScope &&
              resolvedScope.version !== resolvedScope.executionVersion,
          ) ||
          Boolean(mainReleaseContext?.divergent)) &&
        (!resolvedScope ||
          resolvedScope.version !== resolvedScope.executionVersion) &&
        (
          <p class="model-inspection" role="status">
            Read-only inspection ·{" "}
            {inspectedVersion}. The conversation keeps its current model.{" "}
            <a href={currentContextModelHref(location)}>
              Return to current model
            </a>
          </p>
        )}
      <main
        id="workspace"
        class={`desk-stage${
          (modelSplit || !modelOpen && designerShown) ? " is-talking" : ""
        }${modelSplit ? " has-model-context" : ""}${item ? " has-item" : ""}`}
        data-view={active}
        onPointerDown={(event) => {
          // A click on the bare desk puts the conversation away, like a popover.
          if (talking && event.target === event.currentTarget) {
            closeConversation();
          }
        }}
      >
        <section
          class="chat desk-panel desk-conversation"
          id="chat-panel"
          aria-label={`Conversation with ${panelName}`}
          hidden={!designerShown}
          ref={panel}
        >
          <AgentHeader
            state={state}
            conversation={central ?? undefined}
            fallbackName={panelName}
            detail={centralDetail}
            onDetail={setCentralDetail}
            nameRef={centralNameButton}
            historicalRevision={historicalRevision}
            team={team}
            activity={centralActivity}
          >
            <CloseLink
              label="Close conversation"
              href={closeConversationHref}
            />
          </AgentHeader>
          <ChatView
            state={state}
            active={designerShown}
            showHeading={false}
            presentHref={graphHome ?? undefined}
            target={withCases ? "designer" : undefined}
          />
        </section>
        <section
          class="chat desk-panel desk-view desk-agent"
          id="agent-panel"
          aria-label={sideName}
          hidden={item?.kind !== "agent"}
        >
          <AgentHeader
            state={state}
            conversation={sideAgent}
            fallbackName={sideName}
            detail={sideDetail}
            onDetail={setSideDetail}
            idPrefix="side-"
            nameRef={sideNameButton}
          >
            <CloseLink label={`Close ${sideName}`} />
          </AgentHeader>
          <ChatView
            state={state}
            active={item?.kind === "agent"}
            showHeading={false}
            conversation={sideAgent}
            idPrefix="agent-"
          />
        </section>
        <section
          class={`desk-panel desk-view desk-cases${
            modelSplit && contextCaseId ? " is-context-conversation" : ""
          }`}
          id="cases-panel"
          aria-label="Requests"
          hidden={!requestShown}
        >
          {(!modelOpen || modelSplit) && (
            <CloseLink
              label={modelSplit ? "Close conversation" : "Close Requests"}
              href={modelSplit
                ? closeConversationHref
                : selectedCaseId
                ? conversationHref()
                : deskHome}
            />
          )}
          <CasesPage
            state={state}
            active={requestShown}
            compact={modelOpen || !requestShown && Boolean(requestSelection)}
            selectedId={selectedCaseId ?? requestSelection?.caseId ?? null}
            agentId={namedAgentId ?? requestSelection?.agentId ?? null}
            decisions={decisions}
            onStarted={(caseId) => {
              setStartedCase(caseId);
              showAddress(viewHref(caseHref(caseId), {
                main: location.searchParams.get("main") === "hidden"
                  ? "hidden"
                  : null,
              }));
            }}
            onBack={backToList}
            mainHidden={location.searchParams.get("main") === "hidden"}
          />
        </section>
        <section
          class={`desk-panel desk-view desk-case${
            modelSplit && scheduledCase ? " is-context-conversation" : ""
          }`}
          id="case-panel"
          aria-label={scheduledCase ? caseTitle(scheduledCase) : "Case"}
          hidden={!scheduledCase || (modelOpen && !modelSplit)}
        >
          <CloseLink label="Close case view" href={closeConversationHref} />
          <CaseView
            state={state}
            record={scheduledCase}
            caseId={namedCaseId}
            actions={withCases ? caseActions : undefined}
          />
        </section>
        <section
          class="model desk-panel desk-view"
          id="system-panel"
          aria-label="System"
          hidden={item?.kind !== "system"}
        >
          <CloseLink label="Close System" href={closePanelHref} />
          {/* Links inside keep the address's context: a hidden conversation stays hidden. */}
          {item?.kind === "system" && (
            <ModelLinkContext.Provider value={location.search}>
              <SystemFrame
                state={state}
                page={item.page}
                location={{ search: location.search }}
              />
            </ModelLinkContext.Provider>
          )}
        </section>
        <section
          class="revisions desk-panel desk-view"
          id="model-panel"
          aria-label="Model"
          hidden={item?.kind !== "model"}
        >
          <CloseLink label="Close Model" href={closePanelHref} />
          {item?.kind === "model" && (
            <ModelLinkContext.Provider value={location.search}>
              <ModelSpace
                state={state}
                page={item.page}
                location={{
                  pathname: location.pathname,
                  search: location.search,
                }}
                operators={runtimeRevisionOperators(roster?.conversations)}
              />
            </ModelLinkContext.Provider>
          )}
        </section>
        <section
          class="decide desk-panel desk-view"
          id="activity-panel"
          aria-label="Activity"
          hidden={item?.kind !== "activity"}
        >
          <CloseLink label="Close Activity" />
          {item?.kind === "activity" && (
            <ActivityPlace state={state} started={started} />
          )}
        </section>
      </main>
      <Dock
        work={work}
        stacks={stacks}
        cases={withCases
          ? {
            // A Case on the page goes back to the list; the list closes.
            href: showCases && !selectedCaseId ? deskHome : viewHref("/cases", {
              main: location.searchParams.get("main") === "hidden"
                ? "hidden"
                : null,
            }),
            active: showCases,
            onNavigate: backToList,
          }
          : undefined}
        places={places}
        central={{
          name: centralName,
          busy: Boolean(central ? central.busy : current?.busy),
          pending: central
            ? pendingFor(central.agentId)
            : decisions.some((decision) =>
              decision.kind !== "proposal" && !decision.agentId
            ),
        }}
        talking={designerShown}
        designerHref={modelOpen
          ? modelConversationHref(
            location.pathname + location.search,
            conversationContext,
            { caseId: null, agentId: null },
            conversationHref(),
          )
          : showCases
          ? viewHref(location.pathname + location.search, {
            main: designerShown ? "hidden" : null,
          })
          : scheduledCase || sideAgentId
          ? conversationHref()
          : undefined}
        onTalk={() => talking ? closeConversation() : openConversation()}
        circleRef={circle}
      />
    </div>
  );
}

export default function Workbench({ initialUrl }: { initialUrl: string }) {
  const state = useMemo(() => createWorkbenchState(), []);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const cleanup = state.start();
    setStarted(true);
    return cleanup;
  }, [state]);
  return <Workspace state={state} started={started} initialUrl={initialUrl} />;
}

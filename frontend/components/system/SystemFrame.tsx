import { createDiagnosticsApi } from "../../lib/system/diagnostics.ts";
import {
  requestVersionInfo,
  type VersionInfo,
} from "../../lib/workbench/version-label.ts";
import {
  type DiagnosticsApi,
  useSystemDiagnostics,
} from "./useSystemDiagnostics.ts";
import { SystemDiagnostics } from "./SystemDiagnostics.tsx";
import { SystemElementSearch } from "./SystemElementSearch.tsx";
import { usePerformance } from "./performance/usePerformance.ts";
import type { PerformanceStore } from "../../lib/system/performance/store.ts";
import { CaseModelBoundary } from "../view/CaseModelBoundary.tsx";
import { createBoardApi } from "../../lib/system/board/api.ts";
import { createMatrixApi } from "../../lib/system/rights/api.ts";
import { useEffect, useMemo } from "preact/hooks";
import {
  inheritModelViewContext,
  unavailableModelScope,
} from "../../lib/workbench/model-context.ts";
import type { OperatorToolsSnapshot } from "../../../src/domain/work/records/conversations.ts";
import { type BoardApi, boardCanRetry } from "../../lib/system/board/api.ts";
import type { BoardStore } from "../../lib/system/board/store.ts";
import {
  monogram,
  SYSTEM_MORE,
  SYSTEM_PAGE_NAMES,
  SYSTEM_TABS,
  systemHref,
  type SystemPage,
} from "../../lib/workbench/desk.ts";
import { detailOf } from "../../lib/system/board/detail.ts";
import { type MatrixApi, matrixCanRetry } from "../../lib/system/rights/api.ts";
import type { MatrixStore } from "../../lib/system/rights/store.ts";
import type { ModelLive } from "../../lib/model/live.ts";
import type { RevisionLocation } from "../../lib/model/revisions/api.ts";
import { ownerIdsFor } from "../../lib/system/tools/candidates.ts";
import {
  agentsByOperator,
  type BranchRef,
  teamOf,
} from "../../lib/system/team/projection.ts";
import { performanceView } from "../../lib/system/performance/kpis.ts";
import { caseTitle } from "../../lib/cases/cases.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import {
  mainActorOf,
  operatorActorOf,
  type ReferenceRights,
  rightsOf,
} from "../../lib/system/rights/projection.ts";
import {
  type BranchMatrixReader,
  useBranchRights,
} from "./rights/useBranchRights.ts";
import { operatorTools, toolServers } from "../../lib/system/tools/servers.ts";
import {
  flowOf,
  selectionOf,
  versionOf,
} from "../../lib/workbench/view-location.ts";
import { type ViewPrefs, viewPrefs } from "../../lib/system/view-prefs.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { PageFrame } from "../view/PageFrame.tsx";
import { ReadFailure } from "../view/ReadFailure.tsx";
import { AllocationsPage } from "./AllocationsPage.tsx";
import { BoardVersion } from "./board/BoardVersion.tsx";
import { ExplorePage } from "./ExplorePage.tsx";
import { FlowsPage } from "./flows/FlowsPage.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import { PartsPage } from "./parts/PartsPage.tsx";
import { RequirementsPage } from "./RequirementsPage.tsx";
import { RightsPage } from "./rights/RightsPage.tsx";
import { TeamPage } from "./team/TeamPage.tsx";
import { PerformancePage, PerformanceSummary } from "./PerformancePage.tsx";
import { useBoard } from "./board/useBoard.ts";
import { useMatrix } from "./rights/useMatrix.ts";

/**
 * The pages that tell the model in the viewer's words, and so offer the choice
 * of them. A control the page does not obey is not shown: Team has no use of it.
 */
const READS_MODE: readonly SystemPage[] = [
  "explore",
  "flows",
  "requirements",
  "rights",
  "parts",
  "allocations",
];

/** A page of the place as a link: it is read at the version the person looks at, its selection is its own. */
const pageLink = (version: string | undefined) => (id: SystemPage) => ({
  id,
  label: SYSTEM_PAGE_NAMES[id],
  href: systemHref(id, { version }),
});

/** The tools an operator has, by server: what it runs, not what the model declares. */
function serversFor(
  catalogue: OperatorToolsSnapshot | null,
  agentIds: readonly string[],
) {
  if (!catalogue || agentIds.length === 0) return undefined;
  const { candidates, modelTools } = operatorTools(catalogue, agentIds);
  return toolServers(candidates, modelTools);
}

/**
 * The System place: the model as the people who work with it read it, in the
 * frame every page of a place shares. The pages are drawn from one board, the
 * model at one commit (the admitted head, or the version the address asks
 * for with `?version=`), read when the place opens and again when a decision
 * anywhere, or the host's word that the model moved, moves the head. A board
 * that cannot be read again stays on show with the reason beside it. Only the
 * page shown is mounted.
 *
 * Pages that open an element in place are given a `Detail` (lib/element-detail.ts)
 * built from the address, the viewer's mode and the names the team goes by.
 * Rights also reads the authority matrix of the commit the board describes,
 * when that page is shown; the page is drawn without it while it is read. The
 * matrix follows the head through the board: when the board reads a new
 * commit, the matrix of that commit is read in its turn.
 */
interface SystemFrameProps {
  state: WorkbenchState;
  page: SystemPage;
  /** The address: `?select=` says what the page opens, `?version=` what it reads. */
  location: Pick<RevisionLocation, "search">;
  /** The board, when the caller owns it; the place reads its own otherwise. */
  board?: BoardStore;
  /** What the place's own board reads from; the host's route when absent. */
  api?: Pick<BoardApi, "read">;
  /** The host's word on the model, when it moves; the tab's own when absent. */
  live?: ModelLive;
  /** The authority matrix, when the caller owns it; the place reads its own otherwise. */
  matrix?: MatrixStore;
  /** What the place's own matrix reads from; the host's route when absent. */
  matrixApi?: Pick<MatrixApi, "read">;
  /** In a Case, the global Main's matrix, when the caller owns it; read from the host's route otherwise. */
  mainMatrix?: MatrixStore;
  /** On the main system, what the open Cases' rights are read from; each Case's facade when absent. */
  branchMatrixReader?: BranchMatrixReader;
  /** How the viewer likes the pages told; the browser's own choice when absent. */
  prefs?: ViewPrefs;
  /** Optional caller-owned shared readout, matching the board/matrix injection pattern. */
  performance?: PerformanceStore;
  /** Uses the same scoped fetch as the board for Request diagnostics. */
  diagnosticsApi?: DiagnosticsApi;
}

interface ResolvedSystemFrameProps extends SystemFrameProps {
  versionInfo: VersionInfo;
  /** Host-resolved execution pin of a Request, when present. */
  executionVersion?: string;
}

const REQUEST_MORE: readonly SystemPage[] = [
  "explore",
  "flows",
  "requirements",
  "diagnostics",
  ...SYSTEM_MORE,
];
const systemNavigation = (request: boolean) =>
  request
    ? {
      tabs: SYSTEM_TABS.filter((page) => !REQUEST_MORE.includes(page)),
      more: REQUEST_MORE,
    }
    : { tabs: SYSTEM_TABS, more: SYSTEM_MORE };

export function SystemFrame(props: SystemFrameProps) {
  const { page, location, prefs = viewPrefs } = props;
  const search = new URLSearchParams(location.search);
  const caseId = search.get("caseBranch");
  const unavailable = unavailableModelScope(search);
  useEffect(() => {
    if (!unavailable) prefs.restore();
  }, [prefs, unavailable]);
  if (caseId && !search.has("branch")) {
    // The Case's own word on its model, from the workbench's one connection:
    // its scope and its pages follow it as the main pages follow the host's.
    const caseLive = props.state.caseModelLive(caseId);
    return (
      <CaseModelBoundary
        caseId={caseId}
        sessionReady={props.state.requests.sessionReady.value}
        sessionGeneration={props.state.requests.sessionGeneration.value}
        search={location.search}
        version={search.get("version") ?? undefined}
        live={caseLive}
        render={(scope, request, scopedSearch) => (
          <ScopedSystemFrame
            {...props}
            versionInfo={requestVersionInfo(
              props.state.requests.cases.byId(caseId) ?? { id: caseId },
              scope,
            )}
            location={{ search: scopedSearch }}
            request={request}
            executionVersion={scope.executionVersion}
            live={caseLive}
          />
        )}
      />
    );
  }
  if (unavailable) {
    const navigation = systemNavigation(Boolean(caseId));
    const link = (id: SystemPage) => ({
      id,
      label: SYSTEM_PAGE_NAMES[id],
      href: inheritModelViewContext(
        systemHref(id, {
          version: new URLSearchParams(location.search).get("version"),
        }),
        location.search,
      ),
    });
    return (
      <PageFrame
        label="System pages"
        title={SYSTEM_PAGE_NAMES[page]}
        tabs={navigation.tabs.map(link)}
        more={{ tabs: navigation.more.map(link) }}
        current={page}
        layout="column"
      >
        <p class="proposal-error" role="alert">
          This branch is unavailable on this host. Its model cannot be
          displayed.
        </p>
      </PageFrame>
    );
  }
  return (
    <MainSystemFrame
      {...props}
      versionInfo={{
        source: { kind: "main" },
        inService: props.state.current.value?.executionModel?.version
          .repositoryVersion,
        readOnly: search.has("version"),
      }}
    />
  );
}

function MainSystemFrame(
  {
    state,
    page,
    location,
    board,
    api,
    live,
    matrix,
    matrixApi,
    mainMatrix,
    branchMatrixReader,
    prefs = viewPrefs,
    executionVersion,
    performance,
    diagnosticsApi,
    versionInfo,
  }: ResolvedSystemFrameProps,
) {
  const address = { searchParams: new URLSearchParams(location.search) };
  const requestCaseId = address.searchParams.get("caseBranch");
  const navigation = systemNavigation(Boolean(requestCaseId));
  const requestCase = requestCaseId
    ? state.requests.cases.byId(requestCaseId)
    : undefined;
  const requestRecord = requestCase?.type === "request" ? requestCase : null;
  const requestOwnerId = requestRecord?.owner;
  // The Case's operator goes by a name on the Case's initials.
  const branchName = requestRecord
    ? branchOperatorName(requestRecord)
    : undefined;
  const asked = versionOf(address) ?? undefined;
  const selected = selectionOf(address);
  const flow = flowOf(address);
  const store = useBoard({
    board,
    api,
    live,
    asked,
    // A decision on the main system moves the main head, not a Case's.
    moves: requestCaseId ? undefined : state.chatProposals.generation.value,
  });

  const mode = prefs.mode.value;

  const held = store.state.value;
  // A board is drawn only for the version the page asked for: after the
  // address changes, the one read for the other is not shown for a frame.
  const read = held.asked === asked ? held : undefined;
  // The matrix is the matrix of the commit the board describes, never another.
  const { store: matrixStore, read: matrixRead } = useMatrix({
    matrix,
    api: matrixApi,
    page,
    board: read,
  });
  // A Case is a branch of the system: its pages draw the branch. The global
  // Main runs the main system, so it is drawn beside the Case's team and
  // rights, read from the host's own routes at the version it runs.
  const mainVersion = requestCaseId
    ? state.current.value?.executionModel?.version.repositoryVersion
    : undefined;
  const { read: mainMatrixRead } = useMatrix({
    matrix: mainMatrix,
    page,
    board: mainVersion ? { version: mainVersion } : undefined,
  });
  // The Case runs the same operator as the Main: its owner names the Main's row.
  // The line stays while the main rights are read, and when they cannot be.
  const mainRights = useMemo((): ReferenceRights | undefined => {
    if (!requestCaseId || !requestOwnerId) return undefined;
    const rights = rightsOf(mainMatrixRead?.matrix, []);
    return {
      rights,
      actor: mainActorOf(rights, requestOwnerId),
      href: systemHref("rights", { version: mainVersion }),
      initials: monogram("Main Operator"),
      about: "Its rights on the main system",
      problem: mainMatrixRead?.problem
        ? "Its rights on the main system could not be read"
        : undefined,
    };
  }, [
    requestCaseId,
    requestOwnerId,
    mainMatrixRead?.matrix,
    mainMatrixRead?.problem,
    mainVersion,
  ]);
  const performanceRead = usePerformance({
    store: performance,
    page,
    version: read?.board ? read.version : undefined,
    caseId: address.searchParams.get("caseBranch") ?? undefined,
    sessionReady: state.requests.sessionReady.value,
    refreshGeneration: state.performanceGeneration.value,
    sessionGeneration: state.requests.sessionGeneration.value,
    closedAt: requestRecord?.closedAt,
  });
  const diagnostics = useSystemDiagnostics({
    api: diagnosticsApi,
    active: page === "diagnostics" && Boolean(read?.board),
    version: read?.board ? read.version : undefined,
    caseId: address.searchParams.get("caseBranch") ?? undefined,
    sessionReady: state.requests.sessionReady.value,
    sessionGeneration: state.requests.sessionGeneration.value,
    refreshGeneration: state.chatProposals.generation.value,
    live,
  });
  // Versioned inspection cannot borrow today's runtime roster or tool
  // catalogue, and a Case does not borrow the main system's.
  const showRuntime = asked === undefined && !requestCaseId &&
    !state.readOnly.value;
  const roster = showRuntime
    ? state.conversationSnapshot.value?.conversations
    : undefined;
  // On the main system as it runs, the Main supervises the Branch Operators of
  // the open Requests: the newest first, each leading to its Case's Team.
  const openRequests = state.requests.cases.open.value;
  const branches = useMemo(
    (): readonly BranchRef[] | undefined =>
      requestCaseId || !showRuntime ? undefined : [...openRequests]
        .filter((record) => record.type === "request")
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((record) => ({
          caseId: record.id,
          title: caseTitle(record, 24),
          name: branchOperatorName(record),
          owner: record.owner,
          href: systemHref("team", { caseBranch: record.id }),
        })),
    [requestCaseId, showRuntime, openRequests],
  );
  // On Rights, each of them with its rights in its own branch, at the version
  // it runs: its scope follows its adoptions, so a changed version is read
  // again and the line follows.
  const scopes = state.requests.scopes.value;
  useEffect(() => {
    if (page !== "rights") return;
    for (const branch of branches ?? []) {
      if (!scopes.has(branch.caseId)) {
        void state.requests.loadScope(branch.caseId);
      }
    }
  }, [page, branches]);
  const branchVersions = useMemo(
    () =>
      (branches ?? []).map((branch) => ({
        caseId: branch.caseId,
        version: scopes.get(branch.caseId)?.executionVersion,
      })),
    [branches, scopes],
  );
  const branchMatrices = useBranchRights(
    page,
    branchVersions,
    branchMatrixReader,
  );
  const branchRights = useMemo(
    (): readonly ReferenceRights[] | undefined =>
      branches?.map((branch) => {
        const read = branchMatrices.get(branch.caseId);
        const rights = rightsOf(
          read?.status === "read" ? read.matrix : undefined,
          [],
        );
        return {
          rights,
          actor: operatorActorOf(rights, branch.owner, {
            id: `branch:${branch.caseId}`,
            label: branch.name,
          }),
          href: systemHref("rights", { caseBranch: branch.caseId }),
          initials: monogram(branch.name),
          about: `Branch Operator · ${branch.title} · its rights in its branch`,
          problem: read?.status === "failed"
            ? "Its rights in its branch could not be read"
            : undefined,
        };
      }),
    [branches, branchMatrices],
  );
  // Provider calls name operators by element: the board names them as Team does.
  const performanceShown = useMemo(() => {
    const agents = read?.board
      ? agentsByOperator(
        read.board,
        roster ?? NO_ROSTER,
        requestOwnerId,
        branchName,
      )
      : undefined;
    return performanceView({
      read: performanceRead,
      scope: requestCaseId
        ? { kind: "request", record: requestRecord }
        : { kind: "main" },
      agentOf: (operatorId) => agents?.get(operatorId),
    });
  }, [
    read?.board,
    roster,
    requestOwnerId,
    branchName,
    performanceRead,
    requestCaseId,
    requestRecord,
  ]);
  const catalogue = showRuntime ? state.visibleOperatorTools.value : null;
  const runtime = showRuntime
    ? {
      catalogue,
      loading: state.operatorTools.loading.value,
      stale: state.operatorTools.stale.value,
      error: state.operatorTools.error.value,
    }
    : undefined;
  const problem = read?.problem;
  // Reading again helps when the host or the Toolkit did not answer, not when
  // the version asked for is not one or the answer is not a board.
  const retry = problem && boardCanRetry(problem);
  const matrixFailure = matrixRead?.problem;
  // Units are called as the team calls them: the roster knows names the model does not.
  const detail = useMemo(() => {
    if (
      !read?.board || page === "team" || page === "performance" ||
      page === "diagnostics"
    ) {
      return undefined;
    }
    const team = teamOf(
      read.board,
      roster ?? NO_ROSTER,
      requestOwnerId,
      branchName,
    );
    return detailOf({
      board: read.board,
      page,
      selected,
      sysml: mode === "sysml",
      version: asked,
      names: new Map(team.agents.map((agent) => [agent.id, agent.name])),
    });
  }, [
    read?.board,
    roster,
    page,
    selected,
    mode,
    asked,
    requestOwnerId,
    branchName,
  ]);

  // The same page at the head: what it opens and the flow it reads stay, the version goes.
  const atHead = systemHref(page, {
    flow: page === "flows" ? flow : null,
    select: selected,
  });

  return (
    <PageFrame
      label="System pages"
      title={SYSTEM_PAGE_NAMES[page]}
      tabs={navigation.tabs.map(pageLink(asked))
        .map((tab) => ({
          ...tab,
          href: inheritModelViewContext(tab.href, location.search),
        }))}
      more={{
        tabs: navigation.more.map(pageLink(asked))
          .map((tab) => ({
            ...tab,
            href: inheritModelViewContext(tab.href, location.search),
          })),
      }}
      current={page}
      layout="column"
      actions={
        <>
          {READS_MODE.includes(page) && (
            <ModeSwitch mode={mode} onChange={prefs.set} />
          )}
          <SystemElementSearch
            board={read?.board}
            version={asked}
            locationSearch={location.search}
          />
        </>
      }
    >
      {read?.board && read.version && (
        <BoardVersion
          version={read.version}
          pinned={executionVersion === undefined
            ? asked !== undefined
            : read.version !== executionVersion}
          info={{
            ...versionInfo,
            headVersion: versionInfo.source.kind === "main" && !asked
              ? read.version
              : versionInfo.headVersion,
          }}
          home={atHead}
        />
      )}
      {problem && (
        <ReadFailure
          problem={problem}
          again={retry
            ? {
              run: () => void store.open(asked),
              busy: read?.loading,
              wait: problem.retryAfter,
            }
            : undefined}
          home={asked ? atHead : undefined}
        />
      )}
      {!read?.board && !problem && (
        <p class="rev-empty" role="status">Reading the system…</p>
      )}
      {read?.board && page === "team" && (
        <div class="system-team-layout">
          <aside class="system-performance-rail">
            <PerformanceSummary
              view={performanceShown}
              href={inheritModelViewContext(
                systemHref("performance", { version: asked }),
                location.search,
              )}
            />
          </aside>
          <div class="system-team-content">
            <TeamPage
              board={read.board}
              roster={roster ?? NO_ROSTER}
              selected={selected}
              hrefOf={(agentId) =>
                systemHref("team", { select: agentId, version: asked })}
              serversOf={(nativeIds) =>
                serversFor(
                  catalogue,
                  ownerIdsFor(nativeIds, roster ?? NO_ROSTER),
                )}
              runtime={runtime}
              requestOwnerId={requestOwnerId}
              branchName={branchName}
              mainHref={requestCaseId ? systemHref("team") : undefined}
              branches={branches}
            />
          </div>
        </div>
      )}
      {read?.board && page === "performance" && (
        <PerformancePage
          key={performanceRead.key ?? "unavailable"}
          view={performanceShown}
          hrefOf={(agentId) =>
            systemHref("team", { select: agentId, version: asked })}
        />
      )}
      {read?.board && read.version && page === "diagnostics" && (
        <>
          {diagnostics.refreshing && (
            <p role="status">Refreshing diagnostics…</p>
          )}
          <SystemDiagnostics
            version={read.version}
            locationSearch={location.search}
            read={diagnostics.read}
          />
        </>
      )}
      {read?.board && detail && page === "explore" && (
        <ExplorePage
          board={read.board}
          detail={detail}
          runtime={runtime}
          roster={roster}
          historical={!showRuntime}
        />
      )}
      {read?.board && detail && page === "flows" && (
        <FlowsPage
          board={read.board}
          detail={detail}
          flow={flow}
        />
      )}
      {read?.board && detail && page === "requirements" && (
        <RequirementsPage board={read.board} detail={detail} />
      )}
      {read?.board && detail && page === "parts" && (
        <PartsPage board={read.board} detail={detail} />
      )}
      {read?.board && detail && page === "allocations" && (
        <AllocationsPage board={read.board} detail={detail} />
      )}
      {read?.board && detail && page === "rights" && (
        <>
          {matrixFailure && (
            <ReadFailure
              problem={matrixFailure}
              again={matrixCanRetry(matrixFailure)
                ? {
                  run: () => void matrixStore.open(read.version),
                  busy: matrixRead?.loading,
                  wait: matrixFailure.retryAfter,
                }
                : undefined}
              home={asked ? atHead : undefined}
            />
          )}
          {!matrixRead?.matrix && !matrixFailure && (
            <p class="rev-empty" role="status">Reading the rights…</p>
          )}
          <RightsPage
            detail={detail}
            matrix={matrixRead?.matrix}
            main={mainRights}
            branches={branchRights}
          />
        </>
      )}
    </PageFrame>
  );
}

const NO_ROSTER: readonly never[] = [];

function ScopedSystemFrame(
  props: ResolvedSystemFrameProps & { request: typeof fetch },
) {
  const api = useMemo(() => createBoardApi({ fetch: props.request }), [
    props.request,
  ]);
  const matrixApi = useMemo(() => createMatrixApi({ fetch: props.request }), [
    props.request,
  ]);
  const diagnosticsApi = useMemo(
    () => createDiagnosticsApi({ fetch: props.request }),
    [props.request],
  );
  return (
    <MainSystemFrame
      {...props}
      api={api}
      matrixApi={matrixApi}
      diagnosticsApi={diagnosticsApi}
    />
  );
}

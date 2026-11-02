import { createRequestSourceRevisionApi } from "../../lib/model/sources/request-revisions.ts";
import {
  createRequestSourceEditor,
  type RequestEditScope,
  type RequestSourceEditor,
} from "../../lib/model/sources/request-edit.ts";
import { refreshCaseSourceMetadata } from "../../lib/case-model-scope.ts";
import { createSavedSystemsApi } from "../../lib/system/saved-systems.ts";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { CaseModelBoundary } from "../view/CaseModelBoundary.tsx";
import { createModelFiles } from "../../lib/model/sources/files.ts";
import { createRevisionApi } from "../../lib/model/revisions/api.ts";
import { createViewsApi } from "../../lib/model/diagrams/api.ts";
import {
  inheritModelViewContext,
  unavailableModelScope,
} from "../../lib/workbench/model-context.ts";
import type {
  RevisionLocation,
  RuntimeOperator,
} from "../../lib/model/revisions/api.ts";
import {
  MODEL_PAGES,
  modelHref,
  type ModelPage,
} from "../../lib/workbench/desk.ts";
import {
  type AuthorRoster,
  authorRoster,
} from "../../lib/model/revisions/authors.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { toolProposalSelection } from "../../lib/model/tool-proposal-location.ts";
import { ToolProposalDetail } from "./changes/ToolProposalDetail.tsx";
import { GraphView } from "../graph/GraphView.tsx";
import { PageFrame } from "../view/PageFrame.tsx";
import { ActivityPage } from "./activity/ActivityPage.tsx";
import { FilesPage } from "./files/FilesPage.tsx";
import { RevisionsPage } from "./revisions/RevisionsPage.tsx";
import { ObservedOperatorAuthority } from "../conversations/OperatorAuthorityFacts.tsx";
import { authorityChangeForCommit } from "../../lib/conversations/operator-authority.ts";
import type { SourceCommit } from "../../lib/model/revisions/api.ts";
import { SysmlPage } from "./diagrams/SysmlPage.tsx";
import { type ModelLive, silentModelLive } from "../../lib/model/live.ts";

const pageNames: Record<ModelPage, string> = {
  activity: "Activity",
  revisions: "Revisions",
  files: "Files",
  releases: "Releases",
  sysml: "SysML",
  graph: "SysML",
};

/**
 * Whoever can be named as the author of a change: the whole roster of the
 * system, not only the operators that own a runtime. One that only took part in
 * a review wrote changes too, and is never shown by its identity.
 */
export function modelAuthors(
  state: WorkbenchState,
  operators: AuthorRoster,
): AuthorRoster {
  const everyone = state.agentConversations.snapshot.value;
  return authorRoster(
    operators,
    everyone && everyone.systemId === state.current.value?.id
      ? everyone.conversations
      : [],
  );
}

/**
 * The Model place: the model as it is versioned, in the frame every page of a
 * place shares. Only the page shown is mounted, so the graph opens its live
 * stream when its tab is shown, and not on every route, and the files and the
 * history are read when their page is.
 */
export function ModelSpace(
  { state, page, location, operators }: {
    state: WorkbenchState;
    page: ModelPage;
    /**
     * The address the desk shows: the revisions page reads its target from it,
     * the files page its version, file and line; Activity opens exact tool notifications.
     */
    location: RevisionLocation;
    /**
     * The operators that own a runtime: they name who made each change and are
     * the ones the model can be put in service for.
     */
    operators: readonly RuntimeOperator[];
  },
) {
  const search = new URLSearchParams(location.search);
  const caseId = search.get("caseBranch");
  const editors = useRef(new Map<string, RequestSourceEditor>());
  for (const editor of editors.current.values()) {
    editor.select(caseId, state.requests.sessionReady.value);
  }
  useEffect(() => () => {
    for (const editor of editors.current.values()) editor.dispose();
  }, []);
  const editorFor = (scope: RequestEditScope): RequestSourceEditor => {
    const key = JSON.stringify([
      scope.caseId,
      scope.branchId,
      scope.executionSpaceId,
    ]);
    let editor = editors.current.get(key);
    if (!editor) {
      let storage: Storage | undefined;
      try {
        storage = globalThis.sessionStorage;
      } catch { /* Approval is blocked if identity cannot be persisted. */ }
      editor = createRequestSourceEditor({
        scope,
        storage,
        api: createRequestSourceRevisionApi(scope.caseId),
        onUnauthorized: () => {
          state.requests.sessionReady.value = false;
        },
        onConfirmed: (confirmedCaseId) =>
          refreshCaseSourceMetadata(confirmedCaseId),
      });
      editors.current.set(key, editor);
    }
    editor.setScope(scope);
    return editor;
  };
  if (caseId && !search.has("branch")) {
    const version = search.get("version") ??
      (page === "sysml" ? search.get("modelVersion") : null) ?? undefined;
    // The Case's own word on its model: its scope and pages follow it.
    const caseLive = state.caseModelLive(caseId);
    return (
      <CaseModelBoundary
        caseId={caseId}
        live={caseLive}
        sessionReady={state.requests.sessionReady.value}
        sessionGeneration={state.requests.sessionGeneration.value}
        onAdopted={(id) => {
          // Invalidate the current-scope projection used by Request headers and
          // Release controls, without moving the selected conversation.
          void state.requests.refreshScope(id);
          refreshCaseSourceMetadata(id);
          // A prior same-Case read may already be in flight. Follow it with a
          // fresh projection so its older snapshot cannot be the final result.
          void state.requests.refresh(id).then(() =>
            state.requests.refresh(id)
          );
        }}
        search={location.search}
        version={version}
        render={(scope, request, scopedSearch) => (
          <ScopedModelPage
            catalogueConnection={state.connection.value}
            catalogueInvalidation={state.releaseCatalogueGeneration.value}
            sessionGeneration={state.requests.sessionGeneration.value}
            page={page}
            location={{ ...location, search: scopedSearch }}
            request={request}
            live={caseLive}
            caseId={scope.caseId}
            executionVersion={scope.executionVersion}
            baseVersion={scope.baseVersion}
            branchVersion={scope.branchVersion}
            sourceEditor={editorFor({
              caseId: scope.caseId,
              branchId: scope.branchId,
              executionSpaceId: scope.executionSpaceId,
              viewedVersion: scope.version,
              admittedVersion: scope.branchVersion,
              executionVersion: scope.executionVersion,
              sessionReady: state.requests.sessionReady.value,
            })}
          />
        )}
      />
    );
  }
  const unavailableBranch = unavailableModelScope(search);
  const version = search.get("version");
  // These two feeds have no version-scoped reader; do not label main as history.
  const unavailableInspection = Boolean(version) &&
    (page === "activity" || page === "revisions");
  const names = modelAuthors(state, operators);
  const authorityForCommit = (commit: SourceCommit) => {
    const change = authorityChangeForCommit(
      commit,
      state.conversationSnapshot.value?.conversations ?? [],
    );
    return change
      ? <ObservedOperatorAuthority change={change} state={state} historical />
      : null;
  };
  const toolSelection = page === "revisions"
    ? toolProposalSelection(location)
    : { kind: "none" as const };
  return (
    <PageFrame
      label="Model pages"
      title={pageNames[page]}
      tabs={MODEL_PAGES.map((id) => ({
        id,
        label: pageNames[id],
        href: inheritModelViewContext(
          modelHref(id, {
            branch: unavailableBranch ? search.get("branch") : undefined,
            caseBranch: unavailableBranch
              ? search.get("caseBranch")
              : undefined,
            version,
          }),
          location.search,
        ),
      }))}
      current={page === "graph" ? "sysml" : page}
      // The graph draws its own canvas; the revisions are a column to read.
      layout={page === "graph" || page === "sysml" ? "fill" : "column"}
    >
      {unavailableBranch
        ? (
          <p class="proposal-error" role="alert">
            This branch is unavailable on this host. Its model cannot be
            displayed.
          </p>
        )
        : unavailableInspection
        ? (
          <p class="proposal-error" role="alert">
            This page cannot inspect that model version.{" "}
            <a
              href={inheritModelViewContext(
                modelHref("files", { version }),
                location.search,
              )}
            >
              Inspect Files
            </a>
          </p>
        )
        : page === "sysml"
        ? (
          <SysmlPage
            location={location}
            generation={state.chatProposals.generation.value}
          />
        )
        : page === "graph"
        ? (
          <div class="model">
            <GraphView
              state={state}
              home={modelHref("graph")}
              heading={false}
            />
          </div>
        )
        : page === "files" || page === "releases"
        ? (
          <FilesPage
            catalogueConnection={state.connection.value}
            catalogueInvalidation={state.releaseCatalogueGeneration.value}
            sessionGeneration={state.requests.sessionGeneration.value}
            releases={page === "releases"}
            location={location}
            // A decision made anywhere moves the head the files are read at.
            generation={state.chatProposals.generation.value}
          />
        )
        : page === "activity"
        ? (
          <ActivityPage
            authorityForCommit={authorityForCommit}
            operators={names}
            state={state}
            location={location}
            sources={state.chatProposals}
            onChanged={() => state.sourcesChanged()}
            revisionKey={state.current.value?.revision}
          />
        )
        : toolSelection.kind !== "none"
        ? (
          <ToolProposalDetail
            state={state}
            selection={toolSelection}
            backToRevisions
          />
        )
        : (
          <RevisionsPage
            authorityForCommit={authorityForCommit}
            operators={operators}
            names={names}
            location={location}
            sources={state.chatProposals}
            onChanged={() => state.sourcesChanged()}
            revisionKey={state.current.value?.revision}
          />
        )}
    </PageFrame>
  );
}

/** Only immutable readers with a Case facade are enabled in this tranche. */
export function ScopedModelPage(
  {
    page,
    location,
    request,
    caseId,
    executionVersion,
    baseVersion,
    branchVersion,
    sourceEditor,
    catalogueInvalidation,
    catalogueConnection,
    sessionGeneration,
    live = silentModelLive,
  }: {
    page: ModelPage;
    location: RevisionLocation;
    request: typeof fetch;
    /** The Case's word on its model; never the main system's. */
    live?: ModelLive;
    caseId?: string;
    executionVersion?: string;
    baseVersion?: string;
    branchVersion?: string;
    sourceEditor?: RequestSourceEditor;
    catalogueInvalidation?: number;
    catalogueConnection?: "connecting" | "live" | "reconnecting" | "closed";
    sessionGeneration?: number;
  },
) {
  const files = useMemo(
    () => createModelFiles({ api: createRevisionApi(request) }),
    [request],
  );
  const views = useMemo(() => createViewsApi({ fetch: request }), [request]);
  const releaseApi = useMemo(
    () =>
      caseId
        ? createSavedSystemsApi({ catalogue: { kind: "case", caseId } })
        : undefined,
    [caseId],
  );
  useEffect(() => () => files.dispose(), [files]);
  const version = new URLSearchParams(location.search).get("version");
  const supportedPages = MODEL_PAGES.filter((id) =>
    id === "files" || id === "sysml" || id === "releases" && Boolean(caseId)
  );
  return (
    <PageFrame
      label="Model pages"
      title={pageNames[page]}
      tabs={supportedPages.map((id) => ({
        id,
        label: pageNames[id],
        href: inheritModelViewContext(
          modelHref(id, { version }),
          location.search,
        ),
      }))}
      current={page === "graph" ? "sysml" : page}
      layout={page === "sysml" ? "fill" : "column"}
    >
      {page === "files" || (page === "releases" && Boolean(caseId))
        ? (
          <FilesPage
            location={location}
            catalogueInvalidation={catalogueInvalidation}
            catalogueConnection={catalogueConnection}
            sessionGeneration={sessionGeneration}
            files={files}
            caseReadOnly
            releases={page === "releases"}
            releaseBranch={caseId ? { kind: "case", caseId } : undefined}
            releaseApi={releaseApi}
            requestExecutionVersion={executionVersion}
            requestBaseVersion={baseVersion}
            requestBranchVersion={branchVersion}
            sourceEditor={page === "files" ? sourceEditor : undefined}
            live={live}
          />
        )
        : page === "sysml"
        ? (
          <SysmlPage
            location={location}
            api={views}
            sourceFetch={request}
            requestExecutionVersion={executionVersion}
            live={live}
          />
        )
        : (
          <p class="proposal-error" role="alert">
            This view is unavailable for a Request branch.
          </p>
        )}
    </PageFrame>
  );
}

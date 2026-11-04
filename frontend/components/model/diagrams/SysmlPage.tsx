import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createRevisionApi } from "../../../lib/model/revisions/api.ts";
import { filesHref } from "../../../lib/model/sources/files.ts";
import { unconnectedDecisions } from "../../../lib/model/diagrams/notes.ts";
import {
  diagramFileName,
  downloadText,
  sourceExport,
  sysmlHref,
} from "../../../lib/model/diagrams/location.ts";
import {
  type ViewsApi,
  viewsCanRetry,
  type ViewsProblem,
  viewsProblem,
} from "../../../lib/model/diagrams/api.ts";
import { ReadFailure } from "../../view/ReadFailure.tsx";
import { VersionLine } from "../../view/VersionLine.tsx";
import { DiagramViewer } from "./DiagramViewer.tsx";
import { PlantumlPanel } from "./PlantumlPanel.tsx";
import { ViewPicker } from "./ViewPicker.tsx";
import { type SysmlPageProps, useSysmlPage } from "./useSysmlPage.ts";

function Exports(
  { api, version, view, title, sourceFetch }: {
    api: ViewsApi;
    version: string;
    view: string;
    title: string;
    sourceFetch?: typeof fetch;
  },
) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ViewsProblem | null>(null);
  const sources = useMemo(() => createRevisionApi(sourceFetch), [sourceFetch]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  return (
    <>
      <div class="sysml-exports">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          PlantUML
        </button>
        <button
          type="button"
          disabled={busy}
          title="Download all sources of this model version"
          onClick={async () => {
            const request = new AbortController();
            abort.current = request;
            setBusy(true);
            setProblem(null);
            try {
              const tree = await sources.sources(version, request.signal);
              if (!request.signal.aborted) {
                downloadText(
                  `${diagramFileName(title)}.sysml`,
                  "text/plain;charset=utf-8",
                  sourceExport(tree.sources),
                );
              }
            } catch (error) {
              if (!request.signal.aborted) {
                setProblem(
                  viewsProblem(error, true),
                );
              }
            } finally {
              if (!request.signal.aborted) setBusy(false);
            }
          }}
        >
          {busy ? "Reading…" : ".sysml"}
        </button>
      </div>
      {open && (
        <PlantumlPanel
          api={api}
          version={version}
          view={view}
          title={title}
          close={() => setOpen(false)}
        />
      )}
      {problem && (
        <div class="sysml-export-error" role="alert">
          <ReadFailure problem={problem} />
          <button type="button" onClick={() => setProblem(null)}>Close</button>
        </div>
      )}
    </>
  );
}

export function SysmlPage(props: SysmlPageProps) {
  const {
    address,
    api,
    listing,
    summary,
    view,
    listProblem,
    diagramProblem,
    retry,
  } = useSysmlPage(props);
  const problem = listProblem ?? diagramProblem;
  const missingBranches = view ? unconnectedDecisions(view) : [];
  const toolbar = listing && (
    <>
      {summary && (
        <div class="sysml-view-title">
          <strong>{summary.title}</strong>
          <span title={summary.element}>{summary.element}</span>
        </div>
      )}
      <ViewPicker
        views={listing.list.views}
        selected={summary?.id}
        version={address.version}
      />
      {view && (
        <Exports
          sourceFetch={props.sourceFetch}
          key={`${listing.version}:${view.id}`}
          api={api}
          version={listing.version}
          view={view.id}
          title={view.title}
        />
      )}
    </>
  );
  return (
    <div class="sysml-page">
      <div class="sysml-stage">
        {view && listing && !problem
          ? (
            <DiagramViewer
              key={`${listing.version}:${view.id}`}
              view={view}
              version={listing.version}
              selected={address.selected}
              toolbar={toolbar}
            />
          )
          : (
            <>
              <div class="sysml-toolbar">{toolbar}</div>
              {problem
                ? (
                  <ReadFailure
                    problem={problem}
                    again={viewsCanRetry(problem)
                      ? { run: retry, wait: problem.retryAfter }
                      : undefined}
                    home={address.version ? sysmlHref() : undefined}
                  />
                )
                : !listing
                ? (
                  <p class="sysml-empty" role="status">
                    Reading the model views…
                  </p>
                )
                : listing.list.views.length === 0
                ? (
                  <p class="sysml-empty" role="status">
                    No diagram views in this version.
                  </p>
                )
                : !summary
                ? (
                  <p class="sysml-empty" role="status">
                    This view is not in this version.{" "}
                    <ModelContextLink
                      href={sysmlHref({ version: address.version })}
                    >
                      Show available views
                    </ModelContextLink>
                  </p>
                )
                : (
                  <p class="sysml-empty" role="status">
                    Drawing {summary.title}…
                  </p>
                )}
            </>
          )}
      </div>
      {listing && missingBranches.length > 0 && (
        <p class="sysml-projection-note" role="status">
          Some decision nodes have no outgoing branches in this Toolkit
          projection. {missingBranches[0].file && (
            <ModelContextLink
              href={filesHref({
                version: listing.version,
                file: missingBranches[0].file,
                line: missingBranches[0].line,
              })}
            >
              Check the SysML source
            </ModelContextLink>
          )}
        </p>
      )}
      {listing && (
        <footer class="sysml-footer">
          <VersionLine
            version={listing.version}
            pinned={props.requestExecutionVersion === undefined
              ? Boolean(address.version)
              : listing.version !== props.requestExecutionVersion}
            info={props.versionInfo}
            home={sysmlHref({ view: summary?.id })}
          >
            <span>SysML Toolkit {listing.list.toolkit}</span>
          </VersionLine>
          {listing.list.diagnostics.length > 0 && (
            <details class="sysml-diagnostics">
              <summary>
                Projection notes · {listing.list.diagnostics.length}
              </summary>
              <ul>
                {listing.list.diagnostics.map((d, i) => (
                  <li key={i}>
                    <strong>{d.context.element}</strong> {d.context.message}
                    {" "}
                    <span>{d.recovery}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <span class="sysml-hint">Double-click a block to fold or unfold</span>
        </footer>
      )}
    </div>
  );
}

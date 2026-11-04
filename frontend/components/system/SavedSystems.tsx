import { GENERIC_BRANCH_NAME } from "../../lib/cases/operator-names.ts";
import { WorkspaceVersion } from "../workbench/WorkspaceVersion.tsx";
import type { VersionInfo } from "../../lib/workbench/version-label.ts";
import { type RequestNames, useReleaseAgents } from "./useReleaseAgents.ts";
import {
  assertReleaseTagSelection,
  type ReleaseTagBinding,
  type ReleaseTagSelection,
} from "../../../src/domain/work/release-tags.ts";
import {
  type ReleaseSaveCommand,
  sameReleaseSource,
} from "../../lib/system/release-save-intent.ts";
import { useModelContextHref } from "../view/ModelContextLink.tsx";
import { viewHref } from "../../lib/workbench/view-location.ts";
import { type ComponentChildren, Fragment, type RefObject } from "preact";
import type {
  SavedSystemPrerequisite,
  SavedSystemSourceSelection,
} from "../../../src/domain/work/saved-systems.ts";
import { filesHref } from "../../lib/model/sources/files.ts";
import { CreateTag } from "../model/CreateTag.tsx";
import { newRequestHref, since } from "../../lib/cases/cases.ts";
import { monogram } from "../../lib/workbench/desk.ts";
import type { AuthorRoster } from "../../lib/model/revisions/authors.ts";
import { operatorName } from "../../lib/model/revisions/change.ts";
import { exactDate } from "../model/revisions/RevisionDetail.tsx";
import { Marker } from "../model/RowParts.tsx";
import {
  readArtifactSources,
  sourceText,
} from "../../lib/system/tools/artifact-sources.ts";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  createCombinedSavedSystemsApi,
  createSavedSystemsController,
  releaseCatalogueQuery,
  releaseOpeningKind,
  type SavedSystemsApi,
  type SavedSystemView,
  validOpeningEvidence,
} from "../../lib/system/saved-systems.ts";

function ReleaseFilesLink(
  { source, title, children }: {
    source: SavedSystemSourceSelection;
    title?: string;
    children: ComponentChildren;
  },
) {
  const contextual = useModelContextHref(
    filesHref({ version: source.sourceVersion }),
  );
  const href = viewHref(contextual, {
    branch: null,
    caseBranch: source.branch.kind === "case" ? source.branch.caseId : null,
  });
  return <a href={href} title={title}>{children}</a>;
}

/** Where a source comes from, for a tooltip: never as visible text. */
const branchLabel = (source: SavedSystemSourceSelection) =>
  source.branch.kind === "case" ? `Request ${source.branch.caseId}` : "main";

/** A source link keeps exact identity in its tooltip and Release details. */
function SourceVersion(
  {
    source,
    title,
    release,
    requestNumber,
    inService,
    info,
  }: {
    source: SavedSystemSourceSelection;
    title: string;
    release?: { name: string; id: string };
    requestNumber?: number;
    inService?: string;
    info?: VersionInfo;
  },
) {
  return (
    <ReleaseFilesLink source={source} title={title}>
      <WorkspaceVersion
        inspect={false}
        info={{
          ...info,
          source: release
            ? { kind: "release", ...release }
            : info?.source ?? (source.branch.kind === "case"
              ? {
                kind: "request",
                caseId: source.branch.caseId,
                number: requestNumber,
              }
              : { kind: "main" }),
          version: source.sourceVersion,
          inService,
        }}
      />
    </ReleaseFilesLink>
  );
}

/** A relative date, the exact one in the tooltip. */
function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={exactDate(at)}>
      {Number.isNaN(Date.parse(at)) ? at : since(at)}
    </time>
  );
}

/** Reopen the same scoped Release page at the intention's exact source. */
function ReleaseSourceLink({ source }: { source: SavedSystemSourceSelection }) {
  const contextual = useModelContextHref(
    viewHref("/model?page=releases", { version: source.sourceVersion }),
  );
  const href = viewHref(contextual, {
    branch: null,
    caseBranch: source.branch.kind === "case" ? source.branch.caseId : null,
  });
  return <a href={href}>Reopen release at original source</a>;
}

const STATUS = {
  pending: "Retention pending",
  incomplete: "Incomplete — prerequisites or exact assets require review",
  retained: "Retention completed",
  conflict: "Refused — the admitted system changed during retention",
};
const AVAILABILITY = {
  unchecked:
    "Current asset availability has not been verified. Inspect this selection to check it.",
  verified: "Exact assets verified for this read.",
  unavailable: "Exact assets are currently unavailable or corrupt.",
};
function SavedToolSource(
  { savedId, operatorId, tool, requestOrigin }: {
    savedId: string;
    requestOrigin: boolean;
    operatorId: string;
    tool: SavedSystemView["selectedOperators"][number]["tools"][number];
  },
) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setText("");
    setError("");
    setBusy(false);
    return () => pending.current?.abort();
  }, [savedId, operatorId, tool.sourceBinding?.bindingId, requestOrigin]);
  async function open() {
    if (!tool.sourceBinding || busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setText("");
    try {
      const endpoint = `/api/saved-systems/${
        encodeURIComponent(savedId)
      }/tools/${encodeURIComponent(operatorId)}/${
        encodeURIComponent(tool.candidateId)
      }/read${
        requestOrigin ? releaseCatalogueQuery({ kind: "owned-requests" }) : ""
      }`;
      const result = await readArtifactSources(
        operatorId,
        [tool.sourceBinding],
        controller.signal,
        (_path, init) =>
          fetch(endpoint, {
            ...init,
            body: "{}",
            credentials: "same-origin",
            cache: "no-store",
          }),
      );
      if (!controller.signal.aborted) setText(sourceText(result.sources[0]!));
    } catch {
      if (!controller.signal.aborted) {
        setError(
          "The exact release source is unavailable in the current source scope.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <div class="proposal-actions">
        <button type="button" disabled={busy} onClick={() => void open()}>
          View tool source
        </button>
      </div>
      {error && <p class="proposal-error" role="alert">{error}</p>}
      {text && <pre aria-label="Release tool source">{text}</pre>}
    </div>
  );
}
const PREREQUISITES: Readonly<Record<string, string>> = {
  FRESH_CACHE_AND_ENVIRONMENT:
    "Tool execution requires a fresh cache and environment.",
  NO_REMOTE_OR_NPM_RESOLUTION:
    "Tool execution permits no remote or npm dependency resolution.",
  DENIED_IMPORTS: "Tool execution must keep imports denied.",
  MACOS_DENY_DEFAULT_SANDBOX:
    "Tool execution requires the macOS isolation host.",
  RUNTIME_PROVENANCE_UNAVAILABLE: "The exact runtime identity is incomplete.",
  ADMISSION_MISSING: "An operator has no admitted source version.",
  PRIMARY_ADMISSION_MISSING:
    "The main operator has no admitted source version.",
  SOURCE_TOOL_UNAVAILABLE:
    "An exact tool declared by this source is missing or could not be verified.",
  FRESH_PRIVATE_RESOURCE_BINDINGS:
    "Private resources require fresh local bindings before reuse.",
  SOURCE_MEMBER_ADMISSION_MISSING:
    "A member declared by the source has no admitted runtime state.",
  PUBLISHED_TOOL_MISSING:
    "A published tool is missing from its admitted runtime state.",
  PUBLISHED_TOOL_UNVERIFIABLE: "A published tool could not be verified.",
  SKILL_DEPENDENCY:
    "A declared skill is checked automatically against the local bundle when opening a Request.",
  PRIVATE_RESOURCE_DEPENDENCY:
    "Private resources need fresh local bindings before reuse.",
};
const ISSUES: Readonly<Record<string, string>> = {
  EXACT_ASSET_UNAVAILABLE:
    "Some exact assets are unavailable or could not be verified.",
  CAPTURE_CHANGED:
    "The admitted system changed before retention finished. Select the model version again.",
  PREREQUISITES_REQUIRED: "Declared dependencies are listed below.",
};
/** A kind of prerequisite in a word a person reads. */
const NEEDS: Readonly<Record<SavedSystemPrerequisite["kind"], string>> = {
  skill: "Skills",
  "host-runtime": "Tool sandbox",
  "private-resource": "Private resources",
  "unsupported-dependency": "Unsupported dependency",
  "missing-asset": "Missing tool",
};
/** One readable name per kind of prerequisite, its exact sentences for a tooltip. */
function releaseNeeds(prerequisites: readonly SavedSystemPrerequisite[]) {
  const needs = new Map<string, Set<string>>();
  for (const entry of prerequisites) {
    const label = NEEDS[entry.kind];
    needs.set(
      label,
      (needs.get(label) ?? new Set()).add(
        PREREQUISITES[entry.code] ??
          "A dependency requires review before reuse.",
      ),
    );
  }
  return [...needs].map(([label, sentences]) => ({
    label,
    detail: [...sentences].join(" "),
  }));
}
function publicationLabel(record: SavedSystemView): string {
  if (record.rejection) {
    return record.rejection.code === "SOURCE_STALE"
      ? "Publication refused · source stale"
      : "Publication refused · tag unavailable";
  }
  if (!record.tag) return "No publication tag recorded";
  return record.tag.verified ? "Tag published" : "Tag publication pending";
}
type Readiness = "ready" | "unavailable" | "unchecked";
const READINESS: Readonly<Record<Readiness, string>> = {
  ready: "Ready at last check",
  unavailable: "Request unavailable at last check",
  unchecked: "Request availability not checked",
};
function readiness(record: SavedSystemView, checked: boolean): Readiness {
  const opening = checked && validOpeningEvidence(record)
    ? record.openingAvailability
    : undefined;
  return opening === "ready" || opening === "unavailable"
    ? opening
    : "unchecked";
}
/** Where a Release stands in one word, or nothing while it is unchecked. */
function ReleaseState(
  { state, refused = false }: { state: Readiness; refused?: boolean },
) {
  if (refused) {
    return <span class="saved-systems-readiness is-refused">Refused</span>;
  }
  if (state === "unchecked") return null;
  return (
    <span class={`saved-systems-readiness is-${state}`}>
      {state === "ready" ? "Ready" : "Unavailable"}
    </span>
  );
}
const TAG_AVAILABILITY = {
  verified: "verified",
  unavailable: "unavailable or changed",
  unchecked: "not checked",
};
export function SavedSystemInspection(
  {
    record,
    headingRef,
    showRejectedAction = false,
    roster = [],
    requests,
    sessionGeneration,
    nameRefresh = 0,
    inService,
  }: {
    record: SavedSystemView;
    headingRef?: RefObject<HTMLHeadingElement>;
    showRejectedAction?: boolean;
    /** Who the agents are, by name; their identity stays in the tooltip. */
    roster?: AuthorRoster;
    requests?: RequestNames;
    sessionGeneration?: number;
    nameRefresh?: number;
    inService?: string;
  },
) {
  const agents = useReleaseAgents(
    record,
    requests,
    sessionGeneration,
    nameRefresh,
  );
  const agentName = (id: string) => {
    const modeled = agents.names.get(id);
    if (modeled) return modeled;
    const known = operatorName(roster, id);
    if (
      known &&
      !(record.source?.branch.kind === "case" &&
        ["Main Operator", GENERIC_BRANCH_NAME].includes(known))
    ) return known;
    return undefined;
  };
  const unnamed = agents.status === "reading"
    ? "Reading name…"
    : "Name unavailable";
  const operators = record.manifest
    ? record.manifest.operators.map((operator) => ({
      operator,
      retained: operator,
    }))
    : record.selectedOperators.map((operator) => ({
      operator,
      retained: null,
    }));
  const state = readiness(record, true);
  const needs = releaseNeeds(record.prerequisites);
  return (
    <article
      class="panel saved-system-inspection"
      aria-label="Release inspection"
    >
      <h3 ref={headingRef} tabIndex={-1}>
        {state === "ready" && (
          <span class="saved-system-ready" aria-hidden="true">✓</span>
        )}
        {record.metadata.name}
      </h3>
      {record.metadata.purpose && <p>{record.metadata.purpose}</p>}
      <p
        class="rev-meta"
        title={[
          `${publicationLabel(record)} · ${READINESS[state]}.`,
          "Opening a Request rechecks current host support and authority.",
          needs.length > 0 &&
          `Checked at start: ${needs.map((need) => need.label).join(", ")}.`,
          AVAILABILITY[record.assetAvailability],
        ].filter(Boolean).join(" ")}
      >
        {record.source
          ? (
            <SourceVersion
              source={record.source}
              release={{ name: record.metadata.name, id: record.id }}
              inService={inService}
              title={`${branchLabel(record.source)} · ${
                record.rejection ? "selected source" : "retained model"
              } ${record.source.sourceVersion}`}
            />
          )
          : (
            <span
              class="chip"
              title="Historical runtime capture; no displayed model source was recorded."
            >
              historical
            </span>
          )}
        {record.tag && (
          <span
            class="chip"
            title={`Tag ${
              TAG_AVAILABILITY[record.tagAvailability ?? "unchecked"]
            }`}
          >
            {record.tag.selection.name}
          </span>
        )}
        <ReleaseState state={state} />
      </p>
      {(record.assetAvailability === "unavailable" ||
        record.tagAvailability === "unavailable") && (
        <p
          class="proposal-error"
          role="status"
          title={[
            record.assetAvailability === "unavailable" &&
            AVAILABILITY.unavailable,
            record.tagAvailability === "unavailable" &&
            `Tag ${TAG_AVAILABILITY.unavailable}.`,
          ].filter(Boolean).join(" ")}
        >
          {[
            record.assetAvailability === "unavailable" && "Assets unavailable",
            record.tagAvailability === "unavailable" && "Tag unavailable",
          ].filter(Boolean).join(" · ")}
        </p>
      )}
      {record.rejection
        ? (
          <p class="proposal-error" role="status">
            {record.rejection.code === "SOURCE_STALE"
              ? (
                <>
                  The selected source is no longer eligible for this release.
                  {showRejectedAction &&
                    " Reopen an eligible source to create a new release."}
                </>
              )
              : (
                <>
                  Tag <code>{record.rejection.tag.name}</code> is unavailable.
                  {showRejectedAction &&
                    " Choose another tag and create a new release."}
                </>
              )}
          </p>
        )
        : record.status === "conflict"
        ? (
          <p class="proposal-error" role="status">
            Release retention was refused.
          </p>
        )
        : null}
      <dl class="detail-facts">
        <dt>Origin</dt>
        <dd>
          This system · {record.origin.executionSpaceId === "main"
            ? "main workspace"
            : "recorded workspace"}
        </dd>
        <dt>Created</dt>
        <dd>
          <When at={record.createdAt} />
        </dd>
      </dl>
      <ul class="saved-system-agents" aria-label="Agents">
        {operators.map(({ operator }) => {
          const name = agentName(operator.operatorId);
          return (
            <li
              key={operator.operatorId}
              title={`${operator.operatorId} · ${operator.tools.length} ${
                operator.tools.length === 1 ? "tool" : "tools"
              }`}
            >
              <span class="tavatar is-mini" aria-hidden="true">
                {name ? monogram(name) : "?"}
              </span>
              {name ?? unnamed}
            </li>
          );
        })}
      </ul>
      {needs.length > 0 && (
        <ul class="saved-system-needs" aria-label="Requirements">
          {needs.map((need) => (
            <li key={need.label} class="chip" title={need.detail}>
              {need.label}
            </li>
          ))}
        </ul>
      )}
      {state === "ready" && (
        <p>
          <a class="chip is-action" href={newRequestHref(record.id)}>
            New Request from this Release
          </a>
        </p>
      )}
      <details class="detail-more">
        <summary class="chip">Details</summary>
        <dl class="detail-facts">
          <dt>Retention status</dt>
          <dd>{STATUS[record.status]}</dd>
          <dt>Release reference</dt>
          <dd class="is-code">{record.id}</dd>
          {record.source && (
            <>
              <dt>Source</dt>
              <dd class="is-code">{record.source.sourceVersion}</dd>
              <dt>Source repository</dt>
              <dd class="is-code">{record.source.repositoryId}</dd>
              <dt>Source branch</dt>
              <dd class="is-code">{record.source.branchRef}</dd>
              <dt>Observed admitted head</dt>
              <dd class="is-code">{record.source.admittedHeadVersion}</dd>
              <dt>Source digest</dt>
              <dd class="is-code">{record.source.sourceDigest}</dd>
            </>
          )}
          {record.tag && (
            <>
              <dt>Tag mode</dt>
              <dd>{record.tag.selection.mode}</dd>
              <dt>Tag ref object</dt>
              <dd class="is-code">{record.tag.binding.refOid}</dd>
              <dt>Tag peeled commit</dt>
              <dd class="is-code">{record.tag.binding.commitOid}</dd>
            </>
          )}
          {record.openingIssues && record.openingIssues.length > 0 &&
            validOpeningEvidence(record) && (
            <>
              <dt>Request availability diagnostics</dt>
              <dd class="is-code">{record.openingIssues.join(", ")}</dd>
            </>
          )}
          <dt>Manifest digest</dt>
          <dd class="is-code">{record.digest ?? "Not finalized"}</dd>
          <dt>Project</dt>
          <dd class="is-code">{record.origin.projectId}</dd>
          <dt>System</dt>
          <dd class="is-code">{record.origin.systemId}</dd>
          <dt>Execution space</dt>
          <dd class="is-code">{record.origin.executionSpaceId}</dd>
          {record.prerequisites.map((entry, index) => (
            <Fragment key={index}>
              <dt>Requirement</dt>
              <dd class="is-code">
                {entry.operatorId && `${entry.operatorId} · `}
                {entry.kind} · {entry.code}
              </dd>
            </Fragment>
          ))}
          {record.issues.length > 0 && (
            <>
              <dt>Issues</dt>
              <dd>
                {[
                  ...new Set(
                    record.issues.map((issue) =>
                      ISSUES[issue] ?? "The release reference requires review."
                    ),
                  ),
                ].join(" ")}
              </dd>
              <dt>Diagnostic codes</dt>
              <dd class="is-code">{record.issues.join(", ")}</dd>
            </>
          )}
        </dl>
        {operators.map(({ operator, retained }) => (
          <section
            key={operator.operatorId}
            aria-label={`Retained operator ${operator.operatorId}`}
          >
            <h4>{agentName(operator.operatorId)}</h4>
            <dl class="detail-facts">
              <dt>Operator identity</dt>
              <dd class="is-code">{operator.operatorId}</dd>
              <dt>Admitted source version</dt>
              <dd class="is-code">{operator.repositoryVersion}</dd>
              <dt>
                {record.source ? "Runtime state" : "Canonical state revision"}
              </dt>
              <dd>
                {record.source
                  ? "No runtime state copied"
                  : operator.stateRevision}
              </dd>
              <dt>Model digest</dt>
              <dd class="is-code">{operator.modelDigest}</dd>
              <dt>Settings digest</dt>
              <dd class="is-code">{operator.settingsDigest}</dd>
              {retained && (
                <>
                  <dt>Source digest</dt>
                  <dd class="is-code">{retained.sourceDigest}</dd>
                </>
              )}
              {retained?.build && (
                <>
                  <dt>Build</dt>
                  <dd class="is-code">{retained.build.buildKey}</dd>
                  <dt>Artifact</dt>
                  <dd class="is-code">{retained.build.artifactDigest}</dd>
                  <dt>Recipe</dt>
                  <dd class="is-code">{retained.build.recipe.digest}</dd>
                  <dt>Toolkit</dt>
                  <dd class="is-code">
                    {retained.build.recipe.toolkit.version}{" "}
                    {retained.build.recipe.toolkit.bundleDigest}
                  </dd>
                </>
              )}
              {operator.runtime && (
                <>
                  <dt>Deno</dt>
                  <dd class="is-code">{operator.runtime.provenance.deno}</dd>
                  <dt>Application</dt>
                  <dd class="is-code">
                    {operator.runtime.provenance.ase.commit}
                  </dd>
                  <dt>Provider</dt>
                  <dd>{operator.runtime.provenance.agents.provider}</dd>
                  <dt>Model</dt>
                  <dd>{operator.runtime.provenance.agents.model}</dd>
                  <dt>Runtime identity</dt>
                  <dd class="is-code">{operator.runtime.digest}</dd>
                </>
              )}
            </dl>
            {operator.tools.length > 0 && (
              <ul class="saved-system-tools">
                {operator.tools.map((tool) => (
                  <li key={tool.candidateId}>
                    <dl class="detail-facts">
                      <dt>Tool</dt>
                      <dd class="is-code">{tool.candidateId}</dd>
                      <dt>Tool digest</dt>
                      <dd class="is-code">{tool.digest}</dd>
                      {tool.sourceBinding && (
                        <>
                          <dt>Tool source</dt>
                          <dd class="is-code">
                            {tool.sourceBinding.reference.commitOid}
                          </dd>
                          <dt>Package</dt>
                          <dd class="is-code">
                            {tool.sourceBinding.reference.manifestDigest}
                          </dd>
                        </>
                      )}
                    </dl>
                    {tool.sourceBinding && (
                      <SavedToolSource
                        savedId={record.id}
                        requestOrigin={record.source?.branch.kind === "case"}
                        operatorId={operator.operatorId}
                        tool={tool}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </details>
    </article>
  );
}
export function SavedSystemCatalogue(
  { records, selected, busy, onInspect, detailsId }: {
    records: readonly SavedSystemView[];
    selected: SavedSystemView | null;
    busy: boolean;
    onInspect(id: string): void;
    detailsId?: string;
  },
) {
  return (
    <ul class="saved-systems-list" aria-label="Releases">
      {records.map((record) => {
        // A list read is unchecked. Reuse only this exact selection's later
        // inspection, without checking any other item or rewriting its digest.
        const selectedMatches = Boolean(
          selected && selected.id === record.id &&
            selected.digest === record.digest &&
            selected.revision === record.revision &&
            selected.origin.projectId === record.origin.projectId &&
            selected.origin.systemId === record.origin.systemId &&
            selected.origin.executionSpaceId ===
              record.origin.executionSpaceId &&
            (selected.source && record.source
              ? sameReleaseSource(selected.source, record.source)
              : !selected.source && !record.source),
        );
        const inspection = selectedMatches && selected ? selected : record;
        const state = readiness(inspection, selectedMatches);
        const refused = record.status === "conflict" && !record.rejection
          ? " · Release retention was refused"
          : "";
        return (
          <li key={record.id}>
            <button
              type="button"
              class="rev-row"
              disabled={busy}
              aria-current={selected?.id === record.id ? "true" : undefined}
              aria-controls={detailsId}
              aria-expanded={selected?.id === record.id}
              onClick={() => onInspect(record.id)}
              title={`${publicationLabel(record)} · ${
                READINESS[state]
              }${refused}. ${AVAILABILITY[inspection.assetAvailability]}`}
            >
              <Marker state="applied" />
              <span class="rev-title">{record.metadata.name}</span>
              <span class="rev-meta">
                {record.tag && (
                  <span class="chip">{record.tag.selection.name}</span>
                )}
                <When at={record.createdAt} />
                <ReleaseState
                  state={state}
                  refused={Boolean(record.rejection) ||
                    record.status === "conflict"}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
/**
 * Retention failed when the Release cannot start a Request at all. A declared
 * skill alone leaves it incomplete by contract, yet a Request can start from
 * it: retrying retention would change nothing.
 */
export function showReleaseRepair(record: SavedSystemView | null): boolean {
  return !record || releaseOpeningKind(record) === null;
}

/** Recovery stays in the existing rightbar and never submits on mount. */
export function ReleaseSaveRecovery(
  { command, source, busy, acknowledged = false, onRetry }: {
    command: ReleaseSaveCommand;
    source?: SavedSystemSourceSelection;
    busy: boolean;
    acknowledged?: boolean;
    onRetry: () => void;
  },
) {
  const sameSource = source && sameReleaseSource(command.source, source);
  return (
    <div
      class="proposal-adjustment panel"
      aria-label={acknowledged
        ? "Release retention retry"
        : "Release creation unconfirmed"}
    >
      <p
        role="status"
        title={acknowledged
          ? "This Release was created, but retention still needs attention. An explicit retry uses the original creation request."
          : "Release creation may have been accepted. The original request is preserved; nothing is sent automatically."}
      >
        <strong title={command.purpose || undefined}>{command.name}</strong>
        {" · "}
        {acknowledged ? "Retention incomplete" : "Not confirmed"}
      </p>
      <p class="rev-meta">
        <SourceVersion
          source={command.source}
          title={`${
            branchLabel(command.source)
          } · exact source ${command.source.sourceVersion}`}
        />
        {command.tag && (
          <span
            class="chip"
            title={command.tag.mode === "create" ? "New tag" : "Existing tag"}
          >
            {command.tag.name}
          </span>
        )}
      </p>
      {!sameSource && (
        <p class="input-note">
          <ReleaseSourceLink source={command.source} />
        </p>
      )}
      <button
        type="button"
        disabled={busy || !sameSource}
        onClick={onRetry}
        title={`${
          sameSource
            ? ""
            : "Reopen this exact source before retrying. The displayed source cannot replace this intention. "
        }The host rechecks current access and retention authority. An acknowledgement grants no creation authority.`}
      >
        {acknowledged
          ? "Retry retention for this release"
          : "Retry release creation"}
      </button>
    </div>
  );
}

export function SavedSystems(
  {
    api,
    source,
    canCreate = true,
    initiallyCreating = false,
    catalogueInvalidation = 0,
    catalogueConnection,
    sessionGeneration = 0,
    roster,
    requests,
    inService,
    versionInfo,
  }: {
    api?: SavedSystemsApi;
    /** Who a Release's agents are, by name. */
    roster?: AuthorRoster;
    requests?: RequestNames;
    inService?: string;
    versionInfo?: VersionInfo;
    /** Validated shared-stream events and stream opens; never read authority. */
    catalogueInvalidation?: number;
    catalogueConnection?: "connecting" | "live" | "reconnecting" | "closed";
    /** Session changes fence all reads, including same-source selections. */
    sessionGeneration?: number;
    /** Exact viewed source, also used to resume an older intention. */
    source?: SavedSystemSourceSelection;
    /** Current UI eligibility for a fresh command; the host checks authority. */
    canCreate?: boolean;
    initiallyCreating?: boolean;
  },
) {
  const [, setGeneration] = useState(0);
  const activeApi = useMemo(() => api ?? createCombinedSavedSystemsApi(), [
    api,
    sessionGeneration,
  ]);
  const controller = useMemo(
    () =>
      createSavedSystemsController(
        activeApi,
        () => setGeneration((value) => value + 1),
      ),
    [activeApi, JSON.stringify(source), sessionGeneration],
  );
  useLayoutEffect(() => () => controller.dispose(), [controller]);
  const wasCreating = useRef(initiallyCreating);
  useLayoutEffect(() => {
    if (initiallyCreating && !wasCreating.current) controller.clearInspection();
    wasCreating.current = initiallyCreating;
  }, [controller, initiallyCreating]);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tagName, setTagName] = useState("");
  const [tags, setTags] = useState<ReleaseTagBinding[]>([]);
  const [tagRead, setTagRead] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [tagSourceKey, setTagSourceKey] = useState("");
  const sourceKey = JSON.stringify(source);
  const refreshTags = useRef<() => void>(() => {});
  useEffect(() => {
    if (!initiallyCreating || !source || !canCreate) return;
    let active = true;
    const abort = new AbortController();
    let inFlight = false;
    let queued = false;
    setTags([]);
    setTagSourceKey(sourceKey);
    setTagRead("loading");
    const read = () => {
      if (!active) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      activeApi.tags(source, abort.signal).then((result) => {
        if (active) {
          setTags(result);
          setTagRead("ready");
        }
      }, () => {
        if (active) {
          setTagRead("failed");
        }
      }).finally(() => {
        inFlight = false;
        if (active && queued) {
          queued = false;
          read();
        }
      });
    };
    refreshTags.current = read;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") read();
    };
    read();
    globalThis.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      abort.abort();
      refreshTags.current = () => {};
      globalThis.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeApi, sourceKey, initiallyCreating, canCreate, sessionGeneration]);
  const selectedTag: ReleaseTagSelection = { mode: "existing", name: tagName };
  let tagValid = true;
  try {
    assertReleaseTagSelection(selectedTag);
  } catch {
    tagValid = false;
  }
  if (
    (tagSourceKey !== sourceKey || tagRead !== "ready" ||
      !tags.some((tag) => tag.name === tagName))
  ) tagValid = false;
  const detailsId = useId();
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const [inspectionFocus, setInspectionFocus] = useState(0);
  useEffect(() => {
    if (inspectionFocus > 0) inspectionHeading.current?.focus();
  }, [inspectionFocus]);
  async function inspect(id: string) {
    await controller.inspect(id);
    if (controller.state.selected?.id === id) {
      setInspectionFocus((value) => value + 1);
    }
  }
  const contextualCatalogue = useModelContextHref(
    viewHref("/model?page=releases", {
      version: source?.sourceVersion,
    }),
  );
  const catalogueHref = source
    ? viewHref(contextualCatalogue, {
      branch: null,
      caseBranch: source.branch.kind === "case" ? source.branch.caseId : null,
    })
    : contextualCatalogue;
  const createHref = viewHref(catalogueHref, { create: "1" });
  const [nameRefresh, setNameRefresh] = useState(0);
  const refreshCatalogue = useRef<() => void>(() => {});
  const previousInvalidation = useRef(catalogueInvalidation);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void controller.invalidate();
        setNameRefresh((value) => value + 1);
      }
    };
    refreshCatalogue.current = () => {
      if (document.visibilityState !== "hidden") {
        void controller.invalidate();
        setNameRefresh((value) => value + 1);
        refreshTags.current();
      }
    };
    void controller.open();
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      refreshCatalogue.current = () => {};
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    if (previousInvalidation.current !== catalogueInvalidation) {
      previousInvalidation.current = catalogueInvalidation;
      refreshCatalogue.current();
    }
  }, [controller, catalogueInvalidation]);
  const state = controller.state;
  const degraded = catalogueConnection !== undefined &&
    catalogueConnection !== "live";
  const recovery = (
    <>
      {state.intent && (
        <ReleaseSaveRecovery
          command={state.intent.command}
          source={source}
          busy={state.busy}
          onRetry={() => {
            if (source) void controller.retry(source);
          }}
        />
      )}
      {!state.intent && state.repair && showReleaseRepair(state.selected) && (
        <ReleaseSaveRecovery
          command={state.repair}
          source={source}
          busy={state.busy}
          acknowledged
          onRetry={() => {
            if (source) void controller.repair(source);
          }}
        />
      )}
    </>
  );
  const details = (
    <div id={detailsId} role="region" aria-label="Release details">
      {state.selected && (
        <SavedSystemInspection
          requests={requests}
          sessionGeneration={sessionGeneration}
          nameRefresh={nameRefresh}
          inService={JSON.stringify(state.selected.source?.branch) ===
              JSON.stringify(source?.branch)
            ? inService
            : undefined}
          record={state.selected}
          headingRef={inspectionHeading}
          showRejectedAction={!state.intent}
          roster={roster}
        />
      )}
    </div>
  );
  return (
    <section
      class={initiallyCreating
        ? "saved-systems-create"
        : "saved-systems-layout"}
      aria-label={initiallyCreating ? "Create release" : "Releases"}
    >
      <div class="saved-systems">
        {(initiallyCreating || degraded) && (
          <div class="saved-systems-heading">
            {initiallyCreating && (
              <a href={catalogueHref}>← Back to releases</a>
            )}
            {degraded && (
              <>
                <span
                  class="faint"
                  role="status"
                  title="Live updates are unavailable. Read again to check current Releases and tags."
                >
                  Not live
                </span>
                <button
                  type="button"
                  class="chip"
                  disabled={state.busy}
                  onClick={() => refreshCatalogue.current()}
                >
                  Refresh
                </button>
              </>
            )}
          </div>
        )}
        {state.busy && <p class="faint" role="status">Reading…</p>}
        {state.error && (
          <p class="proposal-error" role="alert">
            {state.refused ? "Source access refused. " : ""}
            {state.error}
          </p>
        )}
        {state.readError && (
          <p class="proposal-error" role="alert">
            {state.readRefused ? "Source access refused. " : ""}
            {state.readError}
          </p>
        )}
        {state.catalogueNotice && <p role="status">{state.catalogueNotice}</p>}
        {initiallyCreating
          ? (
            <>
              {recovery}
              {/* The Release just created comes first, with its next step. */}
              {details}
              {source && canCreate && !state.intent && (
                <CreateTag
                  key={sourceKey}
                  source={source}
                  disabled={state.busy && !state.reading}
                  onCreated={(tag) => {
                    setTagName(tag.name);
                    refreshTags.current();
                  }}
                />
              )}
              {source && canCreate
                ? (
                  <form
                    id="create-release-form"
                    class="proposal-adjustment panel saved-systems-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (source && tagValid) {
                        void controller.save(
                          name,
                          purpose,
                          source,
                          selectedTag,
                        ).then(() => refreshTags.current());
                      }
                    }}
                  >
                    <p class="repo-version">
                      <span>Source</span>
                      <SourceVersion
                        source={source}
                        info={versionInfo}
                        requestNumber={source.branch.kind === "case"
                          ? requests?.byId(source.branch.caseId)?.number
                          : undefined}
                        inService={inService}
                        title={`${
                          branchLabel(source)
                        } · exact source ${source.sourceVersion}`}
                      />
                    </p>
                    <div class="saved-systems-field">
                      <label for="saved-system-tag">Existing tag</label>
                      {state.intent
                        ? (
                          <input
                            id="saved-system-tag"
                            value={state.intent.command.tag?.name ?? ""}
                            readOnly
                          />
                        )
                        : (
                          <select
                            id="saved-system-tag"
                            aria-label="Existing tag"
                            aria-invalid={!tagValid}
                            aria-describedby={!tagValid
                              ? "saved-system-tag-error"
                              : undefined}
                            value={tagName}
                            required
                            disabled={tagSourceKey !== sourceKey ||
                              tagRead !== "ready"}
                            onChange={(event) =>
                              setTagName(event.currentTarget.value)}
                          >
                            <option value="">Choose a tag</option>
                            {(tagSourceKey === sourceKey ? tags : []).map((
                              tag,
                            ) => (
                              <option key={tag.name} value={tag.name}>
                                {tag.name}
                              </option>
                            ))}
                          </select>
                        )}
                      {!tagValid && !state.intent && (
                        <p
                          id="saved-system-tag-error"
                          class="proposal-error"
                          role="status"
                          title="Choose an available tag for this exact source."
                        >
                          Choose a tag.
                        </p>
                      )}
                      {tagRead === "loading" && (
                        <p role="status">Reading tags…</p>
                      )}
                      {tagRead === "failed" && (
                        <p
                          role="alert"
                          title="Tags could not be read for this source. Reopen the form to retry."
                        >
                          Tags unavailable · reopen to retry.
                        </p>
                      )}
                      {tagRead === "ready" && tags.length === 0 && (
                        <p>
                          No tag on this version · create one above.
                        </p>
                      )}
                    </div>
                    <div class="saved-systems-field">
                      <label for="saved-system-name">Title</label>
                      <input
                        id="saved-system-name"
                        name="name"
                        required
                        maxLength={120}
                        value={state.intent?.command.name ?? name}
                        readOnly={state.intent !== null}
                        onInput={(event) => setName(event.currentTarget.value)}
                      />
                    </div>
                    <div class="saved-systems-field">
                      <label for="saved-system-purpose">Notes</label>
                      <textarea
                        id="saved-system-purpose"
                        name="purpose"
                        rows={3}
                        maxLength={2000}
                        value={state.intent?.command.purpose ?? purpose}
                        readOnly={state.intent !== null}
                        onInput={(event) =>
                          setPurpose(event.currentTarget.value)}
                      />
                    </div>
                    <div class="proposal-actions">
                      <button
                        class="proposal-accept"
                        type="submit"
                        disabled={(state.busy && !state.reading) ||
                          state.intent !== null ||
                          !name.trim() || !tagValid}
                      >
                        {state.selected
                          ? "Create another release"
                          : "Create release"}
                      </button>
                    </div>
                  </form>
                )
                : (
                  <p class="proposal-error" role="alert">
                    An exact eligible source is required to create a Release.
                  </p>
                )}
            </>
          )
          : (
            <>
              {!state.busy && !state.records.length && !state.error &&
                !state.readError && (
                <p class="view-empty">
                  {state.catalogueNotice
                    ? "No Releases in the available catalogue."
                    : "No releases yet."}
                </p>
              )}
              <SavedSystemCatalogue
                records={state.records}
                selected={state.selected}
                // A catalogue read never blocks a choice: it waits behind it.
                busy={state.busy && !state.reading}
                detailsId={detailsId}
                onInspect={(id) => void inspect(id)}
              />
              {details}
            </>
          )}
      </div>
      {!initiallyCreating && (
        <aside class="releases-actions" aria-label="Release actions">
          {source && canCreate && (
            <a class="button" href={createHref}>Create release</a>
          )}
          {recovery}
        </aside>
      )}
    </section>
  );
}

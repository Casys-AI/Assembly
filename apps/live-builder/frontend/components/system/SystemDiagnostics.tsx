import { useState } from "preact/hooks";
import type { ModelDiagnostic } from "../../../src/domain/model/policies/diagnostics.ts";
import type { AttentionItem } from "../../../src/domain/model/records/attention.ts";
import {
  type DiagnosticsRead,
  reconcileDiagnostics,
  type SystemDiagnosticsRead,
} from "../../lib/system/diagnostics.ts";
import { filesHref } from "../../lib/model/sources/files.ts";
import { systemHref } from "../../lib/workbench/desk.ts";
import { inheritModelViewContext } from "../../lib/workbench/model-context.ts";
import { Icon } from "../view/Icon.tsx";

const SEVERITY = { error: "Error", warning: "Warning", info: "Information" };
const ORDER = { error: 0, warning: 1, info: 2 };
const FINDING = {
  absent: "Absent",
  present: "Present",
  indeterminate: "Indeterminate",
};

const compareText = (left = "", right = "") =>
  left < right ? -1 : left > right ? 1 : 0;

function compareFindings(
  left: ModelDiagnostic,
  right: ModelDiagnostic,
): number {
  return ORDER[left.severity] - ORDER[right.severity] ||
    compareText(left.pattern, right.pattern) ||
    compareText(left.source?.file, right.source?.file) ||
    (left.source?.line ?? 0) - (right.source?.line ?? 0) ||
    (left.source?.column ?? 0) - (right.source?.column ?? 0) ||
    compareText(left.code, right.code) ||
    compareText(left.elementId, right.elementId) ||
    compareText(left.qualifiedName, right.qualifiedName) ||
    compareText(left.finding, right.finding) ||
    compareText(left.message, right.message) ||
    compareText(left.remedy?.kind, right.remedy?.kind) ||
    compareText(left.remedy?.template, right.remedy?.template);
}

interface UnifiedFinding {
  diagnostic: ModelDiagnostic;
  doctor: boolean;
  shacl: boolean;
  doctorMasked: boolean;
}
/** Strict cross-producer identity; no fuzzy matching or same-producer collapse. */
function findingKey(item: ModelDiagnostic): string {
  return JSON.stringify([
    item.code,
    item.elementId ?? null,
    item.qualifiedName ?? null,
    item.source?.file ?? null,
    item.source?.line ?? null,
    item.source?.column ?? null,
    item.severity,
    item.finding,
    item.pattern ?? null,
    item.message,
    item.remedy?.kind ?? null,
    item.remedy?.template ?? null,
  ]);
}
function unifyFindings(
  doctor: readonly (ModelDiagnostic & { masked: boolean })[],
  shapes: readonly ModelDiagnostic[],
  comparable: boolean,
): { active: UnifiedFinding[]; masked: UnifiedFinding[] } {
  const items: UnifiedFinding[] = doctor.map((item) => ({
    diagnostic: item,
    doctor: true,
    shacl: false,
    doctorMasked: item.masked,
  }));
  for (const diagnostic of shapes) {
    const key = findingKey(diagnostic);
    const matching = comparable
      ? items.filter((entry) =>
        entry.doctor && !entry.shacl && findingKey(entry.diagnostic) === key
      )
      : [];
    const target = matching.find((entry) => !entry.doctorMasked) ?? matching[0];
    if (target) target.shacl = true;
    else {items.push({
        diagnostic,
        doctor: false,
        shacl: true,
        doctorMasked: false,
      });}
  }
  return {
    active: items.filter((item) => item.shacl || !item.doctorMasked),
    masked: items.filter((item) => item.doctorMasked && !item.shacl),
  };
}

function summary(items: readonly ModelDiagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity]++;
  return [
    counts.error
      ? `${counts.error} ${counts.error === 1 ? "error" : "errors"}`
      : "",
    counts.warning
      ? `${counts.warning} ${counts.warning === 1 ? "warning" : "warnings"}`
      : "",
    counts.info ? `${counts.info} ${counts.info === 1 ? "note" : "notes"}` : "",
  ].filter(Boolean).join(", ") || "No findings reported";
}

function ReadState({ read }: { read: DiagnosticsRead<unknown> }) {
  if (read.status === "ready") return null;
  return (
    <div
      class="diagnostics-state"
      data-state={read.status}
      role={read.status === "error" ? "alert" : "status"}
    >
      <p>
        {read.status === "loading" ? "Reading this check…" : read.message}
      </p>
      {read.status !== "loading" && read.code && (
        <details class="diagnostics-details">
          <summary>Read details</summary>
          <code>{read.code}</code>
        </details>
      )}
    </div>
  );
}

function Availability({ read }: { read: DiagnosticsRead<unknown> }) {
  const label = {
    loading: "Reading…",
    ready: "Available",
    unavailable: "Unavailable",
    unsupported: "Not supported here",
    error: "Could not verify report",
  }[read.status];
  return (
    <span class="diagnostics-availability" data-state={read.status}>
      {label}
    </span>
  );
}

interface FindingProps {
  item: UnifiedFinding;
  version: string;
  locationSearch: string;
}

function Finding({ item, version, locationSearch }: FindingProps) {
  const diagnostic = item.diagnostic;
  const source = diagnostic.source;
  const element = diagnostic.qualifiedName ?? diagnostic.elementId;
  const href = diagnostic.elementId
    ? inheritModelViewContext(
      systemHref("explore", { select: diagnostic.elementId, version }),
      locationSearch,
    )
    : undefined;
  return (
    <li class="diagnostics-finding" data-severity={diagnostic.severity}>
      <div class="diagnostics-severity">
        <Icon name={diagnostic.severity === "info" ? "dot" : "shield"} />
        <span>{SEVERITY[diagnostic.severity]}</span>
      </div>
      <div class="diagnostics-finding-content">
        <p class="diagnostics-message">{diagnostic.message}</p>
        {element && (
          <p class="diagnostics-target">
            {href ? <a href={href}>{element}</a> : element}
          </p>
        )}
        {source && (
          <a
            class="diagnostics-source"
            href={inheritModelViewContext(
              filesHref({ version, file: source.file, line: source.line }),
              locationSearch,
            )}
          >
            <Icon name="file" />
            {source.file}:{source.line}:{source.column}
          </a>
        )}
        <details class="diagnostics-details">
          <summary>Finding details</summary>
          <dl class="diagnostics-facts">
            <div>
              <dt>Code</dt>
              <dd>
                <code>{diagnostic.code}</code>
              </dd>
            </div>
            <div>
              <dt>Checks</dt>
              <dd>
                {[item.doctor ? "Doctor" : "", item.shacl ? "SHACL" : ""]
                  .filter(Boolean).join(", ")}
                {item.doctorMasked ? " · Doctor masked" : ""}
              </dd>
            </div>
            <div>
              <dt>Finding</dt>
              <dd>{FINDING[diagnostic.finding]}</dd>
            </div>
            {diagnostic.pattern && (
              <div>
                <dt>Pattern</dt>
                <dd>{diagnostic.pattern}</dd>
              </div>
            )}
            {diagnostic.elementId && (
              <div>
                <dt>Element</dt>
                <dd>
                  <code>{diagnostic.elementId}</code>
                </dd>
              </div>
            )}
          </dl>
        </details>
      </div>
    </li>
  );
}

function Findings({ items, version, locationSearch }: {
  items: readonly UnifiedFinding[];
  version: string;
  locationSearch: string;
}) {
  const [limit, setLimit] = useState(25);
  const ordered = [...items].sort((a, b) =>
    compareFindings(a.diagnostic, b.diagnostic)
  );
  return (
    <>
      <ul class="diagnostics-findings">
        {ordered.slice(0, limit).map((item, index) => (
          <Finding
            key={`${item.diagnostic.code}:${
              item.diagnostic.elementId ?? ""
            }:${index}`}
            item={item}
            version={version}
            locationSearch={locationSearch}
          />
        ))}
      </ul>
      {items.length > limit && (
        <button
          class="diagnostics-more"
          type="button"
          onClick={() => setLimit(limit + 25)}
        >
          Show {Math.min(25, items.length - limit)} more findings
          <span>({limit} of {items.length} shown)</span>
        </button>
      )}
    </>
  );
}

const ATTENTION_SOURCE = {
  "authority-matrix": "Rights",
  board: "System model",
  doctor: "Doctor",
};

function AttentionFinding({ item, version, locationSearch }: {
  item: AttentionItem;
  version: string;
  locationSearch: string;
}) {
  return (
    <li class="diagnostics-attention-item">
      <div>
        <span
          class="diagnostics-attention-severity"
          data-severity={item.severity}
        >
          {SEVERITY[item.severity]}
        </span>
        <span>{ATTENTION_SOURCE[item.source]}</span>
      </div>
      <code>{item.code}</code>
      <a
        href={inheritModelViewContext(
          systemHref(item.target.page, {
            select: item.target.elementId,
            version,
          }),
          locationSearch,
        )}
      >
        Inspect {item.target.page === "team"
          ? "Team"
          : item.target.page === "rights"
          ? "Rights"
          : "Requirements"}
      </a>
      <details class="diagnostics-details">
        <summary>Context</summary>
        <pre>{JSON.stringify(item.context, null, 2)}</pre>
        <p>{item.recovery}</p>
      </details>
    </li>
  );
}

/** Read-only findings, with exact cross-check provenance and no inferred authority. */
export function SystemDiagnostics(
  { version, locationSearch = "", read: incoming }: {
    version: string;
    locationSearch?: string;
    read: SystemDiagnosticsRead;
  },
) {
  const read = reconcileDiagnostics(incoming);
  const doctor = read.doctor.status === "ready" ? read.doctor.value : undefined;
  const shapes = read.shapes.status === "ready"
    ? read.shapes.value.report
    : undefined;
  const comparable = !!doctor && !!shapes && read.shapes.status === "ready" &&
    doctor.version === version && read.shapes.value.version === version &&
    doctor.sourceDigest === shapes.build.sourceDigest;
  const { active, masked } = unifyFindings(
    doctor?.diagnostics ?? [],
    shapes?.diagnostics ?? [],
    comparable,
  );
  const attention = read.attention.status === "ready"
    ? read.attention.value
    : undefined;
  const partial = read.doctor.status !== "ready" ||
    read.shapes.status !== "ready";
  const anyReady = read.doctor.status === "ready" ||
    read.shapes.status === "ready";
  return (
    <div class="system-diagnostics">
      <div class="diagnostics-intro">
        <p>Model findings from the available checks.</p>
        <span class="diagnostics-readonly">
          <Icon name="eye" />Read-only
        </span>
      </div>
      <section
        class="diagnostics-section"
        aria-labelledby="diagnostics-findings-title"
      >
        <div class="diagnostics-section-head">
          <h2 id="diagnostics-findings-title">Findings</h2>
          <span>
            {anyReady
              ? summary(active.map((entry) => entry.diagnostic))
              : "Findings are not yet known."}
          </span>
        </div>
        {partial && (
          <p class="diagnostics-boundary" role="status">
            Partial checks: the count covers only available results.
          </p>
        )}
        <details class="diagnostics-checks">
          <summary>
            Checks: Doctor <Availability read={read.doctor} /> · SHACL{" "}
            <Availability read={read.shapes} />
          </summary>
          <div class="diagnostics-check-detail">
            <strong>Doctor</strong>
            <ReadState read={read.doctor} />
            {doctor && (
              <p>
                Version <code>{doctor.version}</code> · source digest{" "}
                <code>{doctor.sourceDigest}</code>
              </p>
            )}
          </div>
          <div class="diagnostics-check-detail">
            <strong>SHACL</strong>
            <ReadState read={read.shapes} />
            {shapes && (
              <dl class="diagnostics-facts">
                <div>
                  <dt>Model version</dt>
                  <dd>
                    <code>{version}</code>
                  </dd>
                </div>
                <div>
                  <dt>Source digest</dt>
                  <dd>
                    <code>{shapes.build.sourceDigest}</code>
                  </dd>
                </div>
                <div>
                  <dt>Artifact digest</dt>
                  <dd>
                    <code>{shapes.identity.artifactDigest}</code>
                  </dd>
                </div>
                <div>
                  <dt>Shapes digest</dt>
                  <dd>
                    <code>{shapes.identity.shapesDigest}</code>
                  </dd>
                </div>
                <div>
                  <dt>Facts projector</dt>
                  <dd>{shapes.identity.factsProjectorVersion}</dd>
                </div>
                <div>
                  <dt>Engine</dt>
                  <dd>
                    {shapes.identity.engineId} {shapes.identity.engineVersion}
                  </dd>
                </div>
                <div>
                  <dt>Options digest</dt>
                  <dd>
                    <code>{shapes.identity.optionsDigest}</code>
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </details>
        {partial && (
          <p class="diagnostics-boundary">
            {read.doctor.status !== "ready" && (
              <>
                Doctor: {read.doctor.status === "loading"
                  ? "Reading this check…"
                  : read.doctor.message}
              </>
            )}
            {read.shapes.status !== "ready" && (
              <>
                SHACL: {read.shapes.status === "loading"
                  ? "Reading this check…"
                  : read.shapes.message}
              </>
            )}
          </p>
        )}
        {shapes && !shapes.conforms && (
          <p class="diagnostics-conformance" role="status">
            Does not conform to the checked shapes.
          </p>
        )}
        {shapes && shapes.unmappedResults > 0 && (
          <p class="diagnostics-unmapped" role="status">
            {shapes.unmappedResults} validation{" "}
            {shapes.unmappedResults === 1 ? "result has" : "results have"}{" "}
            no mapped finding. The list is incomplete.
          </p>
        )}
        {shapes && shapes.unmappedResults > 0 &&
          shapes.diagnostics.length === 0 && (
          <p class="diagnostics-empty">
            No mapped SHACL findings are available.
          </p>
        )}
        {active.length > 0
          ? (
            <Findings
              key={`findings:${version}`}
              items={active}
              version={version}
              locationSearch={locationSearch}
            />
          )
          : anyReady
          ? (
            <p class="diagnostics-empty">
              No active findings in the available checks.
            </p>
          )
          : null}
        {masked.length > 0 && (
          <details class="diagnostics-masked">
            <summary>
              Masked findings <span>{masked.length}</span>
            </summary>
            <p>
              Doctor masks hide findings from attention; they do not resolve
              them.
            </p>
            <Findings
              key={`masked:${version}`}
              items={masked}
              version={version}
              locationSearch={locationSearch}
            />
          </details>
        )}
      </section>

      <details class="diagnostics-attention">
        <summary>
          Related attention <Availability read={read.attention} />
        </summary>
        <p>
          Attention also includes Rights and other System findings. Doctor
          findings may appear here again; this is a separate view, not an
          additional diagnostic total.
        </p>
        <ReadState read={read.attention} />
        {attention && (attention.items.length > 0
          ? (
            <ul>
              {attention.items.map((item, index) => (
                <AttentionFinding
                  key={index}
                  item={item}
                  version={version}
                  locationSearch={locationSearch}
                />
              ))}
            </ul>
          )
          : (
            <p class="diagnostics-empty">
              No attention items reported for this version.
            </p>
          ))}
      </details>
    </div>
  );
}

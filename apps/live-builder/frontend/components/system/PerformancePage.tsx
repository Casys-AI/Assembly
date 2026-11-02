import { useState } from "preact/hooks";
import { ModelContextLink } from "../view/ModelContextLink.tsx";
import type {
  ObservedResourceAmount,
  ProviderResourceUnit,
} from "../../../src/application/telemetry/provider-resource-readout.ts";
import { RESOURCE_UNITS } from "../../lib/system/performance/api.ts";
import {
  type PerformanceState,
  UNAVAILABLE_PERFORMANCE,
} from "../../lib/system/performance/store.ts";

const LABELS: Record<ProviderResourceUnit, string> = {
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cache_creation_input_tokens: "Cache creation tokens",
  cache_read_input_tokens: "Cache read tokens",
  cache_creation_5m_input_tokens: "Cache creation, 5 min tokens",
  cache_creation_1h_input_tokens: "Cache creation, 1 h tokens",
  web_search_requests: "Provider web searches",
  web_fetch_requests: "Provider web fetches",
};
const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 3 });
function amount(value: ObservedResourceAmount): string {
  return value.observedSubtotal === null
    ? value.state === "overflow" ? "N/A (overflow)" : "N/A"
    : number(value.observedSubtotal);
}
const metadata: Record<PerformanceState["status"], string> = {
  loading: "Reading observed provider resources…",
  ready: "",
  "connection-required":
    "A current authorized local session is required. Import a local control file in Requests.",
  "version-unavailable":
    "Measurements for this inspected version are unavailable.",
  unavailable: "Collection is not connected.",
};

/** Same accepted summary for Team and Performance; only retained resource facts
 * are connected. Provider return and timing do not fill the other KPI axes. */
export function PerformanceSummary(
  { href, read = UNAVAILABLE_PERFORMANCE, detailed = false }: {
    href?: string;
    read?: PerformanceState;
    detailed?: boolean;
  },
) {
  const data = read.status === "ready" ? read.readout : undefined;
  const resources = data?.resources;
  return (
    <section class="performance-summary" aria-label="System performance">
      <h2>System performance</h2>
      <p
        class="performance-unavailable"
        data-state={data ? resources!.state : read.status}
        role="status"
      >
        {data
          ? "Observed resource measurements for this scope."
          : "Measurements are not available for this scope."}
      </p>
      <dl class="performance-metrics">
        <div>
          <dt>Verified outcomes</dt>
          <dd>N/A</dd>
        </div>
        <div>
          <dt>Elapsed time</dt>
          <dd>N/A</dd>
        </div>
        <div>
          <dt>Resource usage</dt>
          <dd>
            {resources
              ? `${number(resources.calls)} retained ${
                resources.calls === 1 ? "call" : "calls"
              }`
              : "N/A"}
          </dd>
        </div>
      </dl>
      {resources && data
        ? (
          <>
            <p class="performance-metadata">
              {data.execution.kind === "case"
                ? "Request execution"
                : "Main primary execution"}
              {" · "}
              model{" "}
              <code title={data.execution.modelVersion.repositoryVersion}>
                {data.execution.modelVersion.repositoryVersion.slice(7, 14)}
              </code>
            </p>
            {detailed && (
              <details class="performance-measurement-details">
                <summary>Measurement details</summary>
                {data.execution.kind === "case" && (
                  <p class="performance-metadata">
                    Request execution Case ID{" "}
                    <code>{data.execution.caseId}</code>
                  </p>
                )}
                <p class="performance-metadata">
                  Executed model{" "}
                  <code>{data.execution.modelVersion.repositoryVersion}</code>
                  · digest <code>{data.execution.modelVersion.digest}</code>
                </p>
                {RESOURCE_UNITS.map((unit) => (
                  <p class="performance-metadata" key={unit}>
                    {LABELS[unit]}: {amount(resources.units[unit])}
                    {" · "}
                    {number(resources.units[unit].presentCalls)} calls reported,
                    {" "}
                    {number(resources.units[unit].missingCalls)} missing
                  </p>
                ))}
                <p class="performance-metadata">
                  Summed provider latency: {amount(resources.providerElapsedMs)}
                  {resources.providerElapsedMs.observedSubtotal === null
                    ? ""
                    : " ms"}. Concurrent calls can overlap; workflow elapsed
                  time is unavailable.
                </p>
                <p class="performance-metadata">
                  Physical call outcomes: {number(resources.outcomes.returned)}
                  {" "}
                  returned, {number(resources.outcomes.failed)} failed,{" "}
                  {number(resources.outcomes.cancelled)} cancelled,{" "}
                  {number(resources.outcomes["timed-out"])}{" "}
                  timed out. Provider return does not establish a verified
                  business result.
                </p>
                <p class="performance-metadata">
                  Complete retained records; physical-call coverage is unknown.
                  Missing usage is not zero.
                </p>
                <p class="performance-metadata">
                  Provider events through{" "}
                  <time dateTime={resources.selection.endedThrough}>
                    {resources.selection.endedThrough}
                  </time>. Read at{" "}
                  <time dateTime={resources.readAt}>{resources.readAt}</time>.
                </p>
                <p class="performance-metadata">
                  Verified outcomes and workflow elapsed time are not available
                  for this scope.
                </p>
              </details>
            )}
          </>
        )
        : (
          <p class="performance-metadata">
            {read.status === "unavailable" && read.key
              ? "Observed provider resources could not be read."
              : metadata[read.status]}
          </p>
        )}
      {href && (
        <ModelContextLink href={href}>
          Open Performance
        </ModelContextLink>
      )}
    </section>
  );
}

export function ComponentObservations({ read }: { read?: PerformanceState }) {
  const [page, setPage] = useState(0);
  const groups = read?.status === "ready"
    ? read.readout?.resources.operatorGroups
    : undefined;
  const pageSize = 20;
  const lastPage = Math.max(0, Math.ceil((groups?.length ?? 0) / pageSize) - 1);
  const shownPage = Math.min(page, lastPage);
  function cell(value: ObservedResourceAmount, suffix = "") {
    return (
      <span
        title={`${number(value.presentCalls)} calls reported, ${
          number(value.missingCalls)
        } missing`}
      >
        {amount(value)}
        {value.observedSubtotal === null ? "" : suffix}
        {value.missingCalls > 0 && value.presentCalls > 0 ? " (partial)" : ""}
      </span>
    );
  }
  return (
    <section class="performance-evidence" aria-label="Component observations">
      <h2>Component observations</h2>
      {groups === undefined
        ? (
          <p>
            Attributed component observations are not available for this scope.
          </p>
        )
        : groups.length === 0
        ? <p>No retained provider observations for this scope.</p>
        : (
          <>
            <p>
              Observed resources by collected operator identity. Missing usage
              is not zero; provider times may overlap.
            </p>
            <div class="performance-components-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Operator</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Input tokens</th>
                    <th scope="col">Output tokens</th>
                    <th scope="col">Cache creation tokens</th>
                    <th scope="col">Cache read tokens</th>
                    <th scope="col">Provider time</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.slice(
                    shownPage * pageSize,
                    (shownPage + 1) * pageSize,
                  ).map((group) => (
                    <tr
                      key={group.operatorId === null
                        ? "n:"
                        : `s:${group.operatorId}`}
                    >
                      <th scope="row">
                        {group.operatorId === null
                          ? "Unattributed operator"
                          : (
                            <code
                              title={group.operatorId}
                              style={{
                                overflowWrap: "anywhere",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {group.operatorId.trim() !== group.operatorId
                                ? JSON.stringify(group.operatorId)
                                : group.operatorId}
                            </code>
                          )}
                        <details>
                          <summary>More resource units</summary>
                          <dl>
                            {RESOURCE_UNITS.slice(4).map((unit) => (
                              <div key={unit}>
                                <dt>{LABELS[unit]}</dt>
                                <dd>{cell(group.units[unit])}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      </th>
                      <td>{number(group.calls)}</td>
                      <td>{cell(group.units.input_tokens)}</td>
                      <td>{cell(group.units.output_tokens)}</td>
                      <td>{cell(group.units.cache_creation_input_tokens)}</td>
                      <td>{cell(group.units.cache_read_input_tokens)}</td>
                      <td>{cell(group.providerElapsedMs, " ms")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lastPage > 0 && (
              <p>
                Page {shownPage + 1} of {lastPage + 1}{" "}
                <button
                  type="button"
                  disabled={shownPage === 0}
                  onClick={() => setPage(shownPage - 1)}
                >
                  Previous
                </button>{" "}
                <button
                  type="button"
                  disabled={shownPage === lastPage}
                  onClick={() =>
                    setPage(shownPage + 1)}
                >
                  Next
                </button>
              </p>
            )}
          </>
        )}
    </section>
  );
}

export function PerformancePage({ read }: { read?: PerformanceState } = {}) {
  return (
    <div class="performance-page">
      <PerformanceSummary read={read} detailed />
      <ComponentObservations
        key={read?.key ?? "unavailable"}
        read={read}
      />
      <section class="performance-evidence" aria-label="Evaluation campaigns">
        <h2>Evaluation campaigns</h2>
        <p>Evaluation campaign evidence is not available for this scope.</p>
      </section>
    </div>
  );
}

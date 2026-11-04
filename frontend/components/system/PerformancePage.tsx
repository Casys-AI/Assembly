import { useState } from "preact/hooks";
import { ModelContextLink } from "../view/ModelContextLink.tsx";
import { monogram } from "../../lib/workbench/desk.ts";
import type {
  AgentRow,
  KpiFigure,
  PerformanceView,
} from "../../lib/system/performance/kpis.ts";

/** A KPI tile: the figure, its reason on hover, its detail line on the page. */
function Tile(
  { label, figure, compact }: {
    label: string;
    figure: KpiFigure;
    compact: boolean;
  },
) {
  return (
    <div data-state={figure.state}>
      <dt>{label}</dt>
      <dd title={figure.hint}>
        {compact ? figure.short ?? figure.text : figure.text}
      </dd>
      {!compact && figure.sub && <dd class="performance-sub">{figure.sub}</dd>}
    </div>
  );
}

/** The two axes in order (time, tokens), or why they are not shown. */
function Headline(
  { view, compact }: { view: PerformanceView; compact: boolean },
) {
  const tiles = ([
    ["Duration", view.duration],
    ["Tokens", view.tokens],
  ] as const).filter(([, figure]) => figure);
  return (
    <>
      {tiles.length > 0 && (
        <dl class="performance-metrics">
          {tiles.map(([label, figure]) => (
            <Tile
              key={label}
              label={label}
              figure={figure!}
              compact={compact}
            />
          ))}
        </dl>
      )}
      {view.unavailable && (
        <p
          class="performance-unavailable"
          role="status"
          title={view.unavailable.hint}
        >
          {view.unavailable.text}
        </p>
      )}
    </>
  );
}

/** Team's summary: the same three axes, large numbers shortened. */
export function PerformanceSummary(
  { href, view }: { href?: string; view: PerformanceView },
) {
  return (
    <section class="performance-summary" aria-label="Performance">
      <h2>Performance</h2>
      <Headline view={view} compact />
      {href && (
        <ModelContextLink href={href}>
          Open Performance
        </ModelContextLink>
      )}
    </section>
  );
}

function Cell({ figure }: { figure: KpiFigure }) {
  return <td title={figure.hint} data-state={figure.state}>{figure.text}</td>;
}

/** Tokens by agent, named as in Team; pages rather than truncates. */
export function AgentTable(
  { rows, hrefOf }: {
    rows: readonly AgentRow[];
    hrefOf?: (agentId: string) => string;
  },
) {
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const shownPage = Math.min(page, lastPage);
  return (
    <section class="performance-evidence" aria-label="By agent">
      <h2>By agent</h2>
      <div class="performance-components-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens</th>
              <th scope="col">Per call</th>
              <th scope="col">Cache</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(shownPage * pageSize, (shownPage + 1) * pageSize).map((
              row,
            ) => (
              <tr key={row.key}>
                <th scope="row" title={row.hint}>
                  <span class="performance-agent">
                    <span class="tavatar is-mini" aria-hidden="true">
                      {row.agentId ? monogram(row.name) : "?"}
                    </span>
                    {row.agentId && hrefOf
                      ? (
                        <ModelContextLink href={hrefOf(row.agentId)}>
                          {row.name}
                        </ModelContextLink>
                      )
                      : row.name}
                  </span>
                </th>
                <td>{row.calls.toLocaleString("en-US")}</td>
                <Cell figure={row.tokens} />
                <Cell figure={row.perCall} />
                <Cell figure={row.cache} />
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
            onClick={() => setPage(shownPage + 1)}
          >
            Next
          </button>
        </p>
      )}
    </section>
  );
}

/** The KPIs of one Request (or of Main): headline, facts, agents, details. */
export function PerformancePage(
  { view, hrefOf }: {
    view: PerformanceView;
    hrefOf?: (agentId: string) => string;
  },
) {
  return (
    <div class="performance-page">
      <section class="performance-summary" aria-label="Performance">
        <Headline view={view} compact={false} />
        {view.facts.length > 0 && (
          <div class="stats">
            {view.facts.map((fact) => (
              <div
                key={fact.label}
                class="stat"
                title={fact.hint}
                data-state={fact.state}
              >
                <b>{fact.text}</b>
                <span>{fact.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      {view.agents && view.agents.length > 0 && (
        <AgentTable rows={view.agents} hrefOf={hrefOf} />
      )}
      {view.details && (
        <details class="performance-measurement-details">
          <summary>Details</summary>
          <p class="performance-metadata">{view.details.note}</p>
          <dl>
            {view.details.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd title={row.title}>{row.text}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

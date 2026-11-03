import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { Detail } from "../../../lib/system/board/detail.ts";
import type {
  MatrixColumn,
  MatrixRow,
} from "../../../lib/system/rights/api.ts";
import {
  cellKey,
  dotOf,
  type Family,
  markOf,
  type ReferenceRights,
  type Rights,
} from "../../../lib/system/rights/projection.ts";
import { Empty } from "../../view/Empty.tsx";
import { DetailPlace } from "../DetailSlot.tsx";
import { CellDetail } from "./RightsDetail.tsx";

/** One actor's line: a dot in each cell the matrix has, which opens it in a row under the line. */
function Line(
  { row, rights, columns, families, starts, detail }: {
    row: MatrixRow;
    rights: Rights;
    columns: readonly MatrixColumn[];
    families: ReadonlyMap<string, Family>;
    /** The columns that open a family. */
    starts: ReadonlySet<string>;
    detail: Detail;
  },
) {
  const name = rights.rowLabel(row, true);
  // The cell the address opens, if the matrix has one there.
  const opened = columns.flatMap((column) => {
    const cell = rights.at(row.id, column.id);
    return cell && detail.choice === cellKey(row.id, column.id)
      ? [{ column, cell }]
      : [];
  })[0];
  return (
    <>
      <tr data-row={row.id} class={opened ? "is-selected" : undefined}>
        <th scope="row" title={row.label}>{name}</th>
        {columns.map((column) => {
          const cell = rights.at(row.id, column.id);
          const key = cellKey(row.id, column.id);
          const mark = cell && markOf(cell);
          const words = cell &&
            `${cell.state}${mark?.unusable ? " (of no use)" : ""}`;
          return (
            <td
              key={column.id}
              class={[
                starts.has(column.id) ? "g0" : "",
                detail.choice === key ? "is-selected" : "",
              ].filter(Boolean).join(" ") || undefined}
            >
              {cell && (
                <ModelContextLink
                  class="matrix-cell"
                  href={detail.toggle([key])}
                  aria-label={`${name}, ${
                    rights.columnLabel(column, true)
                  }: ${words}`}
                  aria-current={detail.choice === key ? "true" : "false"}
                  title={words}
                  data-column={column.id}
                >
                  <span
                    class={`dot ${dotOf(cell)}${
                      mark?.unusable ? " is-unusable" : ""
                    }`}
                  />
                </ModelContextLink>
              )}
            </td>
          );
        })}
      </tr>
      {opened && (
        <DetailPlace as="row" span={columns.length + 1}>
          <CellDetail
            key={cellKey(row.id, opened.column.id)}
            cell={opened.cell}
            row={row}
            column={opened.column}
            family={families.get(opened.column.id)}
            rights={rights}
            detail={detail}
          />
        </DetailPlace>
      )}
    </>
  );
}

/**
 * A line read from another system's matrix (the global Main in a Case, a
 * Branch Operator on the main system): its cells there, under this page's
 * columns. It links to its own system and opens nothing here.
 */
function ReferenceLine(
  { line, columns, starts }: {
    line: ReferenceRights;
    columns: readonly MatrixColumn[];
    starts: ReadonlySet<string>;
  },
) {
  // None while its rights are read, or when they lack the operator.
  const row: MatrixRow | undefined = line.actor.rows[0];
  return (
    <tr class="is-main" data-row={line.actor.id}>
      <th scope="row" title={row?.label}>
        <a href={line.href} title={line.problem ?? line.about}>
          {line.actor.label}
        </a>
      </th>
      {columns.map((column) => {
        const cell = row && line.rights.at(row.id, column.id);
        const mark = cell && markOf(cell);
        return (
          <td key={column.id} class={starts.has(column.id) ? "g0" : undefined}>
            {cell && (
              <span
                class={`dot ${dotOf(cell)}${
                  mark?.unusable ? " is-unusable" : ""
                }`}
                title={`${cell.state}${mark?.unusable ? " (of no use)" : ""}`}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

/**
 * System > Rights in SysML's words: the whole matrix. The actors are the
 * rows, you first, as the model names them; the families of rights head the
 * columns, grouped, with the right written upright above; a dot says what the
 * model gives (alone, proposes, inherited, not given). Choosing a dot opens its
 * cell in a row under the line. The table scrolls sideways, and the rows keep
 * their names in view. In a Case, the global Main's line follows yours; on
 * the main system, the open Cases' Branch Operators close the table.
 */
export function RightsMatrix(
  { rights, detail, note, main, branches = [] }: {
    rights: Rights;
    detail: Detail;
    /** What the matrix does not tell, for the tooltip of the legend. */
    note?: string;
    main?: ReferenceRights;
    branches?: readonly ReferenceRights[];
  },
) {
  const people = rights.actors.filter((actor) => actor.you)
    .flatMap((actor) => actor.rows);
  const operators = rights.actors.filter((actor) => !actor.you)
    .flatMap((actor) => actor.rows);
  const rows = [...people, ...operators];
  const columns = rights.families.flatMap((family) => family.columns);
  if (rows.length === 0 || columns.length === 0) {
    return <Empty code="no-rights">No rights declared</Empty>;
  }
  const starts = new Set(rights.families.map((family) => family.columns[0].id));
  const families = new Map(
    rights.families.flatMap((family) =>
      family.columns.map((column) => [column.id, family] as const)
    ),
  );
  return (
    <>
      <div class="detail-table">
        <div class="matrix-scroll">
          <table class="matrix rights-matrix">
            <thead>
              <tr class="groups">
                <th />
                {rights.families.map((family) => (
                  <th
                    key={family.id}
                    colSpan={family.columns.length}
                    scope="colgroup"
                  >
                    {family.label}
                  </th>
                ))}
              </tr>
              <tr>
                <th />
                {columns.map((column) => (
                  <th
                    key={column.id}
                    class="vert"
                    scope="col"
                    title={column.doc}
                  >
                    <span>{rights.columnLabel(column, true)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((row) => (
                <Line
                  key={row.id}
                  row={row}
                  rights={rights}
                  columns={columns}
                  families={families}
                  starts={starts}
                  detail={detail}
                />
              ))}
              {main && (
                <ReferenceLine
                  key={main.actor.id}
                  line={main}
                  columns={columns}
                  starts={starts}
                />
              )}
              {operators.map((row) => (
                <Line
                  key={row.id}
                  row={row}
                  rights={rights}
                  columns={columns}
                  families={families}
                  starts={starts}
                  detail={detail}
                />
              ))}
              {branches.map((line) => (
                <ReferenceLine
                  key={line.actor.id}
                  line={line}
                  columns={columns}
                  starts={starts}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div class="legend" title={note}>
        <span>
          <span class="dot allowed" />
          allowed
        </span>
        <span>
          <span class="dot propose" />
          can propose, a decision follows
        </span>
        <span>
          <span class="dot inherited" />
          inherited
        </span>
        <span>
          <span class="dot denied" />
          not allowed
        </span>
        <span>
          <span class="dot allowed is-unusable" />
          allowed, of no use
        </span>
      </div>
    </>
  );
}

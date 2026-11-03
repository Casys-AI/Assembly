import { ModelContextLink } from "../view/ModelContextLink.tsx";
import { Fragment } from "preact";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import {
  type AllocationGroup,
  type AllocationRow,
  allocationsOf,
} from "../../lib/system/views/allocations.ts";
import type { Detail } from "../../lib/system/board/detail.ts";
import { Empty } from "../view/Empty.tsx";
import { DetailSlot, DetailUnderTitle } from "./DetailSlot.tsx";
import { KindMark } from "./KindMark.tsx";

/** A unit as the page tells it: by its name, or "?" when the board cannot place the element. */
const unitLabel = (detail: Detail, unit: string | null) =>
  unit === null ? "?" : detail.nameOf(unit);

/** What heads a group of rows: the flow they belong to, or "Actions", and the unit. */
function groupLabel(group: AllocationGroup, detail: Detail): string {
  const flow = group.flow === null ? "Actions" : detail.nameOf(group.flow);
  return `${flow} · in ${unitLabel(detail, group.unit)}`;
}

/**
 * One allocated element: its name opens it, and so does every cell it has a
 * dot in. The detail follows the row, as a row of the table.
 */
function Row(
  { row, span, starts, columns, detail }: {
    row: AllocationRow;
    span: number;
    /** The performers that open a unit's columns. */
    starts: ReadonlySet<string>;
    columns: readonly string[];
    detail: Detail;
  },
) {
  const element = detail.index.get(row.id);
  const name = detail.nameOf(row.id);
  const { chosen, class: state } = detail.standing([row.id]);
  const href = element ? detail.toggle([row.id]) : undefined;
  return (
    <>
      <tr class={state} data-id={row.id}>
        <th scope="row">
          {href
            ? (
              <ModelContextLink
                class="matrix-row"
                href={href}
                aria-current={chosen ? "true" : "false"}
                title={element?.qname ?? undefined}
              >
                {detail.sysml && element && (
                  <KindMark
                    element={element}
                    sysml
                  />
                )}
                {name}
              </ModelContextLink>
            )
            : <span class="faint" title="Not in the model">{name}</span>}
        </th>
        {columns.map((target) => (
          <td key={target} class={starts.has(target) ? "g0" : undefined}>
            {row.targets.has(target) && (
              href
                ? (
                  <ModelContextLink
                    class="matrix-cell"
                    href={href}
                    aria-label={`${name}, performed by ${
                      detail.nameOf(target)
                    }`}
                    data-target={target}
                  >
                    <span class="dot allowed" />
                  </ModelContextLink>
                )
                : <span class="dot allowed" />
            )}
          </td>
        ))}
      </tr>
      <DetailSlot as="row" span={span} ids={[row.id]} detail={detail} />
    </>
  );
}

/**
 * System > Allocations: who performs what. The performers are the columns, by
 * unit; the rows are what the model allocates to them, by the flow they belong
 * to and the unit it is declared for; a dot is an `allocate` of the model.
 * Choosing a row, or one of its dots, opens it in a row under it. A unit the
 * board cannot tell is "?".
 */
export function AllocationsPage(
  { board, detail }: { board: ModelBoard; detail: Detail },
) {
  const model = allocationsOf(board);
  if (model.allocations === 0) {
    return <Empty code="no-allocation">No allocations yet</Empty>;
  }
  const columns = model.columns.flatMap((group) => group.targets);
  const starts = new Set(model.columns.map((group) => group.targets[0]));
  const span = columns.length + 1;
  const carried = new Set(
    model.groups.flatMap((group) => group.rows.map((row) => row.id)),
  );
  return (
    <div class={`allocations${detail.selected ? " has-selection" : ""}`}>
      <DetailUnderTitle detail={detail} carried={carried} />
      <div class="detail-table">
        <div class="matrix-scroll">
          <table class="matrix">
            <thead>
              <tr class="groups">
                <th />
                {model.columns.map((group) => (
                  <th key={group.unit ?? "?"} colSpan={group.targets.length}>
                    {unitLabel(detail, group.unit)}
                  </th>
                ))}
              </tr>
              <tr>
                <th />
                {columns.map((target) => (
                  <th
                    key={target}
                    class={`vert ${detail.standing([target]).class}`}
                    scope="col"
                  >
                    <span>{detail.nameOf(target)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.groups.map((group) => (
                <Fragment key={`${group.flow}|${group.unit}`}>
                  <tr class="matrix-group">
                    <th colSpan={span} scope="colgroup">
                      {groupLabel(group, detail)}
                    </th>
                  </tr>
                  {group.rows.map((row) => (
                    <Row
                      key={row.id}
                      row={row}
                      span={span}
                      starts={starts}
                      columns={columns}
                      detail={detail}
                    />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

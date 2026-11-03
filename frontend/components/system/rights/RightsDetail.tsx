import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { Detail } from "../../../lib/system/board/detail.ts";
import type {
  MatrixCell,
  MatrixColumn,
  MatrixRow,
} from "../../../lib/system/rights/api.ts";
import {
  type Actor,
  cellKey,
  codeWords,
  declaredBy,
  type Family,
  type Mark,
  markKey,
  markOf,
  type Rights,
  ruleOf,
  SELF_APPROVAL,
  sourceName,
  unusableWords,
} from "../../../lib/system/rights/projection.ts";
import { Icon } from "../../view/Icon.tsx";
import { DetailBox } from "../DetailBox.tsx";
import { RightsMark } from "./RightsMark.tsx";

/**
 * One cell of the matrix, told: what the right is, the state the model gives
 * it and why (its basis, the rule and where the host applies it, the codes
 * that qualify it), and the places of the model's files that declare it, each
 * a link to the file at its line. It opens in a row under the actor's line
 * (see `DetailSlot`).
 */
export function CellDetail(
  { cell, row, column, family, rights, detail }: {
    cell: MatrixCell;
    row: MatrixRow;
    column: MatrixColumn;
    family: Family | undefined;
    rights: Rights;
    detail: Detail;
  },
) {
  const rule = ruleOf(cell);
  const enforced = typeof cell.via?.enforcedAt === "string"
    ? cell.via.enforcedAt
    : undefined;
  const declared = declaredBy(cell);
  const mark = markOf(cell);
  // What the state is qualified by: how it is exercised, and that it is of no use.
  const qualifiers = [cell.mode, mark.unusable ? "of no use" : undefined]
    .filter((qualifier) => qualifier !== undefined);
  return (
    <DetailBox
      closeHref={detail.closeHref}
      data={{ "data-cell": cellKey(cell.row, cell.column) }}
    >
      {family && <div class="kind-kw">{family.label}</div>}
      <h2 class="detail-title">{rights.columnLabel(column, detail.sysml)}</h2>
      <div class="detail-type">{rights.rowLabel(row, detail.sysml)}</div>
      <dl class="detail-facts">
        <dt>State</dt>
        <dd>
          {cell.state}
          {qualifiers.map((qualifier) => (
            <span key={qualifier} class="faint">{` · ${qualifier}`}</span>
          ))}
        </dd>
        {cell.basis && (
          <>
            <dt>Basis</dt>
            <dd>{cell.basis}</dd>
          </>
        )}
        {rule && (
          <>
            <dt>Rule</dt>
            <dd>{rule}</dd>
          </>
        )}
        {enforced && (
          <>
            <dt>Applied at</dt>
            <dd class="is-code">{enforced}</dd>
          </>
        )}
        {cell.uncertain && (
          <>
            <dt>Uncertain</dt>
            <dd>{cell.uncertain.reason ?? cell.uncertain.code}</dd>
          </>
        )}
        {cell.codes.length > 0 && (
          <>
            <dt>Codes</dt>
            <dd class="rights-codes">
              {cell.codes.map((code) => (
                <span key={code} data-code={code} title={codeWords(code)}>
                  <code>{code}</code>
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {column.doc && <p class="detail-sum" title={column.doc}>{column.doc}</p>}
      {declared.length > 0 && (
        <div class="detail-rel">
          <div data-relation="Declared by">
            <h5>Declared by</h5>
            <div class="detail-chips">
              {declared.map((source) => (
                <ModelContextLink
                  key={`${source.file}:${source.line}:${source.qname}`}
                  class="chip is-source"
                  href={detail.sourceAt(source.file, source.line)}
                  title={source.qname ?? source.role}
                  data-action="source"
                >
                  <Icon name="file" />
                  {sourceName(source)}
                  <span class="faint">
                    {source.line === undefined
                      ? source.file
                      : `${source.file}:${source.line}`}
                  </span>
                </ModelContextLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </DetailBox>
  );
}

/** What a right of no use, or a state the page has no word for, says beside its line. */
function why(mark: Mark, cells: readonly MatrixCell[]): string {
  return mark.unusable
    ? unusableWords(cells).join(", ")
    : mark.kind === "empty" && mark.other
    ? mark.other
    : "";
}

/**
 * What an actor may do in a family, right by right, each with its mark; a
 * right granted to no use says why. It opens in a row under the actor's line.
 */
export function FamilyDetail(
  { actor, family, rights, detail }: {
    actor: Actor;
    family: Family;
    rights: Rights;
    detail: Detail;
  },
) {
  const lines = rights.lines(actor, family);
  return (
    <DetailBox
      closeHref={detail.closeHref}
      data={{ "data-mark": markKey(actor.id, family.id) }}
    >
      <div class="kind-kw">{family.label}</div>
      <h2 class="detail-title">{actor.label}</h2>
      <ul class="rights-lines">
        {lines.map(({ column, cells, mark }) => (
          <li key={column.id} title={column.doc} data-column={column.id}>
            <RightsMark mark={mark} />
            <span>{rights.columnLabel(column, detail.sysml)}</span>
            {why(mark, cells) && <span class="faint">{why(mark, cells)}</span>}
          </li>
        ))}
      </ul>
      {rights.flagged(actor, family) && (
        <p class="detail-sum rights-flag">{SELF_APPROVAL}</p>
      )}
    </DetailBox>
  );
}

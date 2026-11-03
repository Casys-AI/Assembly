import { ModelContextLink } from "../view/ModelContextLink.tsx";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import { ownSummary } from "../../lib/system/board/words.ts";
import type { Detail } from "../../lib/system/board/detail.ts";
import {
  type GuaranteeRow,
  markWords,
  requirementsOf,
} from "../../lib/system/views/requirements.ts";
import { Empty } from "../view/Empty.tsx";
import { Icon } from "../view/Icon.tsx";
import { DetailSlot, DetailUnderTitle } from "./DetailSlot.tsx";
import { Why } from "./Why.tsx";

/** The state of a row as a dot; the words are for whoever cannot see it. */
function Dot({ row }: { row: GuaranteeRow }) {
  return (
    <span
      class={`qmark is-${row.mark}`}
      role="img"
      aria-label={markWords(row)}
    />
  );
}

/** What a requirement says, in the model's words made readable or as SysML writes it. */
function RequirementText(
  { row, detail }: { row: GuaranteeRow; detail: Detail },
) {
  const { item, clauses } = row;
  if (detail.sysml) {
    return (
      <>
        <span class="kind-kw">{item.keyword}</span> {item.title}
        {item.type && <span class="qty">: {item.type.title}</span>}
        {item.expression && <span class="expr">{item.expression}</span>}
        {clauses.map((clause) => (
          <span key={clause.id} class="qclause">
            <span class="kind-kw">{clause.keyword}</span> {clause.title}
            {clause.expression && <span class="expr">{clause.expression}</span>}
          </span>
        ))}
      </>
    );
  }
  const summary = ownSummary(item);
  const names = [
    ...(summary ? [detail.nameOf(item.id)] : []),
    ...clauses.map((clause) => detail.nameOf(clause.id)),
  ];
  return (
    <>
      {summary ?? detail.nameOf(item.id)}
      {names.length > 0 && <span class="qsub">{names.join(" · ")}</span>}
    </>
  );
}

/** What a constraint says, and where it holds. */
function ConstraintText(
  { row, detail }: { row: GuaranteeRow; detail: Detail },
) {
  const { item } = row;
  const on = item.owner?.title ?? item.type?.title;
  const holds = row.mark === "on";
  if (detail.sysml) {
    return (
      <>
        <span class="kind-kw">{item.keyword}</span> {item.title}
        {item.type && <span class="qty">: {item.type.title}</span>}
        {item.expression && <span class="expr">{item.expression}</span>}
      </>
    );
  }
  return (
    <>
      {detail.nameOf(item.id)}
      {(on || !holds) && (
        <span class="qon">
          {on && `on ${detail.said(on)}`}
          {!holds && `${on ? " · " : ""}not performed`}
        </span>
      )}
    </>
  );
}

/**
 * One requirement or constraint. The row is a link: choosing it opens its
 * detail right under it, as the next item of the list. Its tooltip says what
 * the dot means.
 */
function Row(
  { row, detail }: { row: GuaranteeRow; detail: Detail },
) {
  const { item } = row;
  const { chosen, why, class: state } = detail.standing(row.ids);
  return (
    <>
      <li class="qitem">
        <ModelContextLink
          class={`qrow ${state}`}
          href={detail.toggle(row.ids)}
          aria-current={chosen ? "true" : "false"}
          data-id={item.id}
          data-mark={row.mark}
          title={`${item.title} — ${markWords(row)}`}
        >
          <Dot row={row} />
          <span class="qtext">
            {item.kind === "requirement"
              ? <RequirementText row={row} detail={detail} />
              : <ConstraintText row={row} detail={detail} />}
          </span>
          <Why labels={why} />
        </ModelContextLink>
      </li>
      <DetailSlot as="li" ids={row.ids} detail={detail} />
    </>
  );
}

function Section(
  { name, icon, rows, detail }: {
    name: string;
    icon: "shield" | "check";
    rows: readonly GuaranteeRow[];
    detail: Detail;
  },
) {
  if (rows.length === 0) return null;
  return (
    <section class="qsection" data-section={name.toLowerCase()}>
      <h3 class="qhead">
        <Icon name={icon} />
        {name}
      </h3>
      <ul class="qlist">
        {rows.map((row) => <Row key={row.item.id} row={row} detail={detail} />)}
      </ul>
    </section>
  );
}

/**
 * System > Requirements: what the model demands, and the checks it holds
 * itself to. A requirement's dot is on when some unit is declared to satisfy
 * it and off when none is; a constraint's is on when a performed step makes it
 * hold and idle when nothing does. The board has no proof that anything was
 * tested, so none is claimed. In SysML's words the page shows each statement
 * as written, with its expression.
 */
export function RequirementsPage(
  { board, detail }: { board: ModelBoard; detail: Detail },
) {
  const { requirements, constraints } = requirementsOf(board);
  if (requirements.length === 0 && constraints.length === 0) {
    return <Empty code="no-requirement">No requirements yet</Empty>;
  }
  const carried = new Set(
    [...requirements, ...constraints].flatMap((row) => row.ids),
  );
  return (
    <div class={`requirements${detail.selected ? " has-selection" : ""}`}>
      <DetailUnderTitle detail={detail} carried={carried} />
      <Section
        name="Requirements"
        icon="shield"
        rows={requirements}
        detail={detail}
      />
      <Section
        name="Constraints"
        icon="check"
        rows={constraints}
        detail={detail}
      />
    </div>
  );
}

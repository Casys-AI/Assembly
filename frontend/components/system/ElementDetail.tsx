import { ModelContextLink } from "../view/ModelContextLink.tsx";
import { Fragment } from "preact";
import type { BoardElement } from "../../lib/system/board/lookup.ts";
import { kindWord, ownSummary } from "../../lib/system/board/words.ts";
import { type Detail, factsOf } from "../../lib/system/board/detail.ts";
import { Icon } from "../view/Icon.tsx";
import { DetailBox } from "./DetailBox.tsx";

/** How many groups of relations the detail lists before offering the rest. */
const GROUPS_SHOWN = 3;
/** How many elements a group names before saying how many more. */
const CHIPS_SHOWN = 8;

/** What an element is related to under one label: the elements, each a link to it. */
function Group(
  { label, others, detail }: {
    label: string;
    others: readonly BoardElement[];
    detail: Detail;
  },
) {
  const named = detail.endpoints(others);
  return (
    <div data-relation={label}>
      <h5>{label}</h5>
      <div class="detail-chips">
        {named.slice(0, CHIPS_SHOWN).map(({ element, name }) => {
          const where = detail.where(element);
          return (
            <ModelContextLink
              key={element.id}
              class="chip"
              href={where.href}
              title={where.label}
            >
              {name}
            </ModelContextLink>
          );
        })}
        {named.length > CHIPS_SHOWN && (
          <span class="faint">+{named.length - CHIPS_SHOWN}</span>
        )}
      </div>
    </div>
  );
}

/**
 * What the element is related to, grouped by what the relation says. The first
 * groups are listed; the others open under a "more" the page needs no script for.
 */
function Relations({ element, detail }: {
  element: BoardElement;
  detail: Detail;
}) {
  const groups = detail.index.groups(element.id);
  if (groups.length === 0) return null;
  const rest = groups.slice(GROUPS_SHOWN);
  return (
    <div class="detail-rel">
      {groups.slice(0, GROUPS_SHOWN).map((group) => (
        <Group key={group.label} {...group} detail={detail} />
      ))}
      {rest.length > 0 && (
        <details class="detail-more">
          <summary class="chip">{rest.length} more</summary>
          {rest.map((group) => (
            <Group key={group.label} {...group} detail={detail} />
          ))}
        </details>
      )}
    </div>
  );
}

/**
 * One element of the model, told where it stands: what it is, what the model
 * says of it, what it is related to, and where to go from it. It opens in the
 * page, right under the element it was chosen from (see `DetailSlot`), so
 * nothing is covered; Escape and the cross close it (see `DetailBox`).
 * `narrow` is for a slot inside a column: the card above already says what
 * the element is, so the detail keeps to its summary and where to go.
 */
export function ElementDetail(
  { element, detail, narrow = false }: {
    element: BoardElement;
    detail: Detail;
    narrow?: boolean;
  },
) {
  const { sysml } = detail;
  const word = sysml ? element.keyword : kindWord(element);
  const { facts, more } = factsOf(element, sysml);
  const where = detail.where(element);
  const source = detail.source(element);
  const summary = ownSummary(element);
  const open = where.page !== detail.page;
  return (
    <DetailBox
      closeHref={detail.closeHref}
      narrow={narrow}
      data={{ "data-element": element.id }}
    >
      {!narrow && word && <div class="kind-kw">{word}</div>}
      {!narrow && <h2 class="detail-title">{detail.nameOf(element.id)}</h2>}
      {!narrow && sysml && element.type && (
        <div class="detail-type">: {element.type.title}</div>
      )}
      {summary && <p class="detail-sum" title={summary}>{summary}</p>}
      {!narrow && facts.length > 0 && (
        <dl class="detail-facts">
          {facts.map((fact, at) => (
            <Fragment key={at}>
              <dt>{fact.name}</dt>
              <dd class={fact.code ? "is-code" : undefined}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {!narrow && more > 0 && <div class="faint">+{more} more</div>}
      {!narrow && <Relations element={element} detail={detail} />}
      {(open || source) && (
        <div class="detail-actions">
          {open && (
            <ModelContextLink
              class="chip is-action"
              href={where.href}
              data-action="open"
            >
              <Icon name="open" />
              {where.label}
            </ModelContextLink>
          )}
          {source && (
            <ModelContextLink
              class="chip is-action"
              href={source}
              data-action="source"
            >
              <Icon name="file" />
              Source
            </ModelContextLink>
          )}
        </div>
      )}
    </DetailBox>
  );
}

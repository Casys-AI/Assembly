import type { ComponentChildren } from "preact";
import type { Detail } from "../../lib/system/board/detail.ts";
import { ElementDetail } from "./ElementDetail.tsx";

/**
 * Where the detail of an element opens: in the page, right after the element
 * it was chosen from, never over it and never in a panel of its own. One
 * detail is open at a time, so of all the slots a page draws only the one that
 * comes after the selected element shows anything.
 *
 * A page builds its `Detail` (lib/element-detail.ts) from the address, then
 *   - draws `<DetailSlot ids={[…]} detail={detail} />` after each element it
 *     shows, with every id the element goes by (a card standing for twins has
 *     several);
 *   - draws `<DetailUnderTitle>` once, before its content, for a selection no
 *     element of the page carries (it then follows the title).
 * A page whose choices are not elements of the board (a cell of the rights)
 * decides for itself when its choice (`Detail.choice`) is open, and draws its
 * own detail, in a `DetailBox`, with `DetailPlace`: the same place, put the
 * same way, without the slot's element to look for.
 *
 * `narrow` is for a slot inside a column. The slot goes where its element is:
 * beside it in a block (the default), as an item of a list (`as="li"`, never a
 * direct child of the list), or as a row of a table (`as="row"`, over `span`
 * columns).
 *
 * A table that draws `as="row"` slots is wrapped in an element of class
 * `detail-table` (view.css): the row's detail is as wide as that container
 * and hangs over the table's columns, so the wrapper clips nothing (no
 * `overflow` of its own, no rounded corners cut with `overflow: hidden`).
 */

type Placement =
  | { as?: undefined }
  | { as: "li" }
  | { as: "row"; span: number };

/**
 * Where a detail goes: beside its element, as an item of a list, or as a row
 * of a table (see `Placement`).
 */
export function DetailPlace(
  { children, ...placement }: { children: ComponentChildren } & Placement,
) {
  if (placement.as === "li") return <li class="detail-item">{children}</li>;
  if (placement.as === "row") {
    return (
      <tr class="detail-row">
        <td colSpan={placement.span}>
          <div class="detail-hold">{children}</div>
        </td>
      </tr>
    );
  }
  return <>{children}</>;
}

export function DetailSlot(
  { ids, detail, narrow, ...placement }: {
    /** The ids the element after which the slot stands goes by. */
    ids: readonly string[];
    detail: Detail;
    narrow?: boolean;
  } & Placement,
) {
  const { selected } = detail;
  if (!selected || !ids.includes(selected.id)) return null;
  return (
    <DetailPlace {...(placement as Placement)}>
      <ElementDetail
        key={selected.id}
        element={selected}
        detail={detail}
        narrow={narrow}
      />
    </DetailPlace>
  );
}

/**
 * The detail of a selection that no element of the page carries: it follows the
 * title. `carried` says which ids the page draws an element for.
 */
export function DetailUnderTitle(
  { detail, carried }: { detail: Detail; carried: ReadonlySet<string> },
) {
  const { selected } = detail;
  if (!selected || carried.has(selected.id)) return null;
  return <ElementDetail key={selected.id} element={selected} detail={detail} />;
}

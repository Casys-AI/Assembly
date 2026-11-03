import type { BoardItemKind } from "../../../src/domain/model/records/board.ts";
import { kindWord } from "../../lib/system/board/words.ts";
import { Icon, type IconName } from "../view/Icon.tsx";

/**
 * The mark each kind of item wears in the readable view. Typed by the board's
 * kinds, so a kind the contract adds is a type error until it has its mark;
 * what is not an item (a port, a step, a clause, a state) wears a dot.
 */
const KIND_ICON: Readonly<Record<BoardItemKind, IconName>> = {
  scope: "spark",
  operator: "spark",
  machine: "cube",
  capability: "arrows",
  tool: "wrench",
  "capability-type": "wrench",
  skill: "book",
  access: "open",
  mandate: "key",
  authority: "key",
  policy: "file",
  requirement: "shield",
  constraint: "check",
  lifecycle: "ring",
  information: "book",
};

/**
 * What kind an element is, as a small mark: an icon, with the kind as a person
 * says it for its tooltip. In SysML's own words it is the keyword of the
 * declaration instead.
 */
export function KindMark(
  { element, sysml }: {
    element: { kind: string; keyword: string };
    sysml: boolean;
  },
) {
  if (sysml) return <span class="kind-kw">{element.keyword}</span>;
  const icon = Object.hasOwn(KIND_ICON, element.kind)
    ? KIND_ICON[element.kind as BoardItemKind]
    : "dot";
  return (
    <span class="kind-icon" title={kindWord(element) || element.keyword}>
      <Icon name={icon} />
    </span>
  );
}

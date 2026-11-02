import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import {
  type BoardElement,
  type BoardIndex,
  indexBoard,
  type Lens,
} from "./lookup.ts";
import {
  SYSTEM_PAGE_NAMES,
  systemHref,
  type SystemPage,
  systemPageFor,
} from "../../workbench/desk.ts";
import {
  humanize,
  isMasked,
  rawValue,
  readableValue,
  withoutUnit,
} from "./words.ts";
import { filesHref } from "../../model/sources/files.ts";

/**
 * How the selection puts an element of the page forward: the element a card
 * or a row stands for is chosen, lit (related to the choice, with the reason
 * the relation gives), in its context (holds the choice or is held by it) or
 * left alone, which a page with a choice steps back.
 */
export interface Standing {
  /** The selection is one of the element's ids. */
  chosen: boolean;
  /** Why it is lit: the labels of the relations that lead from the selection to it. */
  why: readonly string[];
  /** The classes of the element: `el`, and what the selection makes of it. */
  class: string;
}

/**
 * What a System page needs to open an element in place: the element the
 * address selects, the words to tell it in, and the addresses it leads to.
 * A page builds one with `detailOf` and hands it to the slots it draws
 * (components/system/DetailSlot.tsx); every page of the place reads an
 * element the same way. Pure: the same board and address give the same detail.
 */
export interface Detail {
  index: BoardIndex;
  /** The page it is drawn on. */
  page: SystemPage;
  /** The element the address selects; none when it names none the board holds. */
  selected: BoardElement | undefined;
  /**
   * `?select=` as the address gives it, whether the board holds it or not: a
   * page whose choices are not elements of the board (the cell of a matrix)
   * reads its own choice here, and opens it with `DetailSlot`.
   */
  choice: string | null;
  /** What the selection lights on the page, when there is one. */
  lens: Lens | undefined;
  /** SysML's own words (keywords, types) rather than the readable ones. */
  sysml: boolean;
  /**
   * What an element is called, the one rule of its name on every page: a unit
   * as the team calls it (its identifier in SysML's words), any other element
   * by its title, said (see `said`). An id the board does not hold is its own name.
   */
  nameOf(id: string): string;
  /**
   * A word of the model told in the viewer's words: the model's identifier
   * in SysML's, a phrase (`maxAgentDecisions` as "Max agent decisions")
   * otherwise. Everything a page writes of the model that is not an element's
   * own name (a jump's target, a trigger, a name given by its title) goes
   * through it, so no page tells the same word two ways.
   */
  said(text: string): string;
  /**
   * The names of the units `ids` stand for (the `scope` of an item), each
   * once, in order, as `nameOf` tells them; an id the board does not hold is
   * left out.
   */
  unitNames(ids: readonly string[]): readonly string[];
  /**
   * The elements a relation names, each by the name a person reads (a port by
   * the part it belongs to). The same element declared in several units reads
   * alike, so it is named once: the first of them stands for the others.
   */
  endpoints(
    others: readonly BoardElement[],
  ): readonly { element: BoardElement; name: string }[];
  /** The page an element is the home of, and the address that opens it there. */
  where(
    element: BoardElement,
  ): { page: SystemPage; label: string; href: string };
  /**
   * The address that selects the first of `ids` on this page, or the one that
   * deselects when the selection (the element, or the page's own choice) is
   * one of them: a card is clicked twice to close.
   */
  toggle(ids: readonly string[]): string;
  /**
   * How the selection puts forward the element that goes by these ids (a card
   * standing for twins has several). An element is lit when what it is related
   * to is it or is inside it, and says why (`inside`); a page that draws the
   * parts inside an element too asks for the reason only where the relation
   * ends (`own`), so a part is not said again by every panel around it.
   */
  standing(ids: readonly string[], reasons?: "inside" | "own"): Standing;
  /** This page with nothing selected. */
  closeHref: string;
  /**
   * The same detail on a page that reads more than the selection: the
   * addresses that stay on the page (`toggle`, `closeHref`) also carry
   * `params` (the flow being read, say), so choosing or closing an element
   * does not change what the page shows. Those that lead to another page do
   * not.
   */
  keeping(params: Readonly<Record<string, string>>): Detail;
  /** The line of the model's sources that declares the element, when it has one. */
  source(element: BoardElement): string | undefined;
  /** The address of a line of a file of the model, at the version the page reads. */
  sourceAt(file: string, line?: number): string;
}

export function detailOf(
  options: {
    board: ModelBoard;
    page: SystemPage;
    /** `?select=` as the address gives it. */
    selected: string | null;
    sysml: boolean;
    /** `?version=`: kept in every address, so the page stays at that version. */
    version?: string;
    /** Units by id, as they are called (the roster knows names the model does not). */
    names?: ReadonlyMap<string, string>;
  },
): Detail {
  const { page, sysml, version, names } = options;
  const index = indexBoard(options.board);
  const choice = options.selected || null;
  const resolved = options.selected ? index.resolve(options.selected) : null;
  const selected = resolved ? index.get(resolved) : undefined;
  const lens = selected ? index.lens(selected.id) : undefined;
  // SysML's own words are the model's identifiers; the names are the readable view's.
  const said = (text: string) => sysml ? text : humanize(text);
  // A unit is called as the team calls it, in the readable view only.
  const teamName = (id: string) => sysml ? undefined : names?.get(id);
  const titled = (element: BoardElement) =>
    // A unit the team has no name for keeps its identifier: a name is never made up.
    teamName(element.id) ??
      (element.kind === "scope" ? element.title : said(element.title));
  const nameOf = (id: string): string => {
    const element = index.get(id);
    return element ? titled(element) : id;
  };
  const unitNames = (ids: readonly string[]) =>
    [...new Set(ids)].flatMap((id) => index.get(id) ? [nameOf(id)] : []);
  const endpoint = (element: BoardElement) => {
    const owner = element.kind === "port" && element.parent
      ? index.get(element.parent)
      : undefined;
    // A port is a path of identifiers: the part it belongs to (a unit as the
    // team calls it) and its own, as the model writes them.
    return owner
      ? `${teamName(owner.id) ?? owner.title}.${element.title}`
      : titled(element);
  };
  const make = (params: Readonly<Record<string, string>>): Detail => {
    const closeHref = systemHref(page, { ...params, select: null, version });
    const picked = (ids: readonly string[]) =>
      (selected !== undefined && ids.includes(selected.id)) ||
      (choice !== null && ids.includes(choice));
    const sourceAt = (file: string, line?: number) =>
      filesHref({ version, file, line });
    return {
      index,
      page,
      selected,
      choice,
      lens,
      sysml,
      nameOf,
      said,
      unitNames,
      endpoints(others) {
        const named = new Map<string, BoardElement>();
        for (const element of others) {
          const name = endpoint(element);
          if (!named.has(name)) named.set(name, element);
        }
        return [...named].map(([name, element]) => ({ element, name }));
      },
      where(element) {
        const home = systemPageFor(element.home);
        return {
          page: home,
          label: SYSTEM_PAGE_NAMES[home],
          href: systemHref(home, { select: element.id, version }),
        };
      },
      standing(ids, reasons) {
        const chosen = selected !== undefined && ids.includes(selected.id);
        if (chosen || !lens) {
          return { chosen, why: [], class: chosen ? "el is-selected" : "el" };
        }
        const said = (read: (id: string) => readonly string[]) => [
          ...new Set(ids.flatMap(read)),
        ];
        const lit = said(lens.labels);
        const state = lit.length > 0
          ? "is-lit"
          : ids.some((id) => lens.context(id))
          ? "is-context"
          : "";
        return {
          chosen,
          why: reasons === "own" ? said(lens.own) : lit,
          class: state ? `el ${state}` : "el",
        };
      },
      toggle: (ids) =>
        picked(ids)
          ? closeHref
          : systemHref(page, { ...params, select: ids[0], version }),
      closeHref,
      keeping: (more) => make({ ...params, ...more }),
      source: (element) =>
        element.file ? sourceAt(element.file, element.line) : undefined,
      sourceAt,
    };
  };
  return make({});
}

/** One thing the model says of an element, as a name and what it is. */
export interface Fact {
  name: string;
  value: string;
  /** Written as the model writes it, in monospace. */
  code: boolean;
}

/** The values the detail lists, before it says how many more there are. */
const READABLE_FACTS = 6;
const SYSML_FACTS = 14;

/**
 * What the detail of an element lists. The readable view keeps to what the
 * model declares for people (the values, named and valued as a person says
 * them, without the identity and versioning it keeps for itself); the SysML
 * view adds how the element is declared (name, source, expression) and every
 * value as written. `more` counts the values left out for room.
 */
export function factsOf(
  element: BoardElement,
  sysml: boolean,
): { facts: readonly Fact[]; more: number } {
  const declared = (element.values ?? []).filter((entry) =>
    sysml || !isMasked(entry.name)
  );
  const room = sysml ? SYSML_FACTS : READABLE_FACTS;
  const code = (name: string, value: string): Fact => ({
    name,
    value,
    code: true,
  });
  return {
    facts: [
      ...(sysml && element.qname ? [code("Name", element.qname)] : []),
      ...(sysml && element.file
        ? [code("Source", `${element.file}:${element.line ?? 1}`)]
        : []),
      ...(element.guard ? [code("Guard", element.guard)] : []),
      ...(sysml && element.expression
        ? [code("Expression", element.expression)]
        : []),
      ...declared.slice(0, room).map((entry) =>
        sysml ? code(entry.name, rawValue(entry.value)) : {
          // A duration says its unit itself: "Timeout: 1.5 min", not "Timeout ms".
          name: humanize(
            typeof entry.value === "number"
              ? withoutUnit(entry.name)
              : entry.name,
          ),
          value: readableValue(entry.value, entry.name),
          code: false,
        }
      ),
    ],
    more: Math.max(0, declared.length - room),
  };
}

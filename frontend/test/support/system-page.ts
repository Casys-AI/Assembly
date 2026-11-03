import { type ComponentType, h } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import type { SystemPage } from "../../lib/workbench/desk.ts";
import { type Detail, detailOf } from "../../lib/system/board/detail.ts";
import { ANALYST, COLLECTOR, COORDINATOR } from "./board-fixture.ts";
import { tidy } from "./markup.ts";

/** The units of the fixture boards, as the team calls them. */
export const UNIT_NAMES: ReadonlyMap<string, string> = new Map([
  [COORDINATOR, "Coordinateur"],
  [ANALYST, "Analyste"],
  [COLLECTOR, "Collecteur"],
]);

/** What the address and the viewer say of a page being drawn. */
export interface PageOptions {
  /** `?select=`. */
  selected?: string | null;
  /** The viewer reads SysML's words. */
  sysml?: boolean;
  /** `?version=`. */
  version?: string;
  /** Units by id, as they are called; the fixture's team when absent. */
  names?: ReadonlyMap<string, string>;
}

/**
 * A System page as the place draws it for an address: the markup of `Page`
 * given the board and the `Detail` the frame builds for it, tidied. `extra`
 * is whatever else the page reads of the address (the flow on show).
 */
export function renderSystemPage<Extra extends object = Record<never, never>>(
  Page: ComponentType<{ board: ModelBoard; detail: Detail } & Extra>,
  page: SystemPage,
  board: ModelBoard,
  over: PageOptions = {},
  extra?: Extra,
): string {
  const detail = detailOf({
    board,
    page,
    selected: over.selected ?? null,
    sysml: over.sysml ?? false,
    version: over.version,
    names: over.names ?? UNIT_NAMES,
  });
  return tidy(
    renderToString(
      h(Page as ComponentType<Record<string, unknown>>, {
        board,
        detail,
        ...extra,
      }),
    ),
  );
}

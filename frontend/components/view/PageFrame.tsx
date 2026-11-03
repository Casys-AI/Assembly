import type { ComponentChildren } from "preact";
import { MoreMenu } from "./MoreMenu.tsx";
import { PageNav, type PageTab } from "./PageNav.tsx";

/**
 * How a page uses the window's width:
 * - `column`: a centred column of at most 1080px, which scrolls;
 * - `wide`: the whole width, which scrolls;
 * - `fill`: the whole width and height, for a page that draws its own canvas.
 * The title sits at the same place in all three.
 */
export type PageLayout = "column" | "wide" | "fill";

/**
 * The frame every page of a place shares: the pages as tabs at the top (the
 * ones that are not tabs in a "More" menu after them), with room for the
 * window's close button on their right, then the page's title,
 * always at the same place, then the page. A place with a single page has no
 * tabs, and keeps the room: its title falls where the others' do. The close
 * button belongs to the window around the frame.
 */
export function PageFrame(
  {
    label,
    title,
    tabs = [],
    more,
    current,
    layout = "column",
    actions,
    children,
  }: {
    /** What the list of pages is called, e.g. "Model pages". */
    label?: string;
    /** The page's own name, shown once as the page title. */
    title: string;
    /** The place's pages; absent for a place that has only one. */
    tabs?: readonly PageTab[];
    /** Pages kept in a menu after the tabs; `label` names the menu, "More" by default. */
    more?: { label?: string; tabs: readonly PageTab[] };
    /** The id of the page shown, among the tabs and the menu's pages. */
    current: string;
    layout?: PageLayout;
    /** What belongs on the right of the tabs, such as a search. */
    actions?: ComponentChildren;
    children: ComponentChildren;
  },
) {
  return (
    <div class={`view-page is-${layout}`} data-page={current}>
      <header class="view-head">
        {tabs.length > 0 && (
          <PageNav label={label ?? title} tabs={tabs} current={current} />
        )}
        {more && (
          <MoreMenu label={more.label} tabs={more.tabs} current={current} />
        )}
        {actions && <div class="view-head-end">{actions}</div>}
      </header>
      <div class="view-body">
        <div class="view-column">
          <h1 class="view-title">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

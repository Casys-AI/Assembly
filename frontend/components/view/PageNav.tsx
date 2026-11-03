import { ModelContextLink } from "./ModelContextLink.tsx";
export interface PageTab {
  id: string;
  label: string;
  /** The page's address: a tab is a real link, so Fresh owns the navigation. */
  href: string;
}

/**
 * The pages of a place, as links; the page shown says so with aria-current.
 * Fresh marks any link whose path is the current one as current, and the pages
 * of a place share a path: every tab states its own value, so Fresh leaves it.
 */
export function PageNav(
  { label, tabs, current }: {
    /** What the list of pages is called, e.g. "Model pages". */
    label: string;
    tabs: readonly PageTab[];
    current: string;
  },
) {
  return (
    <nav class="view-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <ModelContextLink
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === current ? "page" : "false"}
        >
          {tab.label}
        </ModelContextLink>
      ))}
    </nav>
  );
}

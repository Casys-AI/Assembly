import { ModelContextLink } from "./ModelContextLink.tsx";
import { useRef } from "preact/hooks";
import type { PageTab } from "./PageNav.tsx";
import { useDismiss } from "./useDismiss.ts";

/**
 * The pages of a place that are not tabs, in a menu after the tabs. It is a
 * disclosure, so it works as markup (the pages are real links, Fresh owns the
 * navigation) and needs no script to open. When one of its pages is shown, the
 * menu is called by it. It sits outside the tab strip, whose scrolling would
 * clip it.
 */
export function MoreMenu(
  { label = "More", tabs, current }: {
    label?: string;
    tabs: readonly PageTab[];
    /** The id of the page shown. */
    current: string;
  },
) {
  const area = useRef<HTMLDetailsElement>(null);
  useDismiss(area);
  if (tabs.length === 0) return null;
  const shown = tabs.find((tab) => tab.id === current);
  return (
    <details class="view-more" ref={area}>
      <summary aria-current={shown ? "page" : "false"}>
        {shown?.label ?? label}
      </summary>
      <div class="view-more-list">
        {tabs.map((tab) => (
          <ModelContextLink
            key={tab.id}
            href={tab.href}
            aria-current={tab.id === current ? "page" : "false"}
          >
            {tab.label}
          </ModelContextLink>
        ))}
      </div>
    </details>
  );
}

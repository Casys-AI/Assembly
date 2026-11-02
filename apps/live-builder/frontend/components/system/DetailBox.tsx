import { useModelContextHref } from "../view/ModelContextLink.tsx";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useEscapeKey } from "../view/useEscapeKey.ts";
import { useReturnFocus } from "../view/useReturnFocus.ts";

/**
 * The box every detail opens in (see `DetailSlot`): a cross that closes it by
 * the page's own link, Escape doing the same, the focus going back to what it
 * was opened from, and the box coming into view when it opens under an element
 * far down the page. What it holds is the detail's own: an element
 * (`ElementDetail`), a cell of the rights (`RightsDetail`). `data` says what it
 * is the detail of (`data-element`, `data-cell`), for whatever reads the page
 * after a program.
 */
export function DetailBox(
  { closeHref, narrow = false, data, children }: {
    /** The address of the page with nothing selected. */
    closeHref: string;
    /** For a slot inside a column: the box keeps to a summary. */
    narrow?: boolean;
    data: Readonly<Record<`data-${string}`, string>>;
    children: ComponentChildren;
  },
) {
  const contextualCloseHref = useModelContextHref(closeHref);
  const closer = useRef<HTMLAnchorElement>(null);
  const box = useRef<HTMLElement>(null);
  // The cross is a link, so closing by key is following it.
  useEscapeKey(() => closer.current?.click());
  // Closed from the keyboard, the focus goes back to the element it opened from.
  useReturnFocus(box);
  // Opened under an element far down the page, it comes into view.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <aside
      class={`detail${narrow ? " is-narrow" : ""}`}
      aria-label="Detail"
      {...data}
      ref={box}
    >
      <a
        ref={closer}
        class="detail-x"
        href={contextualCloseHref}
        aria-label="Close"
        title="Close (Esc)"
      >
        ×
      </a>
      {children}
    </aside>
  );
}

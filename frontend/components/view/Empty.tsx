import type { ComponentChildren } from "preact";

/**
 * What a page says when the model declares nothing for it ("No agent
 * declared"): one line, centred, in the page's own voice. `code` is for
 * whatever reads the page after a program.
 */
export function Empty(
  { code, children }: { code: string; children: ComponentChildren },
) {
  return <p class="view-empty" data-code={code}>{children}</p>;
}

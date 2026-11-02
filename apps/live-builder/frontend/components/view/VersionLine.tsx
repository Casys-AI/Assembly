import { ModelContextLink } from "./ModelContextLink.tsx";
import type { ComponentChildren } from "preact";
import { shortCommit } from "../../lib/model/revisions/change.ts";

/**
 * Which version of the model a page was drawn from: the commit read, short
 * (the whole identity in the tooltip), and a way back to the current model when
 * the reader is pinned. The link retains its Main or Case source context.
 * `children` sit after it, for what a page has to say about that version.
 */
export function VersionLine(
  { version, pinned, home, children, currentLabel }: {
    /** The commit the page describes. */
    version: string;
    /** The reader uses an exact version, including a host-resolved Case pin. */
    pinned: boolean;
    /** The same page at its current model, with the source scope retained. */
    home: string;
    /** Scoped Request current model; absent for the Main head. */
    currentLabel?: string;
    children?: ComponentChildren;
  },
) {
  return (
    <div class="repo-version" data-version={version}>
      <code title={version}>{shortCommit(version)}</code>
      {pinned
        ? <ModelContextLink href={home}>Show current model</ModelContextLink>
        : currentLabel
        ? <span class="chip">{currentLabel}</span>
        : <span class="chip" title="The head of main">main</span>}
      {children}
    </div>
  );
}

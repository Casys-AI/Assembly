import { ModelContextLink } from "./ModelContextLink.tsx";
import type { ComponentChildren } from "preact";
import type { VersionInfo } from "../../lib/workbench/version-label.ts";
import { WorkspaceVersion } from "../workbench/WorkspaceVersion.tsx";

/**
 * The readable source of a page, with its exact identity in inspection and a
 * way back to the current model. The link retains its Main or Request scope.
 * `children` sit after it, for what a page has to say about that version.
 */
export function VersionLine(
  { version, pinned, home, children, info }: {
    /** The commit the page describes. */
    version: string;
    /** The reader uses an exact version, including a host-resolved Case pin. */
    pinned: boolean;
    /** The same page at its current model, with the source scope retained. */
    home: string;
    info: VersionInfo;
    children?: ComponentChildren;
  },
) {
  return (
    <div class="repo-version" data-version={version}>
      <WorkspaceVersion
        info={{ ...info, version, readOnly: info.readOnly ?? pinned }}
      />
      {pinned && (
        <ModelContextLink href={home}>Show current model</ModelContextLink>
      )}
      {children}
    </div>
  );
}

import type { VersionInfo } from "../../../lib/workbench/version-label.ts";
import { VersionLine } from "../../view/VersionLine.tsx";

/**
 * Which version of the model the page was drawn from (see `VersionLine`). When
 * the model in service is another commit, the gap is said on the line, since
 * the page then describes what is not yet what runs.
 */
export function BoardVersion(
  { version, pinned, home, info }: {
    /** The commit the board describes. */
    version: string;
    /** The address named this version: it is not the head. */
    pinned: boolean;
    /** The address of the same page at the head. */
    home: string;
    info: VersionInfo;
  },
) {
  return (
    <VersionLine
      version={version}
      pinned={pinned}
      home={home}
      info={info}
    />
  );
}

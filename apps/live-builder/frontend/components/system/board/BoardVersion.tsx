import { shortCommit } from "../../../lib/model/revisions/change.ts";
import { sameSourceVersion } from "../../../lib/model/revisions/api.ts";
import { VersionLine } from "../../view/VersionLine.tsx";

/**
 * Which version of the model the page was drawn from (see `VersionLine`). When
 * the model in service is another commit, the gap is said on the line, since
 * the page then describes what is not yet what runs.
 */
export function BoardVersion(
  { version, pinned, inService, home, currentLabel }: {
    /** The commit the board describes. */
    version: string;
    /** The address named this version: it is not the head. */
    pinned: boolean;
    /** The commit the central agent runs, when known. */
    inService?: string;
    /** The address of the same page at the head. */
    home: string;
    currentLabel?: string;
  },
) {
  const gap = inService !== undefined && !sameSourceVersion(version, inService);
  return (
    <VersionLine
      version={version}
      pinned={pinned}
      home={home}
      currentLabel={currentLabel}
    >
      {gap && (
        <span
          class="chip warn"
          title={`The model in service is ${inService}`}
          data-gap="true"
        >
          In service: {shortCommit(inService)}
        </span>
      )}
    </VersionLine>
  );
}

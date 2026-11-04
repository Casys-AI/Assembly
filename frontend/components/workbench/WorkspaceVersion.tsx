import { useEffect, useState } from "preact/hooks";
import {
  createRevisionApi,
  sameSourceVersion,
  type SourceHistory,
} from "../../lib/model/revisions/api.ts";
import { modelLive, silentModelLive } from "../../lib/model/live.ts";
import type { VersionInfo } from "../../lib/workbench/version-label.ts";
import { VersionPill } from "../view/VersionPill.tsx";
import { useModelLive } from "../view/useModelLive.ts";

// Coalesce simultaneous title/page reads only; no persistent cross-session cache.
const historyReads = new Map<string, Promise<SourceHistory>>();
function readHistory(announcement: string) {
  let read = historyReads.get(announcement);
  if (!read) {
    read = createRevisionApi().history(undefined, { limit: 200 }).finally(() =>
      historyReads.delete(announcement)
    );
    historyReads.set(announcement, read);
  }
  return read;
}

/** Exact commit dates, with the admitted head refreshed by existing source events. */
export function WorkspaceVersion({ info, followHead = false, inspect = true }: {
  info: VersionInfo;
  /** Only unpinned source pages follow Main's admitted head, never execution. */
  followHead?: boolean;
  inspect?: boolean;
}) {
  const main = info.source.kind === "main";
  const [announcement, setAnnouncement] = useState("");
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{ key: string; history?: SourceHistory }>();
  useModelLive(
    (head) => setAnnouncement(head.version),
    main ? modelLive : silentModelLive,
  );
  const key = main ? `${announcement}:${retry}` : null;
  useEffect(() => {
    if (key === null) return;
    let active = true;
    readHistory(announcement).then(
      (history) => {
        if (active) setRead({ key, history });
      },
      () => {
        if (active) setRead({ key });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  const history = read?.key === key ? read.history : undefined;
  const version = followHead ? history?.headVersion : info.version;
  const commit = history?.commits.find((commit) =>
    sameSourceVersion(commit.version, version)
  );
  return (
    <VersionPill
      {...info}
      version={version}
      modelDigest={version === info.version ? info.modelDigest : undefined}
      headVersion={main
        ? history?.headVersion ?? info.headVersion
        : info.headVersion}
      createdAt={info.createdAt ?? commit?.createdAt}
      inspect={inspect}
      onInspect={main && read?.key === key && !history
        ? () => setRetry((value) => value + 1)
        : undefined}
    />
  );
}

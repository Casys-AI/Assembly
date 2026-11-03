import type { ActivityFile } from "../../../lib/model/revisions/activity.ts";
import { LineCounts } from "./ModelChangeCard.tsx";

const statusName: Record<ActivityFile["status"], string> = {
  added: "added",
  modified: "changed",
  deleted: "removed",
  renamed: "renamed",
};

/**
 * The files a change touches, one a line: what happened to it, its path as a
 * link to the file in Files, and the lines it gained and lost. A file the
 * change removed is not a link: there is nothing left to open. It lists files
 * when there is no diff to read them from, such as the first commit's.
 */
export function ChangedFiles({ files }: { files: readonly ActivityFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul class="act-files" aria-label="Changed files">
      {files.map((file) => (
        <li key={file.path} data-status={file.status}>
          <span class={`act-status is-${file.status}`}>
            {statusName[file.status]}
          </span>
          {file.href
            ? (
              // Stated either way: Fresh marks a link to the current path, and
              // Files shares the path of the pages around it.
              <a class="act-path" href={file.href} aria-current="false">
                {file.path}
              </a>
            )
            : <span class="act-path">{file.path}</span>}
          {file.previousPath && (
            <span class="act-from">from {file.previousPath}</span>
          )}
          {(file.additions > 0 || file.deletions > 0) && (
            <LineCounts
              additions={file.additions}
              deletions={file.deletions}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

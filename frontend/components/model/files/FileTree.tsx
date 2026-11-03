import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { type FileGroup, filesHref } from "../../../lib/model/sources/files.ts";

/**
 * The files of a version, grouped by directory: the root's first, then each
 * directory with its files. A file is a link to its address, which keeps the
 * version the page was asked to read; the one on show says so.
 */
export function FileTree(
  { groups, current, version }: {
    groups: readonly FileGroup[];
    /** The path of the file on show. */
    current: string | undefined;
    /** The version named in the address, if one is: the links keep it. */
    version?: string;
  },
) {
  return (
    <nav class="tree" aria-label="Files">
      {groups.map((group) => (
        <div
          key={group.dir}
          class="tree-group"
          role="group"
          aria-label={group.dir || "Root"}
        >
          {group.dir && <div class="tree-dir">{group.dir}</div>}
          {group.files.map(({ name, entry }) => (
            <ModelContextLink
              key={entry.path}
              class="tree-file"
              href={filesHref({ version, file: entry.path })}
              title={entry.path}
              // Stated either way: Fresh marks a link whose path is the
              // current one, and every file shares the page's path.
              aria-current={entry.path === current ? "true" : "false"}
            >
              {name}
            </ModelContextLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

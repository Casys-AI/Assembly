import { type ReadonlySignal, signal } from "@preact/signals";
import type { ModelFileLastChange } from "../../../../src/domain/model/records/revision.ts";
import { modelHref } from "../../workbench/desk.ts";
import { headReader } from "../head-reader.ts";
import {
  type CodedProblem,
  type createRevisionApi,
  problemOf,
  versionMessages,
  type VersionProblemCode,
  versionProblemOf,
} from "../revisions/api.ts";

/**
 * The files of the model as the Files page reads them: the files of one
 * version (the admitted head, or the version the address names), the commit
 * that last changed each, and the text of the one on show. The paths are the
 * model's own (`a.sysml`, `lib/b.sysml`), the same in every route.
 */

export type FilesApi = Pick<
  ReturnType<typeof createRevisionApi>,
  "files" | "sources"
>;

/** What went wrong, for a program to act on; `message` is for the person. */
export type FilesProblemCode =
  | VersionProblemCode
  | "files-failed"
  | "sources-failed"
  | "file-unreadable";

export type FilesProblem = CodedProblem<FilesProblemCode>;

const messages: Record<FilesProblemCode, string> = {
  ...versionMessages,
  "files-failed": "The files could not be read.",
  "sources-failed": "The file could not be read.",
  "file-unreadable": "The host listed this file but did not send its text.",
};

export const filesProblem = (
  code: FilesProblemCode,
  failure?: unknown,
): FilesProblem => problemOf(code, messages[code], failure);

/** Why the host would not list the files of a version: the version, or the read. */
const listingProblem = (failure: unknown): FilesProblemCode =>
  versionProblemOf(failure) ?? "files-failed";

/** A file of the tree: the name it shows, and what the host knows of it. */
export interface FileRow {
  /** The file's own name, without the `.sysml` every source has. */
  name: string;
  entry: ModelFileLastChange;
}
/** The files of one directory (`""` for the model's root), in name order. */
export interface FileGroup {
  dir: string;
  files: FileRow[];
}

const byCode = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** "lib/b.sysml" as "b": the directory is said by its group. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.sysml$/, "");
}

/**
 * The files grouped by directory, as the tree draws them: the root first, then
 * the directories by name, each with its files by name. Code-unit order, so
 * the same files always make the same tree.
 */
export function fileGroups(
  files: readonly ModelFileLastChange[],
): FileGroup[] {
  const groups = new Map<string, FileRow[]>();
  for (const entry of [...files].sort((a, b) => byCode(a.path, b.path))) {
    const dir = entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : "";
    groups.set(dir, [...groups.get(dir) ?? [], {
      name: fileName(entry.path),
      entry,
    }]);
  }
  return [...groups]
    .sort(([a], [b]) => a === "" ? -1 : b === "" ? 1 : byCode(a, b))
    .map(([dir, rows]) => ({ dir, files: rows }));
}

/** The path as a breadcrumb: its directories, then the file's own name. */
export function crumbs(path: string): { dirs: string[]; name: string } {
  const parts = path.split("/");
  return { dirs: parts.slice(0, -1), name: parts.at(-1) ?? path };
}

/** The file on show: the one the address names, else the first of the tree. */
export type ShownFile =
  | { kind: "file"; entry: ModelFileLastChange }
  | { kind: "absent"; path: string }
  | { kind: "none" };

/**
 * Which file to show. A file the address names that the version does not have
 * is `absent`, never replaced by another: the page says so. With no name, the
 * first file of the tree; with no file at all, `none`.
 */
export function shownFile(
  groups: readonly FileGroup[],
  named: string | null,
): ShownFile {
  if (named !== null) {
    const row = groups.flatMap((group) => group.files).find((candidate) =>
      candidate.entry.path === named
    );
    return row ? { kind: "file", entry: row.entry } : {
      kind: "absent",
      path: named,
    };
  }
  const first = groups[0]?.files[0];
  return first ? { kind: "file", entry: first.entry } : { kind: "none" };
}

/**
 * How many lines of a file are drawn. A line is a row of the page and the
 * page has no virtualization, so a file longer than this shows a window of it
 * and says so; the line an address points at is always inside the window.
 */
export const MAX_SHOWN_LINES = 2000;

export interface CodeLines {
  /** The lines drawn, in order; the line numbered `first` comes first. */
  lines: string[];
  /** The number of the first line drawn, counted from 1. */
  first: number;
  /** How many lines the file has. */
  total: number;
}

/** The lines of a text. A final line break ends the last line, it does not add one. */
export function textLines(text: string): string[] {
  const all = text === "" ? [] : text.split(/\r?\n/);
  if (all.length > 1 && all.at(-1) === "") all.pop();
  return all;
}

/**
 * The window of lines that is drawn. A window already on show (`kept`, the
 * number of its first line) stays where it is for as long as it holds the line
 * pointed at, or none is: the reader who clears a highlight, or highlights
 * another line of the window, does not see the text move. Otherwise the window
 * starts at the first line, unless the line pointed at lies beyond the cap,
 * when it is centred on that line.
 */
export function codeWindow(
  all: readonly string[],
  line: number | null = null,
  cap = MAX_SHOWN_LINES,
  kept?: number,
): CodeLines {
  const total = all.length;
  const lit = line !== null && line <= total ? line : null;
  const clamp = (first: number) =>
    Math.min(Math.max(1, first), Math.max(1, total - cap + 1));
  const holds = (first: number) =>
    lit === null || lit >= first && lit < first + cap;
  const first = kept !== undefined && holds(clamp(kept))
    ? clamp(kept)
    : lit !== null && lit > cap
    ? clamp(lit - Math.floor(cap / 2))
    : 1;
  return { lines: all.slice(first - 1, first - 1 + cap), first, total };
}

/** The lines of a text, or the window of them that is drawn (see `codeWindow`). */
export function codeLines(
  text: string,
  line: number | null = null,
  cap = MAX_SHOWN_LINES,
  kept?: number,
): CodeLines {
  return codeWindow(textLines(text), line, cap, kept);
}

/** The address of a file of the model; none of the three is written when unset. */
export function filesHref(
  { version, file, line }: {
    version?: string | null;
    file?: string | null;
    line?: number | null;
  } = {},
): string {
  return modelHref("files", {
    version: version || null,
    file: file || null,
    line: line ? String(line) : null,
  });
}

/** What the listing of a version holds, for the version the page asked for. */
export type FileListing =
  | { asked: string | undefined; status: "reading" }
  | {
    asked: string | undefined;
    status: "ready";
    /** The immutable commit the files belong to, whatever was asked. */
    version: string;
    files: readonly ModelFileLastChange[];
  }
  | { asked: string | undefined; status: "failed"; problem: FilesProblem };

/** The sources of one version, as far as they are read. */
export type SourcesState =
  | { status: "reading" }
  | { status: "ready"; sources: Readonly<Record<string, string>> }
  | { status: "failed"; problem: FilesProblem };

/** The text of the file on show, or why there is none yet. */
export type FileText =
  | { status: "reading" }
  | { status: "ready"; text: string }
  | { status: "failed"; problem: FilesProblem };

/**
 * One file out of the sources of its version. A path the host listed but did
 * not send is a problem of its own, never an empty file; `Object.hasOwn`
 * keeps a name such as `constructor` from reading what a text never held.
 */
export function fileText(
  state: SourcesState | undefined,
  path: string,
): FileText {
  if (!state || state.status === "reading") return { status: "reading" };
  if (state.status === "failed") return state;
  return Object.hasOwn(state.sources, path)
    ? { status: "ready", text: state.sources[path] }
    : { status: "failed", problem: filesProblem("file-unreadable") };
}

/** Sources can weigh up to 8 MiB a version: only the latest few stay at hand. */
const KEPT_SOURCES = 3;

export interface ModelFiles {
  /** The last listing asked for; `asked` says which version it answers. */
  readonly listing: ReadonlySignal<FileListing>;
  /** The sources of a version, once asked for. */
  sources(version: string): SourcesState | undefined;
  /**
   * Reads the files of `asked` (the head when absent). The same version read
   * again keeps what it showed until the answer; another one starts over, and
   * an answer that is no longer the latest asked is dropped.
   */
  open(asked?: string): Promise<void>;
  /**
   * The host announced that the admitted head is now `head`. A listing that
   * follows the head and does not hold that commit reads it, at its immutable
   * address (see `headReader`, which says what happens to a read already on its
   * way); a listing of a version a person named never moves, and one that
   * holds the head has nothing to read (unless its last read failed). The
   * sources of the head it replaces stay with the latest few (`KEPT_SOURCES`),
   * which a person may return to.
   */
  moved(head: string): Promise<void>;
  /** Reads the sources of an immutable version unless read or being read. */
  readSources(version: string): Promise<void>;
  /** Nothing is stored or sent after this. */
  dispose(): void;
}

export function createModelFiles(options: { api: FilesApi }): ModelFiles {
  const { api } = options;
  const listing = signal<FileListing>({
    asked: undefined,
    status: "reading",
  });
  const trees = signal<ReadonlyMap<string, SourcesState>>(new Map());
  const flights = new Map<string, Promise<void>>();
  let disposed = false;
  let current: AbortController | undefined;
  const lifetime = new AbortController();

  function setTree(version: string, state: SourcesState) {
    const next = new Map(trees.peek());
    next.delete(version);
    next.set(version, state);
    // Only the latest few that are read stay; one being read is never dropped.
    for (const [key, held] of next) {
      if (next.size <= KEPT_SOURCES) break;
      if (held.status === "ready") next.delete(key);
    }
    trees.value = next;
  }

  /** `at`: the commit to read for the head, when the host has named it. */
  async function load(asked?: string, at?: string): Promise<void> {
    if (disposed) return;
    current?.abort();
    const read = current = new AbortController();
    const held = listing.peek();
    if (held.asked !== asked || held.status !== "ready") {
      listing.value = { asked, status: "reading" };
    }
    try {
      const answer = await api.files(at ?? asked, read.signal);
      if (read.signal.aborted || disposed) return;
      listing.value = {
        asked,
        status: "ready",
        version: answer.version,
        files: answer.files,
      };
    } catch (failure) {
      if (read.signal.aborted || disposed) return;
      listing.value = {
        asked,
        status: "failed",
        problem: filesProblem(listingProblem(failure), failure),
      };
    }
  }

  function readSources(version: string): Promise<void> {
    if (disposed) return Promise.resolve();
    if (trees.peek().get(version)?.status === "ready") return Promise.resolve();
    const reading = flights.get(version);
    if (reading) return reading;
    setTree(version, { status: "reading" });
    const flight = (async () => {
      try {
        const tree = await api.sources(version, lifetime.signal);
        if (!disposed) {
          setTree(version, { status: "ready", sources: tree.sources });
        }
      } catch (failure) {
        if (!disposed) {
          setTree(version, {
            status: "failed",
            problem: filesProblem("sources-failed", failure),
          });
        }
      } finally {
        flights.delete(version);
      }
    })();
    flights.set(version, flight);
    return flight;
  }

  // A failed listing holds no version, so it is behind any head.
  const reader = headReader({
    held: () => {
      const held = listing.peek();
      return {
        asked: held.asked,
        version: held.status === "ready" ? held.version : undefined,
      };
    },
    read: load,
  });

  return {
    listing,
    sources: (version) => trees.value.get(version),
    open: reader.open,
    moved: reader.moved,
    readSources,
    dispose() {
      disposed = true;
      current?.abort();
      lifetime.abort();
    },
  };
}

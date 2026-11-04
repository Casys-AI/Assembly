import type { RequestSourceEditor } from "../../../lib/model/sources/request-edit.ts";
import type { VersionInfo } from "../../../lib/workbench/version-label.ts";
import type { RequestNames } from "../../system/useReleaseAgents.ts";
import type { SavedSystemSourceSelection } from "../../../../src/domain/work/records/saved-systems.ts";
import type { SavedSystemsApi } from "../../../lib/system/saved-systems.ts";
import type { AuthorRoster } from "../../../lib/model/revisions/authors.ts";
import { useEffect, useMemo } from "preact/hooks";
import {
  createModelFiles,
  fileGroups,
  type FileListing,
  fileText,
  type ModelFiles,
  shownFile,
} from "../../../lib/model/sources/files.ts";
import type { ModelLive } from "../../../lib/model/live.ts";
import {
  createRevisionApi,
  type RevisionLocation,
} from "../../../lib/model/revisions/api.ts";
import {
  fileOf,
  lineOf,
  versionOf,
} from "../../../lib/workbench/view-location.ts";
import { useModelLive } from "../../view/useModelLive.ts";

export interface FilesPageProps {
  versionInfo: VersionInfo;
  requestNames?: RequestNames;
  /** Releases reuse the exact displayed Files source reader. */
  releases?: boolean;
  /** Model/tool creation and global token reads stay read-only; explicit Release
   * retention uses its separate branch locator and server authority below. */
  caseReadOnly?: boolean;
  /** Dedicated source-only commands; immutable reader and Release guards stay separate. */
  sourceEditor?: RequestSourceEditor;
  requestExecutionVersion?: string;
  requestBaseVersion?: string;
  requestBranchVersion?: string;
  /** Displayed branch locator only; the server validates retention authority. */
  releaseBranch?: SavedSystemSourceSelection["branch"];
  releaseApi?: SavedSystemsApi;
  /** Who a Release's agents are, by name. */
  releaseRoster?: AuthorRoster;
  catalogueInvalidation?: number;
  catalogueConnection?: "connecting" | "live" | "reconnecting" | "closed";
  sessionGeneration?: number;
  /** The address: `?file=`, `?line=` and `?version=` say what is read. */
  location: Pick<RevisionLocation, "search">;
  /**
   * Changes when a decision anywhere moves the model: the head is read again.
   * A version named in the address never moves.
   */
  generation?: number;
  /** The files, when the caller owns them; the page reads its own otherwise. */
  files?: ModelFiles;
  /** The host's word on the model, when it moves; the tab's own when absent. */
  live?: ModelLive;
  /** For relative dates; the clock when absent. */
  now?: number;
}

/**
 * What the Files page lives on: the files of the version the address asks for
 * (the admitted head without one), read on mount and again when that version,
 * or the head, changes (a decision anywhere, or the host's word that the model
 * moved, which reads the new head at its own address); the text of the
 * version's sources, read once the page has a file to show; and the file the
 * address selects. Moving from one file to another of the same version reads
 * nothing. The page only draws what this returns.
 */
export function useFilesPage(props: FilesPageProps) {
  const search = new URLSearchParams(props.location.search);
  const address = { searchParams: search };
  const asked = versionOf(address) ?? undefined;
  const named = fileOf(address);
  const line = lineOf(address);
  const store = useMemo(
    () => props.files ?? createModelFiles({ api: createRevisionApi() }),
    [props.files],
  );
  useEffect(() => () => {
    if (!props.files) store.dispose();
  }, [store]);
  // The head moves with the decisions made anywhere; a version never does.
  const moves = asked === undefined ? props.generation : undefined;
  useEffect(() => {
    void store.open(asked);
  }, [store, asked, moves]);
  // A listing that holds the announced head reads nothing.
  useModelLive((head) => store.moved(head.version), props.live);

  // The files of another version are not drawn for the frame before the read
  // of this one starts: a listing answers the version it was asked for.
  const held = store.listing.value;
  const listing: FileListing = held.asked === asked
    ? held
    : { asked, status: "reading" };
  const groups = listing.status === "ready" ? fileGroups(listing.files) : [];
  const shown = listing.status === "ready" ? shownFile(groups, named) : null;
  const version = listing.status === "ready" ? listing.version : undefined;
  const reading = shown?.kind === "file" ? version : undefined;
  useEffect(() => {
    if (reading) void store.readSources(reading);
  }, [store, reading]);
  const text = shown?.kind === "file" && version
    ? fileText(store.sources(version), shown.entry.path)
    : undefined;

  return { store, asked, named, line, listing, groups, shown, version, text };
}

import { useEffect, useMemo } from "preact/hooks";
import type { SystemPage } from "../../../lib/workbench/desk.ts";
import {
  createMatrixApi,
  type MatrixApi,
} from "../../../lib/system/rights/api.ts";
import {
  createMatrixStore,
  type MatrixState,
  type MatrixStore,
} from "../../../lib/system/rights/store.ts";

/**
 * The pages that draw the authority matrix. Its projection is slow the first
 * time a commit is asked for, so no other page waits for it.
 */
export const MATRIX_PAGES: readonly SystemPage[] = ["rights"];

export interface MatrixProps {
  /** The matrix, when the caller owns it; the place reads its own otherwise. */
  matrix?: MatrixStore;
  /** What the place's own matrix reads from; the host's route when absent. */
  api?: Pick<MatrixApi, "read">;
  /** The page shown. */
  page: SystemPage;
  /**
   * The board as it was read for the address, or none while it is not: the
   * matrix is of the commit the board describes, so both tell the same version.
   */
  board: { version?: string } | undefined;
}

/**
 * The authority matrix the System place lives on, for the pages that draw it
 * (`MATRIX_PAGES`): read when such a page opens on a version of the model, and
 * again when that version changes. A commit never changes, so nothing else
 * reads it again. It is always asked at the board's commit, a named version,
 * so it does not follow the host's word on the model by itself (`moved` leaves
 * a named version where it is): the board does (see `useBoard`), and the new
 * commit it reads is the version this reads next. The place's own matrix is
 * closed with it; one handed in is the caller's. `read` is what the store
 * holds of the board's commit, never of another: none until it is asked for.
 */
export function useMatrix(
  props: MatrixProps,
): { store: MatrixStore; read: MatrixState | undefined } {
  const store = useMemo(
    () =>
      props.matrix ??
        createMatrixStore({ api: props.api ?? createMatrixApi() }),
    [props.matrix],
  );
  useEffect(() => () => {
    if (!props.matrix) store.dispose();
  }, [store]);
  const version = props.board?.version;
  const wanted = MATRIX_PAGES.includes(props.page);
  useEffect(() => {
    if (wanted && version) void store.open(version);
  }, [store, wanted, version]);
  const held = store.state.value;
  return {
    store,
    read: version !== undefined && held.asked === version ? held : undefined,
  };
}

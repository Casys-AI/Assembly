import {
  type AuthorityMatrix,
  type MatrixApi,
  type MatrixProblem,
  matrixProblem,
} from "./api.ts";
import {
  createVersionedStore,
  type VersionedState,
  type VersionedStore,
} from "../../model/versioned-store.ts";

/**
 * What the System pages hold of the authority matrix: the one they are drawn
 * from, the commit it describes, whether it is being read, and why the last
 * read failed (see `VersionedState`). The matrix is asked for the commit the
 * board describes, so the two never tell different versions.
 */
export type MatrixState = VersionedState<
  "matrix",
  AuthorityMatrix,
  MatrixProblem
>;

export type MatrixStore = VersionedStore<
  "matrix",
  AuthorityMatrix,
  MatrixProblem
>;

export function createMatrixStore(options: {
  api: Pick<MatrixApi, "read">;
}): MatrixStore {
  return createVersionedStore({
    key: "matrix",
    read: async (asked, signal) => {
      const { matrix, version } = await options.api.read(asked, signal);
      return { value: matrix, version };
    },
    same: (kept, answer) =>
      kept.digest !== undefined && kept.digest === answer.digest,
    problem: matrixProblem,
  });
}

import { useEffect, useRef, useState } from "preact/hooks";
import { caseModelFetch } from "../../../lib/case-model-scope.ts";
import {
  type AuthorityMatrix,
  createMatrixApi,
} from "../../../lib/system/rights/api.ts";
import type { SystemPage } from "../../../lib/workbench/desk.ts";

/** What a Case's rights are read from: its own facade, at an exact version. */
export interface BranchMatrixReader {
  read(
    caseId: string,
    version: string,
    signal: AbortSignal,
  ): Promise<AuthorityMatrix>;
}

export const caseMatrixReader: BranchMatrixReader = {
  async read(caseId, version, signal) {
    const api = createMatrixApi({ fetch: caseModelFetch(caseId) });
    return (await api.read(version, signal)).matrix;
  },
};

/** How long one matrix may take before its line says it could not be read. */
export const BRANCH_MATRIX_TIMEOUT_MS = 30_000;

/** A Case and the exact version it runs, once its scope is known. */
export interface BranchVersion {
  caseId: string;
  version?: string;
}

/** One Case's matrix as read: none yet, the matrix of a version, or a failure. */
export type BranchMatrix =
  | { status: "reading"; version: string }
  | { status: "read"; version: string; matrix: AuthorityMatrix }
  | { status: "failed"; version: string };

/**
 * On Rights, the matrix each of these Cases runs, read again whenever the
 * version a Case runs changes (its scope follows its adoptions), and only
 * then; nothing on the other pages. The server projects one matrix at a time
 * behind a short queue, so the Cases are read in turn, each shown as soon as it
 * is read; a line keeps what it shows while its next version is read, and a
 * read that takes longer than `timeoutMs` fails without holding the others.
 */
export function useBranchRights(
  page: SystemPage,
  branches: readonly BranchVersion[],
  reader: BranchMatrixReader = caseMatrixReader,
  timeoutMs = BRANCH_MATRIX_TIMEOUT_MS,
): ReadonlyMap<string, BranchMatrix> {
  const [held, setHeld] = useState<ReadonlyMap<string, BranchMatrix>>(
    new Map(),
  );
  const shown = useRef(held);
  shown.current = held;
  const key = branches
    .map(({ caseId, version }) => `${caseId}@${version ?? ""}`)
    .join(",");
  useEffect(() => {
    if (page !== "rights") return;
    // What to read: a known version this page does not show yet. A Case whose
    // scope is being read keeps what its line shows meanwhile.
    const due = branches.flatMap(({ caseId, version }) => {
      const now = shown.current.get(caseId);
      return version &&
          !(now && now.status !== "reading" && now.version === version)
        ? [{ caseId, version }]
        : [];
    });
    if (due.length === 0) return;
    const stop = new AbortController();
    const settle = (caseId: string, value: BranchMatrix) => {
      if (!stop.signal.aborted) {
        setHeld((was) => new Map(was).set(caseId, value));
      }
    };
    setHeld((was) => {
      const next = new Map(was);
      for (const { caseId, version } of due) {
        if (next.get(caseId)?.status !== "read") {
          next.set(caseId, { status: "reading", version });
        }
      }
      return next;
    });
    void (async () => {
      for (const { caseId, version } of due) {
        if (stop.signal.aborted) return;
        try {
          const matrix = await reader.read(
            caseId,
            version,
            AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
          );
          settle(caseId, { status: "read", version, matrix });
        } catch {
          settle(caseId, { status: "failed", version });
        }
      }
    })();
    return () => stop.abort();
  }, [page, key, reader, timeoutMs]);
  return held;
}

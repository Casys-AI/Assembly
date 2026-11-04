import { useEffect, useState } from "preact/hooks";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import { caseModelFetch } from "../../lib/case-model-scope.ts";
import {
  branchOperatorName,
  GENERIC_BRANCH_NAME,
} from "../../lib/cases/operator-names.ts";
import { createBoardApi } from "../../lib/system/board/api.ts";
import { agentsByOperator } from "../../lib/system/team/projection.ts";
import type { SavedSystemView } from "../../lib/system/saved-systems.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";

export type RequestNames = Pick<
  WorkbenchState["requests"]["cases"],
  "byId" | "ensure"
>;

/** One exact board read for the selected Release, independent of conversations. */
export function useReleaseAgents(
  record: SavedSystemView,
  requests?: RequestNames,
  sessionGeneration = 0,
  refresh = 0,
) {
  const source = record.source;
  const caseId = source?.branch.kind === "case"
    ? source.branch.caseId
    : undefined;
  const request = requests?.byId(caseId);
  const key = JSON.stringify([source, sessionGeneration, refresh]);
  const [read, setRead] = useState<{ key: string; board?: ModelBoard }>();
  useEffect(() => {
    if (caseId && requests) void requests.ensure(caseId);
  }, [caseId, requests, sessionGeneration, refresh]);
  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    const api = createBoardApi({
      fetch: caseId ? caseModelFetch(caseId) : undefined,
    });
    api.read(source.sourceVersion, abort.signal).then(({ board }) => {
      if (!abort.signal.aborted) setRead({ key, board });
    }, () => {
      if (!abort.signal.aborted) setRead({ key });
    });
    return () => abort.abort();
  }, [key]);
  const board = read?.key === key ? read.board : undefined;
  return {
    status: !source || read?.key === key
      ? board ? "ready" : "unavailable"
      : "reading",
    names: board
      ? new Map(
        [...agentsByOperator(
          board,
          [],
          request?.owner,
          request ? branchOperatorName(request) : undefined,
        )].filter(([, agent]) =>
          agent.nameSource !== "unit" &&
          !(caseId &&
            ["Main Operator", GENERIC_BRANCH_NAME].includes(agent.name))
        ).map(([id, agent]) => [id, agent.name]),
      )
      : new Map<string, string>(),
  };
}

import type { SystemRuntimeState } from "../../../src/domain/work/dialogue.ts";
import type {
  AgentMessageCommand,
  ConversationsSnapshot,
  OperatorToolsSnapshot,
} from "../../../src/domain/work/records/conversations.ts";
import { parseConversationsSnapshot } from "../conversations/state.ts";
import {
  type OperatorToolDecision,
  parseOperatorToolsSnapshot,
} from "../system/tools/decisions.ts";
import type {
  ProjectionSnapshot,
  StateRevision,
} from "../../../src/domain/work/history.ts";

export type HistoryEntry = Omit<
  StateRevision,
  "systemId" | "eventCount" | "model"
>;
export interface HistoryResponse {
  currentRevision: number;
  revisions: HistoryEntry[];
}
export interface HistoricalResponse {
  state: SystemRuntimeState;
  projection: ProjectionSnapshot | null;
}
export type Verdict = "approve" | "refuse";
export type DecisionCommand = {
  kind: "candidate";
  candidateId: string;
  candidateDigest: string;
  expectedRevision: number;
  verdict: Verdict;
  reason: string;
} | {
  kind: "change";
  changeId: string;
  expectedRevision: number;
  verdict: Verdict;
};
export interface CaseChangeStatus {
  caseId: string;
  changeId: string;
  status:
    | "pending"
    | "decision-recorded"
    | "publication-pending"
    | "published-awaiting-adoption"
    | "adopted"
    | "refused-awaiting-continuation"
    | "refused"
    | "blocked";
  canResume: boolean;
}
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Same-origin transport. Writes are performed once, only on an explicit action. */
export function createWorkbenchApi(
  fetcher: Fetcher = (path, init) => fetch(path, init),
) {
  async function readJSON<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(path, init);
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body &&
          typeof body.error === "string"
        ? body.error
        : `Action not possible (${response.status}).`;
      throw new Error(message);
    }
    return body as T;
  }
  const post = (path: string, body: unknown) =>
    readJSON<{ accepted: boolean }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    readState: () =>
      readJSON<SystemRuntimeState>("/api/state", { cache: "no-store" }),
    readHistory: () =>
      readJSON<HistoryResponse>("/api/history", { cache: "no-store" }),
    readRevision: (revision: number) => {
      if (!Number.isSafeInteger(revision) || revision < 0) {
        return Promise.reject(new Error("Invalid revision."));
      }
      return readJSON<HistoricalResponse>(`/api/history/${revision}`, {
        cache: "no-store",
      });
    },
    sendMessage: (text: string, caseId?: string | null) =>
      post("/api/messages", {
        text,
        ...(typeof caseId === "string"
          ? { caseId }
          : caseId === null
          ? { newConversation: true }
          : {}),
      }),
    readConversations: async (): Promise<ConversationsSnapshot | null> => {
      const response = await fetcher("/api/conversations", {
        cache: "no-store",
      });
      // Older instances can keep the original conversation while they upgrade.
      if (response.status === 404) return null;
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body && typeof body === "object" && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Conversations unavailable (${response.status}).`,
        );
      }
      return parseConversationsSnapshot(body);
    },
    sendAgentMessage: (command: AgentMessageCommand) =>
      post(
        `/api/conversations/${encodeURIComponent(command.agentId)}/messages`,
        {
          text: command.text,
          expectedRevision: command.expectedRevision,
          // A named Case continues that Request; otherwise a new one opens.
          ...(command.caseId ? { caseId: command.caseId } : {}),
          ...(command.newConversation ? { newConversation: true } : {}),
        },
      ),
    readOperatorTools: async (): Promise<OperatorToolsSnapshot | null> => {
      const response = await fetcher("/api/operator-tools", {
        cache: "no-store",
      });
      if (response.status === 404) return null;
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body && typeof body === "object" && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Catalogue unavailable (${response.status}).`,
        );
      }
      return parseOperatorToolsSnapshot(body);
    },
    decideOperatorTool: (command: OperatorToolDecision) =>
      post(
        `/api/conversations/${encodeURIComponent(command.agentId)}/decisions`,
        {
          candidateId: command.candidateId,
          candidateDigest: command.candidateDigest,
          expectedRevision: command.expectedRevision,
          verdict: command.verdict,
          reason: command.reason,
        },
      ),
    decideOperatorChange: (command: {
      agentId: string;
      changeId: string;
      expectedRevision: number;
      configurationRevision: number;
      verdict: Verdict;
      caseId?: string;
    }) =>
      readJSON<
        {
          accepted?: boolean;
          status?:
            | "refused-awaiting-continuation"
            | "refused"
            | "published-awaiting-adoption"
            | "adopted"
            | "blocked";
          caseId?: string;
          changeId?: string;
        }
      >(
        `/api/conversations/${encodeURIComponent(command.agentId)}/changes/${
          encodeURIComponent(command.changeId)
        }/decision${command.caseId ? "?space=requests" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(command.caseId ? { caseId: command.caseId } : {}),
            expectedRevision: command.expectedRevision,
            configurationRevision: command.configurationRevision,
            verdict: command.verdict,
          }),
        },
      ),
    readCaseChangeStatus: (agentId: string, changeId: string, caseId: string) =>
      readJSON<CaseChangeStatus>(
        `/api/conversations/${encodeURIComponent(agentId)}/changes/${
          encodeURIComponent(changeId)
        }/decision?${new URLSearchParams({ space: "requests", caseId })}`,
        { cache: "no-store", credentials: "same-origin" },
      ),
    resumeCaseChange: (agentId: string, changeId: string, caseId: string) =>
      readJSON<CaseChangeStatus>(
        `/api/conversations/${encodeURIComponent(agentId)}/changes/${
          encodeURIComponent(changeId)
        }/decision/resume?space=requests`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseId }),
        },
      ),
    decide: (command: DecisionCommand) => post("/api/decisions", command),
  };
}
type CompleteWorkbenchApi = ReturnType<typeof createWorkbenchApi>;
type OptionalApi =
  | "readConversations"
  | "sendAgentMessage"
  | "readOperatorTools"
  | "decideOperatorTool"
  | "decideOperatorChange"
  | "readCaseChangeStatus"
  | "resumeCaseChange";
export type WorkbenchApi =
  & Omit<CompleteWorkbenchApi, OptionalApi>
  & Partial<
    Pick<CompleteWorkbenchApi, OptionalApi>
  >;

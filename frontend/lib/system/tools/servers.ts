import type { OperatorToolsSnapshot } from "../../../../src/domain/work/records/conversations.ts";
import type { Candidate } from "../../../../src/domain/work/candidates.ts";
import type { ModelContextTool } from "../../../../src/domain/model/consultation/context.ts";

/** One tool under its server: a short name, and its stage while not active. */
export interface ServerTool {
  id: string;
  name: string;
  description: string;
  /** Absent once the tool is usable. */
  stage?: Candidate["stage"];
  kind: "candidate" | "model";
}

/** Tools sharing a provider, shown as one row that opens on its tools. */
export interface ToolServer {
  name: string;
  tools: ServerTool[];
}

/** `model.search` → `model` and `search`; an id without a dot is its own server. */
function split(id: string): [string, string] {
  const at = id.indexOf(".");
  return at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, id];
}

/** Web page readers the agent wrote share one `web` server. */
function candidateServer(candidate: Candidate): string {
  return candidate.kind.startsWith("read_web_page") ? "web" : candidate.kind;
}

/**
 * Groups an agent's tools by server, the way an MCP client lists them: the
 * agent's own tools first, then the model consultations; servers and tools keep
 * the order they arrive in.
 */
export function toolServers(
  candidates: readonly Candidate[],
  modelTools: readonly ModelContextTool[],
): ToolServer[] {
  const servers = new Map<string, ServerTool[]>();
  const add = (server: string, tool: ServerTool) =>
    servers.set(server, [...(servers.get(server) ?? []), tool]);
  for (const candidate of candidates) {
    add(candidateServer(candidate), {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      kind: "candidate",
      ...(candidate.stage === "active" ? {} : { stage: candidate.stage }),
    });
  }
  for (const tool of modelTools) {
    const [server, name] = split(tool.id);
    add(server, {
      id: tool.id,
      name,
      description: tool.description,
      kind: "model",
    });
  }
  return [...servers].map(([name, tools]) => ({ name, tools }));
}

/** What counts as a tool of an operator: a refused or a failed candidate is not one. */
export const usableCandidates = (
  candidates: readonly Candidate[],
): Candidate[] =>
  candidates.filter((candidate) =>
    candidate.stage !== "refused" && candidate.stage !== "failed"
  );

/**
 * The tools the runtime reports for some operators (`agentId`, which is the
 * `nativeId` the model's operator is joined by): what they wrote and what
 * they consult. The one place that says which of the catalogue's entries are
 * an operator's tools; no catalogue, no tool.
 */
export function operatorTools(
  catalogue: Pick<OperatorToolsSnapshot, "tools" | "modelTools"> | null,
  agentIds: readonly string[],
): { candidates: Candidate[]; modelTools: ModelContextTool[] } {
  const mine = <Entry extends { agentId: string }>(entry: Entry) =>
    agentIds.includes(entry.agentId);
  return {
    candidates: usableCandidates(
      catalogue?.tools.filter(mine).map((entry) => entry.candidate) ?? [],
    ),
    modelTools: (catalogue?.modelTools ?? []).filter(mine).map((entry) =>
      entry.tool
    ),
  };
}

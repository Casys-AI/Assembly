import { deepStrictEqual } from "node:assert/strict";
import type { Candidate } from "../../../../src/domain/work/records/candidates.ts";
import { type ModelContextTool } from "../../../../src/application/work/context/model-tools.ts";
import { operatorTools, toolServers } from "./servers.ts";

const candidate = (
  id: string,
  stage: Candidate["stage"],
  kind = "read_web_page",
) => ({ id, name: id, description: `${id} reads`, kind, stage } as Candidate);
const model = (operation: string) =>
  ({
    id: `model.${operation}`,
    name: `Long ${operation}`,
    description: `${operation} the model`,
    operation,
  }) as ModelContextTool;

Deno.test("tools group by server: the agent's own first, model consultations by their id prefix", () => {
  const servers = toolServers(
    [candidate("offers", "active"), candidate("outline", "reviewing")],
    [model("search"), model("inspect")],
  );
  deepStrictEqual(servers.map((server) => server.name), ["web", "model"]);
  deepStrictEqual(servers[1].tools.map((tool) => tool.name), [
    "search",
    "inspect",
  ]);
  // A usable tool has no stage; a candidate keeps the one it is at.
  deepStrictEqual(servers[0].tools.map((tool) => tool.stage), [
    undefined,
    "reviewing",
  ]);
});

Deno.test("an unknown kind or an id without a dot is its own server", () => {
  const servers = toolServers(
    [candidate("mailer", "proposed", "send_mail")],
    [{ ...model("query"), id: "query" }],
  );
  deepStrictEqual(
    servers.map((server) => [server.name, server.tools[0].name]),
    [
      ["send_mail", "mailer"],
      ["query", "query"],
    ],
  );
});

Deno.test("no tool, no server", () => {
  deepStrictEqual(toolServers([], []), []);
});

Deno.test("an operator's tools are the catalogue's entries for it, without the refused and the failed", () => {
  const catalogue = {
    tools: [
      ["a", candidate("one", "active")],
      ["a", candidate("two", "refused")],
      ["a", candidate("three", "failed")],
      ["a", candidate("four", "awaiting-admission")],
      ["b", candidate("other", "active")],
    ].map(([agentId, entry]) => ({
      agentId: agentId as string,
      agentName: agentId as string,
      revision: 1,
      candidate: entry as Candidate,
    })),
    modelTools: [
      { agentId: "a", agentName: "a", tool: model("search") },
      { agentId: "b", agentName: "b", tool: model("inspect") },
    ],
  };
  const mine = operatorTools(catalogue, ["a"]);
  deepStrictEqual(mine.candidates.map((entry) => entry.id), ["one", "four"]);
  deepStrictEqual(mine.modelTools.map((tool) => tool.id), ["model.search"]);
  // Several operators of one agent of the model: theirs together, in catalogue order.
  const both = operatorTools(catalogue, ["b", "a"]);
  deepStrictEqual(both.candidates.map((entry) => entry.id), [
    "one",
    "four",
    "other",
  ]);
  deepStrictEqual(both.modelTools.map((tool) => tool.id), [
    "model.search",
    "model.inspect",
  ]);
  // Nobody asked, nobody known, nothing reported: no tool.
  deepStrictEqual(operatorTools(catalogue, []), {
    candidates: [],
    modelTools: [],
  });
  deepStrictEqual(operatorTools(catalogue, ["ghost"]), {
    candidates: [],
    modelTools: [],
  });
  deepStrictEqual(operatorTools(null, ["a"]), {
    candidates: [],
    modelTools: [],
  });
  deepStrictEqual(
    operatorTools({ tools: catalogue.tools.slice(0, 1) }, ["a"]).modelTools,
    [],
  );
});

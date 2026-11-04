import { deepStrictEqual, equal } from "node:assert/strict";
import type { SavedSystemCapture } from "../../../domain/work/records/saved-systems.ts";
import { savedSystemView } from "./release-view.ts";

const capture: SavedSystemCapture = {
  origin: { projectId: "p", systemId: "s", executionSpaceId: "main" },
  registeredOperatorIds: ["b", "a"],
  operators: [],
  prerequisites: [],
};

Deno.test("public saved system views omit tool bodies", () => {
  const op = {
    operatorId: "a",
    stateRevision: 2,
    modelDigest: "digest",
    repositoryVersion: "commit:pin",
    settingsDigest: "settings",
    tools: [{
      candidateId: "tool",
      digest: "tool-digest",
      draft: {
        name: "Tool",
        description: "Public source",
        kind: "read_web_page" as const,
        code: "private-free exact source",
      },
    }],
  };
  const selected = {
    ...capture,
    operators: [op],
    admission: { operatorIds: ["a"], prerequisites: [] },
  };
  const view = savedSystemView({
    id: "id",
    saveKey: "key",
    commandDigest: "command",
    metadata: { name: "Name", purpose: "" },
    capture: selected,
    createdAt: "now",
    status: "pending",
    manifest: null,
    digest: null,
    issues: [],
    revision: 0,
  });
  equal(JSON.stringify(view).includes("private-free exact source"), false);
  equal("capture" in view, false);
  equal("commandDigest" in view, false);
  deepStrictEqual(view.selectedOperators[0].tools, [{
    candidateId: "tool",
    digest: "tool-digest",
  }]);
});

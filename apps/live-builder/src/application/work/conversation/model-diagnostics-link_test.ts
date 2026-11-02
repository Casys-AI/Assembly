import { deepStrictEqual, equal } from "node:assert/strict";
import {
  modelDiagnosticsView,
  withModelDiagnosticsView,
} from "./model-diagnostics-link.ts";

const version = `commit:${"a".repeat(40)}`;
const executionVersion = `commit:${"b".repeat(40)}`;
Deno.test("Diagnostics links preserve exact consulted source and Request identity", () => {
  for (const caseId of [undefined, "request_123"]) {
    const view = modelDiagnosticsView(version, caseId);
    equal(view?.version, version);
    const address = new URL(view!.href, "http://local");
    equal(address.pathname, "/system");
    deepStrictEqual([...address.searchParams], [
      ["page", "diagnostics"],
      ["version", version],
      ...(caseId ? [["caseBranch", caseId]] : []),
    ]);
    const original = {
      modelVersion: { repositoryVersion: executionVersion },
      result: { version, items: [] },
    };
    deepStrictEqual(withModelDiagnosticsView(original, version, caseId), {
      ...original,
      modelDiagnosticsView: view,
    });
    equal(Object.hasOwn(original, "modelDiagnosticsView"), false);
  }
});
Deno.test("Diagnostics never invents a head link from unknown or mismatched evidence", () => {
  for (
    const candidate of [
      undefined,
      "",
      "branch:main",
      "commit:short",
      executionVersion.toUpperCase(),
    ]
  ) {
    equal(modelDiagnosticsView(candidate), undefined);
  }
  for (const caseId of ["", "foreign&caseBranch=main", "../main"]) {
    equal(modelDiagnosticsView(version, caseId), undefined);
  }
  for (
    const result of [
      null,
      [],
      { modelVersion: { repositoryVersion: version } },
      { result: { version: executionVersion } },
      { result: { version: "branch:main" } },
    ]
  ) {
    equal(withModelDiagnosticsView(result, version, "request_123"), result);
  }
});

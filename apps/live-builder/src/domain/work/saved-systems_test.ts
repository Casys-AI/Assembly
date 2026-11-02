import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  assertSavedCapture,
  assertSavedSourceSelection,
  assertSaveKey,
  savedManifest,
  type SavedSystemCapture,
  savedSystemDigest,
  savedSystemMetadata,
  savedSystemView,
} from "./saved-systems.ts";
const capture: SavedSystemCapture = {
  origin: { projectId: "p", systemId: "s", executionSpaceId: "main" },
  registeredOperatorIds: ["b", "a"],
  operators: [],
  prerequisites: [],
};
Deno.test("saved system metadata is separate, bounded and canonical", async () => {
  deepStrictEqual(
    savedSystemMetadata({ name: "  A  ", purpose: "  Useful  " }),
    { name: "A", purpose: "Useful" },
  );
  for (const name of ["", " ", "a".repeat(121), "bad\0name"]) {
    throws(() => savedSystemMetadata({ name, purpose: "" }));
  }
  throws(() => savedSystemMetadata({ name: "A", purpose: "a".repeat(2001) }));
  throws(() => assertSaveKey("../other"));
  assertSaveKey("retry_key-123");
  const first = savedManifest({ ...capture, operators: [] });
  const second = savedManifest({
    ...capture,
    operators: [],
    registeredOperatorIds: ["a", "b"],
  });
  equal(await savedSystemDigest(first), await savedSystemDigest(second));
  deepStrictEqual(capture.registeredOperatorIds, ["b", "a"]);
});
Deno.test("saved capture rejects duplicate/mixed operators and public views omit tool bodies", () => {
  throws(() =>
    assertSavedCapture({ ...capture, registeredOperatorIds: ["a", "a"] })
  );
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
  assertSavedCapture(selected);
  throws(() => assertSavedCapture({ ...selected, operators: [op, op] }));
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

Deno.test("Release selection binds one exact version to a host-owned branch and preserves legacy records", async () => {
  const version = `commit:${"a".repeat(40)}`;
  assertSavedSourceSelection({
    branch: { kind: "main" },
    sourceVersion: version,
  });
  assertSavedSourceSelection({
    branch: { kind: "case", caseId: "case-a" },
    sourceVersion: version,
  });
  for (
    const source of [
      undefined,
      {},
      { branch: { kind: "main" }, sourceVersion: "HEAD" },
      {
        branch: { kind: "main", ref: "refs/proposals/fake" },
        sourceVersion: version,
      },
      { branch: { kind: "case", caseId: "../other" }, sourceVersion: version },
      { branch: { kind: "main" }, sourceVersion: version, actorId: "owner" },
    ]
  ) throws(() => assertSavedSourceSelection(source));
  const legacy = savedManifest({ ...capture, operators: [] });
  equal("source" in legacy, false);
  const source = {
    branch: { kind: "main" as const },
    sourceVersion: version,
    repositoryId: "repository",
    branchRef: "refs/heads/admitted",
    admittedHeadVersion: version,
    sourceDigest: "source",
  };
  const selected = savedManifest({ ...capture, source, operators: [] });
  equal(selected.source!.sourceVersion, version);
  equal(
    await savedSystemDigest(legacy) === await savedSystemDigest(selected),
    false,
  );
  throws(() =>
    assertSavedCapture({
      ...capture,
      source,
      operators: [{
        operatorId: "a",
        stateRevision: 0,
        modelDigest: "model",
        settingsDigest: "settings",
        repositoryVersion: `commit:${"b".repeat(40)}`,
        tools: [],
      }],
    })
  );
});

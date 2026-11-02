import { equal, notEqual, rejects, throws } from "node:assert/strict";
import type { PendingChange } from "./pending-change.ts";
import {
  assertRequestNetworkChange,
  requestNetworkProposalDigest,
} from "./request-network-change.ts";

function proposal(): PendingChange {
  return {
    id: "change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "operator",
    caseId: "case-a",
    baseRevision: 1,
    baseModelDigest: "a".repeat(64),
    reason: "Read the requested host",
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
    diff: {
      title: "Read the requested host",
      author: "operator",
      base: {
        repositoryVersion: `commit:${"a".repeat(40)}`,
        modelDigest: "a".repeat(64),
        sourceDigest: "b".repeat(64),
      },
      sourceDigest: "c".repeat(64),
      files: [{
        path: "model.sysml",
        kind: "changed",
        additions: 1,
        deletions: 1,
      }],
      patch: "exact compiled diff",
      additions: 1,
      deletions: 1,
    },
  };
}
Deno.test("a Case network proposal identity survives decision/publication, but changes with exact intent or preview", async () => {
  const original = proposal(),
    digest = await requestNetworkProposalDigest(original);
  const decided = {
    ...original,
    status: "approved" as const,
    authority: "human" as const,
    decidedAt: "2026-10-30T00:01:00.000Z",
    publishedCommit: `commit:${"d".repeat(40)}`,
  };
  equal(await requestNetworkProposalDigest(decided), digest);
  for (
    const changed of [
      { ...original, caseId: "case-b" },
      { ...original, requestedBy: "other" },
      {
        ...original,
        requestedRights: { addNetworkHosts: ["other.example.org"] },
      },
      {
        ...original,
        diff: { ...original.diff!, patch: "different exact diff" },
      },
      { ...original, reason: "Another request" },
      { ...original, baseRevision: 2 },
    ]
  ) notEqual(await requestNetworkProposalDigest(changed), digest);
  const extra = { ...original, unexpected: true };
  throws(() => assertRequestNetworkChange(extra));
  const previewExtra = {
    ...original,
    diff: { ...original.diff!, unexpected: true },
  };
  await rejects(() => requestNetworkProposalDigest(previewExtra));
  const missing = proposal();
  delete missing.diff;
  await rejects(() => requestNetworkProposalDigest(missing));
  throws(() =>
    assertRequestNetworkChange({ ...original, designerScopeId: "main" })
  );
  throws(() =>
    assertRequestNetworkChange({
      ...original,
      requestedRights: { setUrlSelectionMode: "authorized-host" },
    })
  );
  throws(() =>
    assertRequestNetworkChange({
      ...original,
      requestedRights: { addNetworkHosts: ["https://example.org/path"] },
    })
  );
});

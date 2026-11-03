import { deepStrictEqual, equal, notEqual, rejects } from "node:assert/strict";
import { publishedArtifact } from "../../../test/support/tool-artifact-fixture.ts";
import { requestOpeningBase } from "../../../test/support/request-space-fixture.ts";
import {
  retainedToolAdmissionId,
  retainedToolDescriptors,
  retainedToolResourceId,
} from "./retained-tool-dependencies.ts";

Deno.test("retained dependency identities bind the exact Case admission and bytes without changing their origin", async () => {
  const artifact = await publishedArtifact(), base = await requestOpeningBase();
  base.requestOwner.operatorId = artifact.agentId;
  base.manifest.operators[0].operatorId = artifact.agentId;
  base.manifest.operators[0].tools = [{
    candidateId: artifact.candidate.id,
    digest: artifact.candidate.digest,
    sourceBinding: artifact.candidate.sourceBinding,
  }];
  const opening = {
    scope: { projectId: "host", systemId: "system" },
    id: "opening",
    caseId: "case-a",
    executionSpaceId: "space-a",
    base,
    baseDigest: "a".repeat(64),
  };
  const before = structuredClone(opening);
  const admission = await retainedToolAdmissionId(opening.scope, opening.id);
  equal(await retainedToolAdmissionId(opening.scope, opening.id), admission);
  const [descriptor] = retainedToolDescriptors(opening, admission);
  const resource = await retainedToolResourceId(descriptor);
  equal(resource, await retainedToolResourceId(structuredClone(descriptor)));
  for (
    const key of [
      "caseId",
      "executionSpaceId",
      "operatorId",
      "openingId",
      "admissionId",
      "projectId",
      "systemId",
    ] as const
  ) {
    const other = {
      ...structuredClone(descriptor),
      target: { ...descriptor.target, [key]: `other-${key}` },
    };
    if (key === "operatorId") {
      await rejects(() => retainedToolResourceId(other));
    } else notEqual(await retainedToolResourceId(other), resource);
  }
  notEqual(
    await retainedToolAdmissionId(opening.scope, "other-opening"),
    admission,
  );
  await rejects(() =>
    retainedToolResourceId({
      ...descriptor,
      tool: { ...descriptor.tool, digest: "b".repeat(64) },
    })
  );
  const extra = { ...descriptor, extra: true };
  await rejects(() => retainedToolResourceId(extra));
  deepStrictEqual(opening, before);
});

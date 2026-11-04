import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  publishedToolDraft,
  requireToolReuseAdmission,
  toolDraftDigest,
  toolReuseReceipt,
} from "./catalog.ts";
import { draftDigest } from "../runtime/values.ts";
import {
  artifactModel,
  publishedArtifact,
  reuseBehavior,
} from "../../../../test/support/tool-artifact-fixture.ts";

Deno.test("shared artifact encoding retains the historical draft digest and exports only draft bytes", async () => {
  const artifact = await publishedArtifact();
  const draft = await publishedToolDraft(artifact);
  const expected = createHash("sha256").update(JSON.stringify({
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    code: draft.code,
  })).digest("hex");
  equal(await draftDigest(draft), expected);
  equal(await toolDraftDigest(draft), expected);
  deepStrictEqual(Object.keys(draft).sort(), [
    "code",
    "description",
    "kind",
    "name",
  ]);
  equal("admission" in draft, false);
  equal("binding" in draft, false);
});

Deno.test("persisted Candidate.caseId stays outside the historical tool draft digest and published bytes", async () => {
  const artifact = await publishedArtifact();
  const original = await publishedToolDraft(artifact);
  const digest = await toolDraftDigest(artifact.candidate);
  for (const caseId of ["migrated-dossier:case:2", "another:case:37"]) {
    artifact.candidate.caseId = caseId;
    equal(await toolDraftDigest(artifact.candidate), digest);
    equal(await draftDigest(artifact.candidate), digest);
    deepStrictEqual(await publishedToolDraft(artifact), original);
  }
  delete artifact.candidate.caseId;
  equal(await toolDraftDigest(artifact.candidate), digest);
  deepStrictEqual(await publishedToolDraft(artifact), original);
});

Deno.test("publication requires exact active native occurrence and recorded local admission", async () => {
  for (
    const mutate of [
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        delete artifact.candidate.sourceBinding,
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.candidate.sourceBinding!.ownerId = "another-operator",
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.candidate.stage = "failed" as never,
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.model.catalog[0]!.status = "refused",
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.candidate.admission!.candidateDigest = "another-digest",
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.agentId = "another-operator",
      (artifact: Awaited<ReturnType<typeof publishedArtifact>>) =>
        artifact.model.catalog[0]!.contractId = "another-contract",
    ]
  ) {
    const artifact = await publishedArtifact();
    mutate(artifact);
    await rejects(() => publishedToolDraft(artifact));
  }
});

Deno.test("mutating admitted source code is refused before artifact import", async () => {
  const artifact = await publishedArtifact();
  artifact.candidate.code += "\n// mutated";
  await rejects(() => publishedToolDraft(artifact), /octets/);
});

Deno.test("artifact invocation authority belongs to exact native caller and scope, not global commit position", () => {
  const model = artifactModel("destination");
  const behavior = reuseBehavior();
  model.behaviors = [behavior];
  const proof = {
    behavior,
    callerId: "destination",
    invocationId: "import-one",
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: "commit:other-operational-catalog",
    },
  };
  equal(requireToolReuseAdmission(proof, model), behavior);
  throws(() =>
    requireToolReuseAdmission({ ...proof, callerId: "source" }, model)
  );
  throws(() =>
    requireToolReuseAdmission({
      ...proof,
      behavior: { ...behavior, targetNativeId: "foreign-target" },
    }, model)
  );
  throws(() =>
    requireToolReuseAdmission({
      ...proof,
      modelVersion: { ...proof.modelVersion, digest: "unadmitted" },
    }, model)
  );
});

Deno.test("reuse receipts report refused or pending state instead of asserting activation", async () => {
  const artifact = await publishedArtifact();
  for (
    const stage of [
      "awaiting-admission",
      "refused",
      "failed",
      "active",
    ] as const
  ) {
    const candidate = {
      ...artifact.candidate,
      id: "destination-candidate",
      stage,
      reusedFrom: {
        agentId: artifact.agentId,
        candidateId: artifact.candidate.id,
        digest: artifact.candidate.digest,
        correlationId: "import-one",
        behaviorId: "reuse-access",
        sourceModelDigest: artifact.model.version.digest,
        sourceRepositoryVersion: artifact.model.version.repositoryVersion!,
      },
    };
    const receipt = toolReuseReceipt(candidate, true);
    equal(receipt.stage, stage);
    equal(receipt.active, stage === "active");
    equal(receipt.replayed, true);
  }
});

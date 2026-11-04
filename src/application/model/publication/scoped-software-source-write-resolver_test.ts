import assert from "node:assert/strict";
import { createScopedSoftwareSourceWriteResolver } from "./scoped-software-source-write-resolver.ts";
import { parseScopedSoftwareWriteDossier } from "./scoped-software-write.ts";
import { modelWriteOperationsDigest } from "../../../domain/model/editing/write-command.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";

Deno.test("software Git resolver validates the closed command before loading its durable scoped lifecycle", async () => {
  const f = await requestAdoptionFixture();
  const { operatorId: _operatorId, ...locator } = f.target;
  const destination = {
    ...locator,
    expectedAdmittedSource: {
      revision: 1,
      source: f.intent.previous.pin.source,
      sourceDigest: "a".repeat(64),
    },
  };
  const proposalDigest = "b".repeat(64);
  const exercise = (act: "prepare" | "accept" | "adopt") => ({
    act,
    operatorNativeId: "actor",
    systemQualifiedName: "System",
    authorityDigest: "c".repeat(64),
    policyId: "policy",
    policyRevision: 1,
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: [f.target.operatorId],
    categories: ["instructions"],
    proposalDigest,
  });
  const decision = {
    dossierId: "evolution",
    evolutionIntentDigest: "d".repeat(64),
    proposalDigest,
    preparation: exercise("prepare"),
    acceptance: exercise("accept"),
    adoptionAuthorization: exercise("adopt"),
  };
  const operations = {
    kind: "whole-files" as const,
    files: {
      v: 1 as const,
      base: destination.expectedAdmittedSource.source,
      baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
      files: [{ path: "core.sysml", baseDigest: null, text: "changed" }],
    },
  };
  const intent = {
    v: 2,
    kind: "publish-software-evolution",
    repositoryId: destination.repositoryId,
    commandId: "11111111-1111-4111-8111-111111111111",
    approvedBase: destination.expectedAdmittedSource.source,
    destination,
    operationsRef: { digest: await modelWriteOperationsDigest(operations) },
    decisionRef: {
      id: "11111111-1111-4111-8111-111111111111",
      digest: await sha256(canonical(decision)),
    },
    recipeDigest: "e".repeat(64),
    authorityRef: {
      kind: "software-evolution-scoped-authority/v2",
      digest: await sha256(
        canonical({
          format: "software-evolution-scoped-authority/v2",
          preparation: decision.preparation,
          acceptance: decision.acceptance,
          adoptionAuthorization: decision.adoptionAuthorization,
        }),
      ),
    },
  };
  const dossier = await parseScopedSoftwareWriteDossier({
    v: 2,
    kind: "software-evolution-scoped-publication",
    operations,
    decision,
    command: { ...intent, intentDigest: await sha256(canonical(intent)) },
  });
  let reads = 0, git = 0, freshRights = 0;
  const resolver = createScopedSoftwareSourceWriteResolver({
    repository: {
      scopedSoftwareSourceWrite() {
        git++;
        throw new Error("Missing lifecycle must stop before Git");
      },
    },
    store: {
      get(id) {
        assert.equal(id, "evolution");
        reads++;
        return Promise.resolve(null);
      },
    },
    protocol: {
      assertNewEffect() {
        freshRights++;
        return Promise.resolve();
      },
      guardNewPublication() {
        throw new Error("No publication allowed");
      },
      settleHistorical() {
        throw new Error("No settlement allowed");
      },
    },
  });
  await assert.rejects(
    () => resolver.resolve(dossier),
    /durable scoped software evolution/,
  );
  assert.equal(reads, 1);
  await assert.rejects(() =>
    resolver.resolve({ ...dossier, kind: "accept-proposal" } as never)
  );
  assert.equal(
    reads,
    1,
    "disguised human commands are refused before durable/Git lookup",
  );
  assert.equal(git, 0);
  assert.equal(
    freshRights,
    0,
    "structural resolution never revives current authority before recovery",
  );
});

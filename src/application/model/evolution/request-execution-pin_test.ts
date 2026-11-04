import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
} from "./request-adoption-ports.ts";
import { requestOpeningBase } from "../../../../test/support/request-space-fixture.ts";
import { requestExecutionPinFor } from "./request-execution-pin.ts";

Deno.test("member execution starts at its creation and advances only on its own adoption", async () => {
  const f = await requestAdoptionFixture();
  const base = await requestOpeningBase();
  base.requestOwner.operatorId = f.target.operatorId;
  const entry = (intent: typeof f.intent, id: string) => ({
    manifest: {
      intent,
      commandId: id,
      committedRuntimeRevision: 4,
    } as RequestAdoptionManifest,
    receipt: {
      commandId: id,
      receiptDigest: id,
      committedRuntimeRevision: 4,
    } as RequestAdoptionReceipt,
  });
  const created = entry({
    ...f.intent,
    team: {
      kind: "request-team-creation-adoption/v1",
      changeId: "birth",
      proposalIntentDigest: "a".repeat(64),
      approvedChangeDigest: "b".repeat(64),
      childSystemId: "member-system",
      team: [{ operatorId: "member", modelDigest: "c".repeat(64) }],
      sourceAdmission: {
        revision: 2,
        manifestDigest: "d".repeat(64),
        commandId: "birth",
        publicationReceiptDigest: "e".repeat(64),
        resultVersion: f.intent.candidate.source.version,
      },
    },
  }, "birth");
  const execution = { pin: f.intent.previous.pin, adoptions: [created] };
  const born = requestExecutionPinFor(execution, "member", base);
  equal(born.modelDigest, "c".repeat(64));
  equal(born.source.version, created.manifest.intent.candidate.source.version);
  equal(born.adoption, null);
  deepStrictEqual(
    requestExecutionPinFor(execution, f.target.operatorId, base),
    execution.pin,
  );
  throws(
    () => requestExecutionPinFor(execution, "outsider", base),
    {
      code: "UNAVAILABLE",
      context: { ownerId: f.target.operatorId, operatorId: "outsider" },
      recovery:
        "Restore the member's verified creation and adoption journal before executing it.",
    },
  );
  const adopted = entry({
    ...f.intent,
    target: { ...f.target, operatorId: "member" },
    previous: { ...f.intent.previous, pin: born },
  }, "member-network");
  execution.adoptions.push(adopted);
  equal(
    requestExecutionPinFor(execution, "member", base).adoption
      ?.commandId,
    "member-network",
  );
  deepStrictEqual(
    requestExecutionPinFor(execution, f.target.operatorId, base),
    execution.pin,
  );
});

Deno.test("retained member starts at the immutable opening and only its own adoption advances it", async () => {
  const f = await requestAdoptionFixture();
  const base = await requestOpeningBase("c");
  base.requestOwner.operatorId = f.target.operatorId;
  const member = {
    ...base.manifest.operators[0],
    operatorId: "retained",
    modelDigest: "e".repeat(64),
  };
  base.manifest.operators.push(member);
  base.manifest.registeredOperatorIds.push(member.operatorId);
  const execution = {
    pin: f.intent.previous.pin,
    adoptions: [] as {
      manifest: RequestAdoptionManifest;
      receipt: RequestAdoptionReceipt;
    }[],
  };
  const expected = {
    source: {
      repositoryId: base.manifest.source!.repositoryId,
      version: member.repositoryVersion,
    },
    modelDigest: member.modelDigest,
    sourceAdmission: { revision: 1, manifestDigest: base.manifestDigest },
    adoption: null,
  };
  deepStrictEqual(
    requestExecutionPinFor(execution, "retained", base),
    expected,
  );
  execution.adoptions.push({
    manifest: {
      intent: f.intent,
      commandId: "owner-adoption",
      committedRuntimeRevision: 2,
    } as RequestAdoptionManifest,
    receipt: { receiptDigest: "f".repeat(64) } as RequestAdoptionReceipt,
  });
  deepStrictEqual(
    requestExecutionPinFor(execution, "retained", base),
    expected,
  );
  execution.adoptions.push({
    manifest: {
      intent: { ...f.intent, target: { ...f.target, operatorId: "retained" } },
      commandId: "member-adoption",
      committedRuntimeRevision: 3,
    } as RequestAdoptionManifest,
    receipt: { receiptDigest: "d".repeat(64) } as RequestAdoptionReceipt,
  });
  const advanced = requestExecutionPinFor(execution, "retained", base);
  equal(advanced.modelDigest, f.intent.candidate.model.version.digest);
  equal(advanced.adoption?.commandId, "member-adoption");
  throws(
    () => requestExecutionPinFor(execution, "outsider", base),
    { code: "UNAVAILABLE" },
  );
});

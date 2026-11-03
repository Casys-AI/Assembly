import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
} from "./request-adoption-ports.ts";
import { requestExecutionPinFor } from "./request-execution-pin.ts";

Deno.test("member execution starts at its creation and advances only on its own adoption", async () => {
  const f = await requestAdoptionFixture();
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
  const born = requestExecutionPinFor(f.target.operatorId, execution, "member");
  equal(born.modelDigest, "c".repeat(64));
  equal(born.source.version, created.manifest.intent.candidate.source.version);
  equal(born.adoption, null);
  deepStrictEqual(
    requestExecutionPinFor(f.target.operatorId, execution, f.target.operatorId),
    execution.pin,
  );
  throws(
    () => requestExecutionPinFor(f.target.operatorId, execution, "outsider"),
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
    requestExecutionPinFor(f.target.operatorId, execution, "member").adoption
      ?.commandId,
    "member-network",
  );
  deepStrictEqual(
    requestExecutionPinFor(f.target.operatorId, execution, f.target.operatorId),
    execution.pin,
  );
});

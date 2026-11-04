import normal from "../fixtures/request-source-owner-normal.json" with {
  type: "json",
};
import {
  captureRequestSourceOwnerPhase,
  type RequestSourceOwnerContext,
  type RequestSourcePriorModel,
} from "../../src/application/model/source-admission/request-source-owner.ts";
import type { RequestModelWriteDestination } from "../../src/domain/model/editing/request-write-destination.ts";
import type { SpaceController } from "../../src/domain/work/request-spaces/space-control.ts";
export { normal as normalSourceOwnerMetadata };
/** Metadata captured from the owned normal-source witness, never a credential. */
export function normalOwnerInput() {
  const context: RequestSourceOwnerContext = {
    destination: structuredClone(
      normal.destination,
    ) as RequestModelWriteDestination,
    openingOwnerId: normal.openingOwnerId,
    targetOperatorId: normal.priorModel.identity.builderId,
    priorModel: structuredClone(normal.priorModel) as RequestSourcePriorModel,
  };
  const controller = structuredClone(normal.controller) as SpaceController;
  return {
    context,
    controller,
    sessionRevision: normal.sessionRevision,
    binding: {
      scope: structuredClone(context.destination.host),
      sourceSystemNativeId: controller.authority.sourceSystemNativeId,
    },
    capturedAt: "2026-10-30T01:00:00.000Z",
  };
}
export function normalOwnerEnvelope() {
  const proposal = captureRequestSourceOwnerPhase({
    ...normalOwnerInput(),
    phase: "proposal",
  });
  const next = normalOwnerInput();
  next.controller.sessionId = "reconnected-local-session";
  next.sessionRevision = 2;
  next.capturedAt = "2026-10-30T01:01:00.000Z";
  const acceptance = captureRequestSourceOwnerPhase({
    ...next,
    phase: "acceptance",
  });
  return {
    v: 1 as const,
    kind: "request-source-owner-authority" as const,
    proposal,
    acceptance,
  };
}

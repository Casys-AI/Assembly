import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  type OpeningBase,
  retainedMember,
} from "../../../domain/work/request-spaces.ts";
import {
  RequestAdoptionError,
  type RequestAdoptionManifest,
  type RequestAdoptionReceipt,
  type RequestExecutionPin,
} from "./request-adoption-ports.ts";

/** Project one operator's execution from the verified branch journal. A member
 * starts at its immutable opening manifest or the team adoption that admitted
 * it; another operator's adoption never advances its pin. No runtime snapshot
 * supplies its own authority. */
export function requestExecutionPinFor(
  execution: {
    pin: RequestExecutionPin;
    adoptions: readonly {
      manifest: RequestAdoptionManifest;
      receipt: RequestAdoptionReceipt;
    }[];
  },
  operatorId: string,
  base: OpeningBase,
): RequestExecutionPin {
  const ownerId = base.requestOwner.operatorId;
  if (operatorId === ownerId) return structuredClone(execution.pin);
  const retained = retainedMember(base, operatorId);
  let pin: RequestExecutionPin | undefined = retained && base.manifest.source
    ? {
      source: parseModelRevisionRef({
        repositoryId: base.manifest.source.repositoryId,
        version: retained.repositoryVersion,
      }),
      modelDigest: retained.modelDigest,
      sourceAdmission: { revision: 1, manifestDigest: base.manifestDigest },
      adoption: null,
    }
    : undefined;
  for (const { manifest, receipt } of execution.adoptions) {
    const { candidate, target, team } = manifest.intent;
    const birth = team?.team.find((member) => member.operatorId === operatorId);
    if (!pin && birth) {
      pin = {
        source: candidate.source,
        modelDigest: birth.modelDigest,
        sourceAdmission: candidate.sourceAdmission,
        adoption: null,
      };
    }
    if (target.operatorId === operatorId) {
      if (!pin) break;
      pin = {
        source: candidate.source,
        modelDigest: candidate.model.version.digest,
        sourceAdmission: candidate.sourceAdmission,
        adoption: {
          commandId: manifest.commandId,
          receiptDigest: receipt.receiptDigest,
          committedRuntimeRevision: manifest.committedRuntimeRevision,
        },
      };
    }
  }
  if (!pin) {
    throw new RequestAdoptionError(
      "UNAVAILABLE",
      "The operator has no verified execution pin in this Request.",
      {
        context: { ownerId, operatorId },
        recovery:
          "Restore the member's verified creation and adoption journal before executing it.",
      },
    );
  }
  return structuredClone(pin);
}

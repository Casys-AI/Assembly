import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  NativeExecutionRequest,
  RuntimeRevisionReference,
} from "./contract.ts";
import { invocationKey } from "../operators/journal.ts";
import { immutablePin } from "./encodings.ts";

export function assertBusinessRevisionReference(
  operatorId: string,
  reference: RuntimeRevisionReference,
) {
  const ref = reference.__assemblyRuntimeRevision;
  if (
    !ref || ref.operatorId !== operatorId ||
    !Number.isSafeInteger(ref.revision) || ref.revision < 0
  ) throw new Error("Invalid immutable business revision reference");
  return ref;
}

export function assertBusinessRevisionState(
  ref: RuntimeRevisionReference["__assemblyRuntimeRevision"],
  state: SystemRuntimeState,
) {
  if (
    state.id !== ref.systemId || state.revision !== ref.revision ||
    state.executionModel?.version.digest !== ref.modelDigest ||
    state.executionModel.identity.builderId !== ref.operatorId
  ) {
    throw new Error(
      "Canonical business revision reference does not match its source",
    );
  }
  if (
    ref.invocationKey !== undefined &&
    (!state.caseInvocation ||
      invocationKey(state.caseInvocation) !== ref.invocationKey)
  ) {
    throw new Error(
      "Canonical business revision invocation differs from its immutable reference",
    );
  }
}

export function recoverHistoricalRequest(
  submitted: NativeExecutionRequest,
  source: {
    businessRevision: RuntimeRevisionReference;
    contribution: NativeExecutionRequest["contribution"];
  },
  historical: SystemRuntimeState,
  pinJson: string,
) {
  const reference = source.businessRevision, model = historical.executionModel!;
  const pin = JSON.parse(pinJson);
  const flow = [
    ...Object.values(model.flows),
    ...Object.values(model.caseFlows ?? {}),
  ].find((item) =>
    item.rootOccurrenceId === pin.flowOccurrenceId &&
    item.rootNativeId === pin.flowRootId
  );
  if (!flow || !Number.isSafeInteger(pin.maxSteps)) {
    throw new Error(
      "Native run source flow is unavailable in its accepted model revision",
    );
  }
  const recovered = {
    ...submitted,
    contribution: source.contribution,
    model,
    flow,
    maxSteps: pin.maxSteps,
    businessRevision: reference,
  };
  if (immutablePin(recovered) !== pinJson) {
    throw new Error(
      "Historical native model does not match the immutable run pin",
    );
  }
  return recovered;
}

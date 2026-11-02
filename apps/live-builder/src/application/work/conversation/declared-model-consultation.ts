/** Execute a source-declared read without asking a model to choose that read. */
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  CompiledFlowNode,
  FlowActionResult,
} from "../../../domain/model/execution/flow.ts";
import type { MessageObservation } from "../../../domain/work/policies/context-separation.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import type { DecisionInformationPort } from "../context/information-ports.ts";
import { caseMessages } from "../cases/runtime.ts";

export interface DeclaredModelConsultationHost {
  readonly snapshot: SystemRuntimeState;
  readonly ports: { information?: DecisionInformationPort };
  currentModel(): Promise<ExecutableModel>;
  feedback(text: string, observation?: MessageObservation): Promise<void>;
}

const MAX_REQUEST_CHARACTERS = 4096;
const MAX_RESULT_CHARACTERS = 65536;

/** The compiler checks this closed request too. It is the only read this
 * primitive performs: it confers no agent-chosen read right. */
function declaredRequest(
  source: string | undefined,
  version: string,
): Record<string, unknown> & { version: string } {
  if (!source || characterCount(source) > MAX_REQUEST_CHARACTERS) {
    throw new Error("A bounded native consultation request is required.");
  }
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The native consultation request must be an object.");
  }
  const request = value as Record<string, unknown>;
  const selector = request.operation === "inspect"
    ? "elementId"
    : request.operation === "read_source"
    ? "path"
    : undefined;
  if (
    !selector || typeof request[selector] !== "string" ||
    !(request[selector] as string).trim() ||
    (request[selector] as string).length > (selector === "path" ? 240 : 512) ||
    Object.keys(request).some((key) =>
      !["operation", "version", selector].includes(key)
    ) ||
    request.version !== undefined && request.version !== version
  ) throw new Error("Unsupported or unpinned native consultation request.");
  return { ...request, version };
}

/** The flow itself declares this read; the host executes it on the exact
 * admitted pin. It needs only the operator's current admission. Revision proposals
 * and agent-chosen reads have separate rights, neither required by this primitive.
 * Failure is a modeled result: the caller must follow the declared failure edge. */
export async function consultDeclaredModelSource(
  this: DeclaredModelConsultationHost,
  current: ExecutableModel,
  node: Pick<CompiledFlowNode, "nativeId"> & { consultationRequest?: string },
): Promise<FlowActionResult> {
  try {
    const live = await this.currentModel();
    if (
      live.identity.builderId !== current.identity.builderId ||
      live.version.digest !== current.version.digest ||
      live.version.repositoryVersion !== current.version.repositoryVersion ||
      !current.version.repositoryVersion ||
      !this.ports.information?.consultAdmittedModelSource
    ) {
      throw new Error(
        "The declared consultation requires the operator's current exact admission and its admitted-source reader.",
      );
    }
    const request = declaredRequest(
      node.consultationRequest,
      current.version.repositoryVersion,
    );
    // The admitted source may precede the design working set's HEAD. Keep its
    // actual read result in this versioned observation, not in a different pin's
    // mutable loaded-source set.
    const messages = structuredClone(caseMessages(this.snapshot));
    const response = await this.ports.information.consultAdmittedModelSource(
      current,
      request,
      messages,
      { maxResponseCharacters: MAX_RESULT_CHARACTERS },
    );
    // The information adapter revalidates its admission; retain the same host
    // check after the asynchronous read as every actual decision/effect.
    const after = await this.currentModel();
    if (
      after.version.digest !== current.version.digest ||
      after.version.repositoryVersion !== current.version.repositoryVersion
    ) {
      throw new Error(
        "The admitted model changed during mandatory consultation.",
      );
    }
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("The model reader returned an unversioned result.");
    }
    const result = response as {
      modelVersion?: { digest?: string; repositoryVersion?: string };
      result?: unknown;
    };
    if (
      result.modelVersion?.digest !== current.version.digest ||
      result.modelVersion.repositoryVersion !==
        current.version.repositoryVersion ||
      !Object.hasOwn(result, "result")
    ) throw new Error("The model reader returned another admission pin.");
    const evidence = {
      actionId: node.nativeId,
      request,
      modelVersion: result.modelVersion,
      result: result.result,
    };
    const encoded = JSON.stringify(evidence);
    if (characterCount(encoded) > MAX_RESULT_CHARACTERS) {
      throw new Error(
        "Mandatory model consultation exceeds its bounded result.",
      );
    }
    await this.feedback(
      "Mandatory declared model consultation; versioned observed data.\n" +
        encoded,
      { kind: "model-context", value: evidence },
    );
    return {
      outputs: {
        consultation: {
          succeeded: true,
          code: "MODEL_CONSULTED",
          details: JSON.stringify({
            actionId: node.nativeId,
            modelVersion: result.modelVersion,
            operation: request.operation,
          }),
        },
      },
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error &&
        typeof error.code === "string"
      ? error.code.slice(0, 128)
      : "MODEL_CONSULTATION_REFUSED";
    const details = (error instanceof Error ? error.message : String(error))
      .slice(0, 2048);
    return { outputs: { consultation: { succeeded: false, code, details } } };
  }
}

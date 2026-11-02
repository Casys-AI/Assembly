import type { BehaviorInvocationPort } from "./invocation.ts";
import type {
  OperatorWorkAdmission,
  OperatorWorkResult,
} from "../operators/conversations.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { MAX_USER_MESSAGE_CHARS } from "../../../domain/work/records/conversations.ts";

/** One performed source entry maps to one actual operator session. */
export class OperatorInboxBehavior implements BehaviorInvocationPort {
  constructor(
    readonly options: {
      targets: ReadonlyMap<string, string>;
      /** Current work-scope availability, additional to admitted source exposure. */
      canContribute?(callerId: string, targetNativeId: string): boolean;
      resolveCallerModel(
        callerId: string,
        version: BehaviorModelVersion,
      ): Promise<ExecutableModel | null>;
      dispatch(
        agentId: string,
        text: string,
        correlationId: string,
        proof: OperatorWorkAdmission,
      ): Promise<OperatorWorkResult>;
    },
  ) {}

  async supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean> {
    const copied = structuredClone(behavior);
    const target = this.options.targets.get(copied.targetNativeId);
    if (!target || target === copied.callerNativeId) return false;
    const schema = copied.inputSchema;
    const properties = schema.properties as
      | Record<string, { type?: unknown }>
      | undefined;
    if (
      schema.type !== "object" || schema.additionalProperties !== false ||
      !properties || Object.keys(properties).join() !== "text" ||
      properties.text?.type !== "string" || !Array.isArray(schema.required) ||
      schema.required.length !== 1 || schema.required[0] !== "text"
    ) return false;
    const model = await this.options.resolveCallerModel(
      copied.callerNativeId,
      version,
    );
    return !!model && model.identity.builderId === copied.callerNativeId &&
      model.version.digest === version.digest &&
      (model.behaviors || []).some((entry) =>
        canonical(entry) === canonical(copied)
      ) &&
      (this.options.canContribute?.(
        copied.callerNativeId,
        copied.targetNativeId,
      ) ?? true);
  }

  async invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    const input = structuredClone(request);
    if (
      input.callerId !== input.behavior.callerNativeId ||
      !input.invocationId ||
      !await this.supports(input.behavior, input.modelVersion)
    ) {
      throw new Error(
        "La transmission n’est pas exposée à cet opérateur par le modèle admis.",
      );
    }
    if (
      Object.keys(input.input).length !== 1 ||
      typeof input.input.text !== "string" || !input.input.text.trim() ||
      input.input.text.length > MAX_USER_MESSAGE_CHARS
    ) {
      throw new Error(
        "Le dossier transmis doit contenir un objectif textuel borné.",
      );
    }
    const target = this.options.targets.get(input.behavior.targetNativeId)!;
    const result = await this.options.dispatch(
      target,
      input.input.text,
      input.invocationId,
      input,
    );
    return {
      ...(input.caseId ? { caseId: input.caseId } : {}),
      behaviorId: input.behavior.id,
      invocationId: input.invocationId,
      targetNativeId: input.behavior.targetNativeId,
      modelVersion: input.modelVersion,
      result,
    };
  }
}

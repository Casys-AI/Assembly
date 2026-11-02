/**
 * APE 2.2 Fail-Closed Admission and 2.4 Closed-Catalog Selection: admit an exact
 * modeled behavior call; target flows retain their domain predicates.
 */
import { characterCount } from "../../domain/primitives/character-count.ts";
import { executionDigest } from "../../domain/primitives/execution-digest.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type {
  NativeBehaviorContract,
} from "../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../domain/shared-kernel/behavior-model-version.ts";
import type { BehaviorInvocationPort } from "../work/behaviors/invocation.ts";
import type { SchemaValidationPort } from "../work/behaviors/schema-validation.ts";

interface BehaviorChoice {
  behaviorId: string;
  inputJson: string;
}
export interface BehaviorAdmission {
  kind: "behavior";
  admitted: boolean;
  behaviorId: string;
  invocationId: string;
  input?: Record<string, unknown>;
  inputDigest?: string;
  modelVersion?: BehaviorModelVersion;
  failure?: { code: string; message: string };
}
export function behaviorVersion(model: ExecutableModel): BehaviorModelVersion {
  if (!model.version.repositoryVersion) {
    throw new Error("Behavior invocation requires an immutable source version");
  }
  return {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  };
}
export async function availableBehaviors(
  model: ExecutableModel,
  port?: BehaviorInvocationPort,
): Promise<NativeBehaviorContract[]> {
  if (!port || !model.version.repositoryVersion) return [];
  const version = behaviorVersion(model);
  const result: NativeBehaviorContract[] = [];
  for (const behavior of model.behaviors ?? []) {
    if (
      behavior.callerNativeId === model.identity.builderId &&
      await port.supports(behavior, version)
    ) {
      result.push(structuredClone(behavior));
    }
  }
  return result;
}
/** Representation, registration and source authority only. Domain predicates are
 * evaluated by the target's native flow after this generic call admission. */
export async function admitBehaviorCall(
  choice: BehaviorChoice,
  model: ExecutableModel,
  schemaValidator: SchemaValidationPort,
  port?: BehaviorInvocationPort,
  invocationId: string = crypto.randomUUID(),
): Promise<BehaviorAdmission> {
  const refused = (code: string, message: string): BehaviorAdmission => ({
    kind: "behavior",
    admitted: false,
    behaviorId: choice.behaviorId,
    invocationId,
    failure: { code, message },
  });
  const matches = (model.behaviors ?? []).filter((behavior) =>
    behavior.id === choice.behaviorId &&
    behavior.callerNativeId === model.identity.builderId
  );
  if (matches.length !== 1) {
    return refused(
      "BEHAVIOR_NOT_AUTHORIZED",
      "Ce comportement n’est pas exposé à cet opérateur par le modèle admis.",
    );
  }
  if (
    !port || !model.version.repositoryVersion ||
    !await port.supports(matches[0]!, behaviorVersion(model))
  ) {
    return refused(
      "BEHAVIOR_UNAVAILABLE",
      "Aucun exécuteur unique n’est disponible pour ce comportement déclaré.",
    );
  }
  let input: unknown;
  try {
    if (
      typeof choice.inputJson !== "string" ||
      characterCount(choice.inputJson) > 65536
    ) throw new Error("Invalid input size");
    input = JSON.parse(choice.inputJson);
  } catch {
    return refused(
      "BEHAVIOR_INPUT_INVALID",
      "Les paramètres doivent être un objet JSON valide et borné.",
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return refused(
      "BEHAVIOR_INPUT_INVALID",
      "Un objet de paramètres est requis par le contrat natif.",
    );
  }
  const validation = schemaValidator.validate(matches[0]!.inputSchema, input);
  if (!validation.valid) {
    return refused(
      "BEHAVIOR_INPUT_INVALID",
      "Paramètres non conformes au contrat SysML : " +
        validation.errors.slice(0, 800),
    );
  }
  return {
    kind: "behavior",
    admitted: true,
    behaviorId: choice.behaviorId,
    invocationId,
    input: input as Record<string, unknown>,
    inputDigest: await executionDigest(input),
    modelVersion: behaviorVersion(model),
  };
}

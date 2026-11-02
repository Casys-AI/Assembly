/** Assemble the production admission function with the technical validator. */
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { AdmitBehaviorCall as admit } from "../../src/application/governance/handlers/behavior-call-admission-handler.ts";

export {
  availableBehaviors,
  behaviorVersion,
} from "../../src/application/governance/behavior-call-admission.ts";

export function admitBehaviorCall(
  choice: Parameters<typeof admit>[0],
  model: Parameters<typeof admit>[1],
  port?: Parameters<typeof admit>[3],
  invocationId?: string,
) {
  return admit(choice, model, new AjvSchemaValidator(), port, invocationId);
}

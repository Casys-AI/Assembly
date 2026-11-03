import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import {
  WorkPlanBehavior as Behavior,
  type WorkPlanBehaviorOptions,
} from "../../src/application/work/plans/plan-behavior.ts";
import type { SchemaValidationPort } from "../../src/application/work/behaviors/schema-validation.ts";

/** Assemble the unmodified production behavior for existing test scenarios. */
export class WorkPlanBehavior extends Behavior {
  constructor(
    options: Omit<WorkPlanBehaviorOptions, "schemaValidator"> & {
      schemaValidator?: SchemaValidationPort;
    },
  ) {
    super({ schemaValidator: new AjvSchemaValidator(), ...options });
  }
}

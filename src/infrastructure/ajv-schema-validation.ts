import { Ajv } from "ajv";
import type { SchemaValidationPort } from "../application/work/behaviors/schema-validation.ts";

/** Keep each admission's schema compilation and diagnostics isolated. */
export class AjvSchemaValidator implements SchemaValidationPort {
  validate(schema: Record<string, unknown>, value: unknown) {
    const ajv = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    const validate = ajv.compile(schema);
    return validate(value) ? { valid: true as const } : {
      valid: false as const,
      errors: ajv.errorsText(validate.errors, { separator: "; " }),
    };
  }
}

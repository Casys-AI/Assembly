import { deepStrictEqual, throws } from "node:assert/strict";
import { AjvSchemaValidator } from "./ajv-schema-validation.ts";

Deno.test("Ajv schema validation preserves diagnostics and never repairs input", () => {
  const validator = new AjvSchemaValidator();
  const schema = {
    type: "object",
    properties: {
      message: { type: "string", default: "default" },
      count: { type: "integer" },
    },
    required: ["message", "count"],
    additionalProperties: false,
  };
  const input = { message: 42, extra: true };
  deepStrictEqual(validator.validate(schema, input), {
    valid: false,
    errors:
      "data must have required property 'count'; data must NOT have additional properties; data/message must be string",
  });
  deepStrictEqual(input, { message: 42, extra: true });
  const missing = { count: -17 };
  deepStrictEqual(validator.validate(schema, missing), {
    valid: false,
    errors: "data must have required property 'message'",
  });
  deepStrictEqual(missing, { count: -17 });
  deepStrictEqual(validator.validate(schema, { message: "Écho", count: -17 }), {
    valid: true,
  });
});

Deno.test("Ajv schema validation recompiles each exact contract and preserves strict errors", () => {
  const validator = new AjvSchemaValidator();
  const schema = { type: "string" };
  deepStrictEqual(validator.validate(schema, "Écho"), { valid: true });
  schema.type = "integer";
  deepStrictEqual(validator.validate(schema, "Écho"), {
    valid: false,
    errors: "data must be integer",
  });
  throws(
    () => validator.validate({ type: "object", unknownKeyword: true }, {}),
    { message: 'strict mode: unknown keyword: "unknownKeyword"' },
  );
});

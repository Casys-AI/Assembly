/** Technical representation validation, supplied by the composition root. */
export interface SchemaValidationPort {
  validate(
    schema: Record<string, unknown>,
    value: unknown,
  ): { valid: true } | { valid: false; errors: string };
}

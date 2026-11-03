/** PostgreSQL BIGINT preserves the legacy safe-integer domain, unlike SQL INT. */
export function postgresSafeInteger(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Invalid PostgreSQL nonnegative safe integer");
  }
  return number;
}

export function postgresBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid PostgreSQL nonnegative safe integer");
  }
  return BigInt(value);
}

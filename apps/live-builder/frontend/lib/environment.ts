export type AssemblyEnvironment = "development" | "production";

/** Public backend runtime metadata, independent of the frontend build mode. */
export function parseEnvironment(value: unknown): AssemblyEnvironment {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).join() !== "environment" ||
    !("environment" in value) ||
    (value.environment !== "development" && value.environment !== "production")
  ) {
    throw new Error("The backend environment is unavailable.");
  }
  return value.environment;
}

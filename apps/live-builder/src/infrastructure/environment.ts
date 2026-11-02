export type EnvironmentReader = (name: string) => string | undefined;
export type AssemblyEnvironment = "development" | "production";

/** Unknown values fail closed instead of silently enabling development. */
export function resolveAssemblyEnvironment(
  value: string | undefined,
): AssemblyEnvironment {
  if (value === undefined || value === "production") return "production";
  if (value === "development") return "development";
  throw new Error("ASSEMBLY_ENV must be development or production");
}

export function resolveAssemblyHostname(
  environment: AssemblyEnvironment,
  requested?: string,
): string {
  if (
    environment === "development" && requested !== undefined &&
    requested !== "127.0.0.1"
  ) {
    throw new Error("Development must bind to 127.0.0.1");
  }
  return "127.0.0.1";
}

/** Product configuration uses Assembly names. Existing ASE launchers remain
 * supported, including callers that only granted access to the legacy name.
 * An explicitly defined canonical value wins, even when it is empty. */
export function readAssemblyEnv(
  name: `ASSEMBLY_${string}`,
  read: EnvironmentReader = (key) => Deno.env.get(key),
): string | undefined {
  const optional = (key: string): string | undefined => {
    try {
      return read(key);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotCapable ||
        error instanceof Deno.errors.PermissionDenied
      ) return undefined;
      throw error;
    }
  };
  return optional(name) ?? optional(name.replace(/^ASSEMBLY_/, "ASE_"));
}

/** Driver diagnostics remain host-private: they can include SQL and payloads. */
export function publicPostgresFailure(error: unknown): Error | undefined {
  if (!(error instanceof Error) || error.name === "EvolutionError") return;
  if (
    error instanceof AggregateError &&
    error.errors.some((entry) =>
      entry !== error && publicPostgresFailure(entry)
    )
  ) {
    return new Error(
      "Operational storage is unavailable; retry or contact the host operator",
    );
  }
  const diagnostic = error as Error & { code?: unknown };
  const transportCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ]);
  if (
    /^(PrismaClient|DriverAdapterError)/.test(error.name) ||
    typeof diagnostic.code === "string" &&
      (/^[0-9A-Z]{5}$/.test(diagnostic.code) && /[0-9]/.test(diagnostic.code) ||
        transportCodes.has(diagnostic.code))
  ) {
    return new Error(
      "Operational storage is unavailable; retry or contact the host operator",
    );
  }
}

export function safeStoragePort<T extends object>(port: T): T {
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result: unknown = Reflect.apply(value, target, args);
          if (
            result !== null &&
            (typeof result === "object" || typeof result === "function") &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            return Promise.resolve(result).catch((error) => {
              throw publicPostgresFailure(error) ?? error;
            });
          }
          return result;
        } catch (error) {
          throw publicPostgresFailure(error) ?? error;
        }
      };
    },
  });
}

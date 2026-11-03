export interface PostgresClientConfiguration {
  /** Host-only connection material: never serialize into domain/provider data. */
  readonly connectionString: string;
  readonly maxConnections: number;
  readonly schema: string;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
}

/** pg's URL options override PoolConfig and PGOPTIONS. Preserve the effective
 * existing startup options, then set UTC last for every Prisma pool socket. */
export function postgresPrismaUtcConnectionString(
  connectionString: string,
  environmentOptions: string | undefined,
): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "PostgreSQL connection configuration is missing or invalid",
    );
  }
  const options = url.searchParams.getAll("options");
  if (options.length > 1) {
    throw new Error("PostgreSQL startup options are ambiguous");
  }
  const existing = options.length ? options[0] : environmentOptions ?? "";
  // An escaped option boundary could swallow the appended setting. Refuse
  // such configurations instead of attempting to parse PostgreSQL's grammar.
  // Control characters are deliberately rejected in this startup-option boundary.
  // deno-lint-ignore no-control-regex
  if (existing.includes("\\") || /[\x00-\x1f\x7f]/.test(existing)) {
    throw new Error(
      "PostgreSQL startup options cannot be safely combined with UTC",
    );
  }
  url.searchParams.set("options", `${existing.trim()} -c TimeZone=UTC`.trim());
  return url.toString();
}

export function postgresClientConfiguration(
  connectionString: string | undefined,
  maxConnections = 4,
  schema = "public",
): PostgresClientConfiguration {
  // Keep configuration failures independent of pg/Prisma and never echo input.
  let url: URL;
  try {
    url = new URL(connectionString ?? "");
  } catch {
    throw new Error(
      "PostgreSQL connection configuration is missing or invalid",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname || url.pathname.length < 2 || url.hash ||
    !Number.isSafeInteger(maxConnections) || maxConnections < 1 ||
    maxConnections > 32 || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)
  ) {
    throw new Error(
      "PostgreSQL connection configuration is missing or invalid",
    );
  }
  return {
    connectionString: connectionString!,
    maxConnections,
    schema,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  };
}

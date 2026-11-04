/** An unmet startup prerequisite, safe to report before serving. */
export abstract class StartupRefusalError extends Error {
  abstract readonly code: string;
  abstract readonly context: unknown;
  abstract readonly recovery: string;
}

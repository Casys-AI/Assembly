import { matchesExactRevision } from "../../shared-kernel/revision-id.ts";
import { canonicalDigest } from "../../primitives/execution-digest.ts";

export interface RequestSpaceScope {
  projectId: string;
  systemId: string;
}

export class RequestSpaceError extends Error {
  constructor(
    readonly code:
      | "INVALID_COMMAND"
      | "OPENING_CONFLICT"
      | "UNAVAILABLE"
      | "FORBIDDEN"
      | "ADMISSION_REFUSED"
      | "PROVISIONING_UNAVAILABLE",
    message: string,
    /** What was refused and how to recover, for an agent reading the code. */
    details: { context?: Record<string, unknown>; recovery?: string } = {},
  ) {
    super(message);
    this.name = "RequestSpaceError";
    this.context = details.context;
    this.recovery = details.recovery;
  }
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;
}
export const requestSpaceDigest = (value: unknown): Promise<string> =>
  canonicalDigest(value);
export function exactSourceVersion(value: unknown): value is string {
  return typeof value === "string" && matchesExactRevision(value);
}
export function requestSpaceIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

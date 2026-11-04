import { HostEditError } from "../../../domain/model/editing/host-edit.ts";
import { ChangePublicationError } from "../../../domain/model/publication/change.ts";

/** Phase-specific classification; filesystem and repository failures stay retryable. */
export function publicationFailure(
  error: unknown,
  context: ChangePublicationError["context"],
  fallback: "refuse" | "retry",
): ChangePublicationError {
  if (error instanceof ChangePublicationError) return error;
  if (error instanceof HostEditError && error.recovery === "refuse") {
    return new ChangePublicationError(
      "PUBLICATION_NOT_APPLICABLE",
      context,
      error.message,
    );
  }
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
  const compilationFailure = error instanceof Error &&
    error.name === "SysmlToolkitWorkerError";
  const transient = [
    "TOOLKIT_WORKER_UNAVAILABLE",
    "STALE_REVISION",
    "SOURCE_CONFLICT",
    "INVALID_REPOSITORY",
    "NOT_FOUND",
    "UPSTREAM_FAILURE",
    "EIO",
    "EBUSY",
    "EACCES",
    "ENOENT",
    "ENOSPC",
  ].includes(String(code)) || error instanceof Error && [
        "NotFound",
        "PermissionDenied",
        "NotCapable",
        "Busy",
        "TimedOut",
        "Interrupted",
        "BrokenPipe",
        "WriteZero",
        "UnexpectedEof",
        "WouldBlock",
        "SysmlToolkitTimeoutError",
      ].includes(error.name);
  const refuse = !transient &&
    (fallback === "refuse" ||
      ["INVALID_REQUEST", "NEEDS_DECISION", "REFUSED", "WRITE_QUEUE_CONFLICT"]
        .includes(String(code)) ||
      compilationFailure);
  return new ChangePublicationError(
    refuse ? "PUBLICATION_NOT_APPLICABLE" : "PUBLICATION_FAILED",
    context,
    error instanceof Error ? error.message : String(error),
  );
}

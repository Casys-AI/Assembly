/** Shared HTTP refusal, also exported by the Request source revision client. */
export class RequestSourceApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly sessionInvalid = false,
  ) {
    super(message);
    this.name = "RequestSourceApiError";
  }
}

export function responseError(
  status: number,
  body: unknown,
  fallback: string,
): RequestSourceApiError {
  const value = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  return new RequestSourceApiError(
    typeof value.error === "string" && value.error.length < 1000
      ? value.error
      : fallback,
    status,
    typeof value.code === "string" && /^[A-Z_]{1,128}$/.test(value.code)
      ? value.code
      : undefined,
    !!value.context && typeof value.context === "object" &&
      !Array.isArray(value.context) &&
      (value.context as Record<string, unknown>).session === "invalid",
  );
}

/** A scoped 403 alone says nothing about the current control session. */
export const isSessionFailure = (cause: unknown): boolean =>
  cause instanceof RequestSourceApiError &&
  (cause.status === 401 ||
    cause.status === 403 && cause.code === "FORBIDDEN" && cause.sessionInvalid);

export const isStaleConversation = (
  cause: unknown,
): cause is RequestSourceApiError =>
  cause instanceof RequestSourceApiError && cause.status === 409 &&
  cause.code === "STALE_CONVERSATION";

/** Only an explicit, side-effect-free refusal permits this one message retry.
 * The caller rereads and validates its target; it returns null if unavailable. */
export async function retryOnceAfterStale<Target, Result>(
  submit: (target?: Target) => Promise<Result>,
  reload: () => Promise<Target | null>,
): Promise<Result> {
  try {
    return await submit();
  } catch (cause) {
    if (!isStaleConversation(cause)) throw cause;
    let target: Target | null;
    try {
      target = await reload();
    } catch {
      throw cause;
    }
    if (target === null) throw cause;
    return submit(target);
  }
}

/** Codes are visible at the send boundary; other host errors keep their prose. */
export function sendErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback;
  return cause instanceof RequestSourceApiError && cause.code
    ? `${cause.code}: ${message}`
    : message;
}

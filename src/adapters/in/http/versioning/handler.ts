import { parseModelRevisionId } from "../../../../domain/shared-kernel/revision-id.ts";
import {
  versionedError,
  versionedFailure,
  versionedJson,
} from "./responses.ts";

/** B3 board transport shared by immutable projections. Resolve the head once
 * per request, keep its version in success/error metadata, and never cache it. */
export function createVersionedModelHandler<T>(options: {
  path: string;
  name: string;
  failureCode: string;
  read(version: string): Promise<T>;
  digest(value: T): string;
  head?: () => Promise<string>;
  /** Explicit-version responses are immutable by default. Pass `false`
   * when the body depends on instance state (masks, transient failures):
   * the response then carries `no-cache` with its ETag and 304. */
  immutable?: boolean;
}) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== options.path) return null;
    if (request.method !== "GET") {
      return versionedError(
        "METHOD_NOT_ALLOWED",
        { method: request.method },
        `Read the ${options.name} with GET.`,
        405,
        { allow: "GET" },
      );
    }
    const names = [...url.searchParams.keys()];
    if (names.length === 0 && options.head) {
      let version: string | undefined;
      try {
        version = await options.head();
        parseModelRevisionId(version);
        const value = await options.read(version);
        const response = versionedJson(request, value, {
          digest: options.digest(value),
        });
        response.headers.set("x-model-version", version);
        return response;
      } catch (error) {
        return versionedFailure(error, {
          code: options.failureCode,
          name: options.name,
          version,
        });
      }
    }
    if (names.length !== 1 || names[0] !== "version") {
      return versionedError(
        "INVALID_REQUEST",
        { parameters: names },
        "Pass exactly one query parameter: version.",
        400,
      );
    }
    const version = url.searchParams.get("version") ?? "";
    try {
      parseModelRevisionId(version);
    } catch {
      return versionedError(
        "INVALID_VERSION",
        { version },
        "Pass ?version=commit:<40 lowercase hex digits>.",
        400,
      );
    }
    try {
      const value = await options.read(version);
      return versionedJson(request, value, {
        version,
        digest: options.digest(value),
        immutable: options.immutable,
      });
    } catch (error) {
      return versionedFailure(error, {
        code: options.failureCode,
        name: options.name,
        version,
      });
    }
  };
}

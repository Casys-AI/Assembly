import { sha256Bytes as sha256 } from "../../../../domain/primitives/sha256-bytes.ts";
import type { ModelRepositoryPort } from "../../../../application/model/repository.ts";
import { parseModelRevisionId } from "../../../../domain/shared-kernel/revision-id.ts";
import {
  MAX_TOKEN_SOURCE_BYTES,
  type SourceTokensDocument,
} from "../../../../domain/model/consultation/source-tokens.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";

import type { SysmlToolkitAdapter } from "../../../out/sysml-toolkit/adapter.ts";
import { ToolkitVersionedReader } from "../../../out/sysml-toolkit/projections/versioned-reader.ts";
import {
  versionedError,
  versionedFailure,
  versionedJson,
} from "../versioning/responses.ts";

/** Small bounded immutable cache; no source compilation or workspace mutation. */
export function createModelSourceTokensHandler(options: {
  repository: Pick<ModelRepositoryPort, "header">;
  tooling: Pick<SysmlToolkitAdapter, "tokens">;
}) {
  const cached = new Map<
    string,
    Promise<{ body: SourceTokensDocument; digest: string }>
  >();
  const reader = new ToolkitVersionedReader(
    async (key) => {
      const [version, path] = JSON.parse(key) as [string, string];
      const snapshot = await options.repository.header(version);
      if (snapshot.version !== version) {
        throw {
          code: "MODEL_VERSION_MISMATCH",
          context: { version },
          recovery: "Restore the exact requested source snapshot.",
        };
      }
      if (!Object.hasOwn(snapshot.sources, path)) {
        throw {
          code: "SOURCE_PATH_NOT_FOUND",
          context: { version, path },
          recovery: "Choose a file from this version's Files page.",
        };
      }
      const text = snapshot.sources[path];
      if (new TextEncoder().encode(text).length > MAX_TOKEN_SOURCE_BYTES) {
        throw {
          code: "INVALID_TOKEN_SOURCE_SIZE",
          context: { version, path, maxBytes: MAX_TOKEN_SOURCE_BYTES },
          recovery: "Read this large file as plain text.",
        };
      }
      const body = {
        version,
        path,
        ...await options.tooling.tokens(path, text),
      };
      return { body, digest: await sha256(canonical(body)) };
    },
    "source tokens",
    "SOURCE_TOKENS_TOOLKIT_FAILED",
  );
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/model/sources/tokens") return null;
    if (request.method !== "GET") {
      return versionedError(
        "METHOD_NOT_ALLOWED",
        { method: request.method },
        "Read source tokens with GET.",
        405,
        { allow: "GET" },
      );
    }
    const keys = [...url.searchParams.keys()];
    const version = url.searchParams.get("version") ?? "";
    const path = url.searchParams.get("path") ?? "";
    if (
      keys.length !== 2 || !keys.includes("version") ||
      !keys.includes("path") || !path || path.length > 240
    ) {
      return versionedError(
        "INVALID_REQUEST",
        { parameters: keys },
        "Pass exactly version and path.",
        400,
      );
    }
    try {
      parseModelRevisionId(version);
    } catch {
      return versionedError(
        "INVALID_VERSION",
        { version },
        "Choose an immutable commit version.",
        400,
      );
    }
    const key = JSON.stringify([version, path]);
    try {
      let pending = cached.get(key);
      if (!pending) {
        pending = reader.read(key);
        cached.set(key, pending);
        if (cached.size > 16) cached.delete(cached.keys().next().value!);
      }
      const { body, digest } = await pending;
      return versionedJson(request, body, { version, digest });
    } catch (error) {
      cached.delete(key);
      if (
        error && typeof error === "object" && "context" in error &&
        error.context && typeof error.context === "object"
      ) error.context = { ...error.context, version, path };
      return versionedFailure(error, {
        code: "SOURCE_TOKENS_FAILED",
        name: "source tokens",
        version,
      });
    }
  };
}

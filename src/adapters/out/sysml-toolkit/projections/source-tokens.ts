import { isNativeToolkitPanic } from "../runtime/native-addon.ts";
/** Syntax-only LSP operation. No workspace or library is attached to this server. */
import {
  MAX_SOURCE_TOKENS,
  MAX_TOKEN_SOURCE_BYTES,
  type SourceTokens,
} from "../../../../domain/model/consultation/source-tokens.ts";
import type { ToolkitRuntime } from "../runtime/loader.ts";

export function toolkitSourceTokens(
  runtime: ToolkitRuntime,
  path: string,
  text: string,
): SourceTokens {
  if (new TextEncoder().encode(text).length > MAX_TOKEN_SOURCE_BYTES) {
    throw new Error("Source exceeds the syntax token size limit");
  }
  if (!runtime.createLspServer) {
    throw new Error("Toolkit syntax LSP API unavailable");
  }
  const server = runtime.createLspServer();
  try {
    const send = (message: Record<string, unknown>) =>
      server.handle(JSON.stringify({ jsonrpc: "2.0", ...message })).map((
        reply,
      ) => JSON.parse(reply));
    const response = (id: number, method: string, params: unknown) => {
      const reply = send({ id, method, params }).find((message) =>
        message.id === id
      );
      if (!reply || reply.error || !("result" in reply)) {
        throw new Error(`Toolkit syntax LSP failed: ${method}`);
      }
      return reply.result;
    };
    const initialized = response(1, "initialize", {
      processId: null,
      rootUri: null,
      capabilities: { general: { positionEncodings: ["utf-16"] } },
      workspaceFolders: null,
    });
    const encoding = initialized?.capabilities?.positionEncoding;
    if (encoding !== undefined && encoding !== "utf-16") {
      throw new Error("Toolkit semantic tokens must use UTF-16 positions");
    }
    const provider = initialized?.capabilities?.semanticTokensProvider;
    const legend: unknown = provider?.legend?.tokenTypes;
    if (
      (provider?.full !== true &&
        !(provider?.full && typeof provider.full === "object" &&
          !Array.isArray(provider.full))) ||
      !Array.isArray(legend) ||
      legend.some((type) => typeof type !== "string")
    ) {
      throw new Error(
        "Toolkit does not advertise full semantic tokens and a legend",
      );
    }
    send({ method: "initialized", params: {} });
    const uri = `file:///assembly-syntax/${
      path.split("/").map(encodeURIComponent).join("/")
    }`;
    send({
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: path.endsWith(".kerml") ? "kerml" : "sysml",
          version: 1,
          text,
        },
      },
    });
    const result = response(2, "textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    return { legend, tokens: decodeSemanticTokens(result?.data, legend, text) };
  } catch (error) {
    if (isNativeToolkitPanic(error)) runtime.invalidate?.(error);
    throw error;
  } finally {
    try {
      server.free();
    } catch (error) {
      if (isNativeToolkitPanic(error)) {
        runtime.invalidate?.(error);
      }
      // Preserve the operation's outcome; a disposal trap still prevents the
      // worker from reusing the native runtime, as for Toolkit sessions.
    }
  }
}

/** Validate both transport and source boundaries before exposing any span. */
export function decodeSemanticTokens(
  data: unknown,
  legend: readonly string[],
  source: string,
): SourceTokens["tokens"] {
  if (
    !Array.isArray(data) || data.length % 5 ||
    data.length > MAX_SOURCE_TOKENS * 5 || !legend.length ||
    legend.length > 256 ||
    legend.some((type) => typeof type !== "string" || !type)
  ) throw new Error("Invalid native semantic tokens");
  const lines = source.split("\n");
  const tokens: SourceTokens["tokens"] = [];
  let line = 0, start = 0, previousEnd = 0;
  const splitsSurrogate = (text: string, at: number) =>
    at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800 &&
    text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00 &&
    text.charCodeAt(at) <= 0xdfff;
  for (let i = 0; i < data.length; i += 5) {
    const [deltaLine, deltaStart, length, type, modifiers] = data.slice(
      i,
      i + 5,
    );
    if (
      ![deltaLine, deltaStart, length, type, modifiers].every((value) =>
        Number.isSafeInteger(value) && value >= 0
      ) || length === 0 || type >= legend.length
    ) throw new Error("Invalid native semantic token delta");
    line += deltaLine;
    start = deltaLine ? deltaStart : start + deltaStart;
    const text = lines[line];
    if (
      !Number.isSafeInteger(line) || !Number.isSafeInteger(start) ||
      text === undefined || start + length > text.length ||
      (!deltaLine && start < previousEnd) || splitsSurrogate(text, start) ||
      splitsSurrogate(text, start + length)
    ) {
      throw new Error(
        "Native semantic token is outside its source or overlaps",
      );
    }
    tokens.push({ line, start, length, type });
    previousEnd = start + length;
  }
  return tokens;
}

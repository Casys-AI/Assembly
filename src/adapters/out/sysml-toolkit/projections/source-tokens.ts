import { isNativeToolkitPanic } from "../runtime/native-addon.ts";
/** Syntax-only LSP operation. No workspace or library is attached to this server. */
import {
  decodeSemanticTokens,
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

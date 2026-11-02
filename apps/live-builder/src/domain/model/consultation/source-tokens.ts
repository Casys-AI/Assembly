/** Native LSP coordinates: zero-based lines and UTF-16 code units. */
interface SourceToken {
  line: number;
  start: number;
  length: number;
  /** Index into the server's own legend, never a host SysML keyword table. */
  type: number;
}
export interface SourceTokens {
  legend: string[];
  tokens: SourceToken[];
}
export interface SourceTokensDocument extends SourceTokens {
  version: string;
  path: string;
}
export const MAX_TOKEN_SOURCE_BYTES = 256 * 1024;
export const MAX_SOURCE_TOKENS = 50_000;

/** Validate both transport and source boundaries before exposing any span. */
export function decodeSemanticTokens(
  data: unknown,
  legend: readonly string[],
  source: string,
): SourceToken[] {
  if (
    !Array.isArray(data) || data.length % 5 ||
    data.length > MAX_SOURCE_TOKENS * 5 || !legend.length ||
    legend.length > 256 ||
    legend.some((type) => typeof type !== "string" || !type)
  ) throw new Error("Invalid native semantic tokens");
  const lines = source.split("\n");
  const tokens: SourceToken[] = [];
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

import type {
  SourceTokens,
  SourceTokensDocument,
} from "../../../../src/domain/model/consultation/source-tokens.ts";
import { MAX_SOURCE_TOKENS } from "../../../../src/domain/model/consultation/source-tokens.ts";

/** Maps native legend categories to presentation only, with no SysML lexing. */
const classes: Readonly<Record<string, string>> = {
  namespace: "token-namespace",
  type: "token-type",
  class: "token-type",
  property: "token-property",
  variable: "token-variable",
  enumMember: "token-enum-member",
  keyword: "token-keyword",
  comment: "token-comment",
  string: "token-string",
  number: "token-number",
};
export interface TokenSegment {
  text: string;
  class?: string;
}

/** Original whitespace and UTF16 slices survive exactly, including unknown categories. */
export function sourceTokenSegments(
  text: string,
  line: number,
  document: SourceTokens | null,
  /** Exact snapshot line before display's CRLF normalization. */
  rawLine = text,
): TokenSegment[] {
  const plain = [{ text }];
  if (!document) return plain;
  // The only display/source difference permitted here is textLines() dropping
  // the CR from a CRLF ending. Never stretch bounds for arbitrary extra text.
  if (rawLine !== text && rawLine !== `${text}\r`) return plain;
  const tokens = document.tokens.filter((token) => token.line === line);
  const segments: TokenSegment[] = [];
  let end = 0;
  const splitPair = (at: number) =>
    at > 0 && at < rawLine.length && rawLine.charCodeAt(at - 1) >= 0xd800 &&
    rawLine.charCodeAt(at - 1) <= 0xdbff && rawLine.charCodeAt(at) >= 0xdc00 &&
    rawLine.charCodeAt(at) <= 0xdfff;
  for (const token of tokens) {
    if (
      ![token.start, token.length, token.type].every(Number.isSafeInteger) ||
      token.start < end || token.length <= 0 || token.type < 0 ||
      token.type >= document.legend.length ||
      token.start + token.length > rawLine.length || splitPair(token.start) ||
      splitPair(token.start + token.length)
    ) return plain;
    if (token.start > end) {
      segments.push({ text: text.slice(end, token.start) });
    }
    if (token.start < text.length) {
      segments.push({
        // slice clips only the validated, known trailing CR in rawLine.
        text: text.slice(token.start, token.start + token.length),
        class: Object.hasOwn(classes, document.legend[token.type])
          ? classes[document.legend[token.type]]
          : undefined,
      });
    }
    end = token.start + token.length;
  }
  if (end < text.length) segments.push({ text: text.slice(end) });
  return segments.length ? segments : plain;
}

export async function fetchSourceTokens(
  version: string,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SourceTokensDocument> {
  const response = await fetcher(
    `/api/model/sources/tokens?${new URLSearchParams({ version, path })}`,
    { signal },
  );
  if (!response.ok) throw new Error("Source coloring unavailable");
  const body = await response.json();
  if (
    body?.version !== version || body?.path !== path ||
    !Array.isArray(body.legend) || !body.legend.length ||
    body.legend.length > 256 ||
    body.legend.some((type: unknown) => typeof type !== "string" || !type) ||
    !Array.isArray(body.tokens) ||
    body.tokens.length > MAX_SOURCE_TOKENS ||
    body.tokens.some((token: Record<string, unknown> | null) =>
      !token ||
      ![token.line, token.start, token.length, token.type].every((value) =>
        Number.isSafeInteger(value) && (value as number) >= 0
      ) || (token.type as number) >= body.legend.length || !token.length
    )
  ) throw new Error("Invalid source coloring response");
  return body;
}

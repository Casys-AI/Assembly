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

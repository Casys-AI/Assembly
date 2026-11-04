import { Lexer, type Token, type Tokens } from "marked";
import { caseHref } from "../cases/cases.ts";

/**
 * Beyond this many characters a message reads as plain text. marked's inline
 * lexer is quadratic on adversarial paragraphs: about half a second for 20,000
 * characters of unclosed emphasis, links and code.
 */
export const MARKDOWN_LIMIT = 16_000;

/**
 * Deeper quotes or lists than this read as plain text: the lexer and the
 * renderer both recurse once per level, and a model can nest thousands.
 */
export const MAX_NESTING = 8;

/** Whether quotes and lists nest deeper than `MAX_NESTING`, read without recursion. */
function tooDeep(tokens: readonly Token[]): boolean {
  const pending = tokens.map((token) => ({ token, depth: 0 }));
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { token } = next;
    const depth = next.depth +
      (token.type === "blockquote" || token.type === "list" ? 1 : 0);
    if (depth > MAX_NESTING) return true;
    // Inline and block children, and a list's items.
    const { tokens: inner = [], items = [] } = token as Tokens.Generic;
    for (const child of [...inner, ...items] as Token[]) {
      pending.push({ token: child, depth });
    }
  }
  return false;
}

/**
 * An agent's message as marked reads it (GitHub flavour, a line break where
 * the agent wrote one), or nothing when it is too long or too deeply nested to
 * read safely. The tokens are data: the renderer builds elements from them,
 * never HTML.
 */
export function lexMessage(text: string): Token[] | undefined {
  if (text.length > MARKDOWN_LIMIT) return undefined;
  let tokens: Token[];
  try {
    tokens = Lexer.lex(text, { gfm: true, breaks: true });
  } catch (error) {
    // Nesting deep enough overflows the lexer's own recursion.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  return tooDeep(tokens) ? undefined : tokens;
}

const CASE_ID = /^[A-Za-z0-9_:-]{1,128}$/;

function parseLocal(href: string): URL | undefined {
  try {
    return new URL(href, "http://message.invalid");
  } catch {
    return undefined;
  }
}

/** The exact-source Diagnostics page of main or of one Request, nothing else. */
function diagnosticsHref(href: string): string | undefined {
  if (!href.startsWith("/system?")) return undefined;
  const url = parseLocal(href);
  if (!url || url.pathname !== "/system" || url.hash) return undefined;
  const names = [...url.searchParams.keys()];
  if (
    names.length !== new Set(names).size ||
    names.some((name) => !["page", "version", "caseBranch"].includes(name)) ||
    url.searchParams.get("page") !== "diagnostics" ||
    !/^commit:[a-f0-9]{40}$/.test(url.searchParams.get("version") ?? "")
  ) return undefined;
  const caseId = url.searchParams.get("caseBranch");
  return caseId === null || CASE_ID.test(caseId) ? href : undefined;
}

/** One Request of this application, by its identifier alone. */
function requestHref(href: string): string | undefined {
  if (!href.startsWith("/cases?")) return undefined;
  const url = parseLocal(href);
  if (!url || url.pathname !== "/cases" || url.hash) return undefined;
  const names = [...url.searchParams.keys()];
  const id = url.searchParams.get("case") ?? "";
  return names.length === 1 && names[0] === "case" && CASE_ID.test(id)
    ? caseHref(id)
    : undefined;
}

/** A destination a message may link to; any other link stays literal text. */
export function localLink(
  href: string,
): { target: "diagnostics" | "request"; href: string } | undefined {
  const diagnostics = diagnosticsHref(href);
  if (diagnostics) return { target: "diagnostics", href: diagnostics };
  const request = requestHref(href);
  return request ? { target: "request", href: request } : undefined;
}

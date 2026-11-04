import type { MarkedToken, Token } from "marked";
import { useMemo } from "preact/hooks";
import {
  lexMessage,
  localLink,
} from "../../lib/conversations/message-markdown.ts";

/**
 * Tokens in order, each as its own element: a bare string in a mapped list
 * would be escaped twice by the precompiled JSX.
 */
function TokenList({ tokens }: { tokens: readonly Token[] }) {
  return (
    <>
      {tokens.map((token, index) => <TokenView key={index} token={token} />)}
    </>
  );
}

/**
 * One marked token as an element. Only text reaches the page: raw HTML, images
 * and links to any other destination stay as the agent wrote them.
 */
function TokenView({ token }: { token: Token }) {
  const t = token as MarkedToken;
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return (
        <p>
          <TokenList tokens={t.tokens} />
        </p>
      );
    case "heading":
      return (
        <p class="message-heading">
          <TokenList tokens={t.tokens} />
        </p>
      );
    case "code":
      return <pre><code>{t.text}</code></pre>;
    case "blockquote":
      return (
        <blockquote>
          <TokenList tokens={t.tokens} />
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "list": {
      const items = t.items.map((item, index) => (
        <li key={index}>
          <TokenList tokens={item.tokens} />
        </li>
      ));
      return t.ordered
        ? (
          <ol
            start={typeof t.start === "number" && t.start !== 1
              ? t.start
              : undefined}
          >
            {items}
          </ol>
        )
        : <ul>{items}</ul>;
    }
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {t.header.map((cell, index) => (
                <th key={index}>
                  <TokenList tokens={cell.tokens} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, at) => (
              <tr key={at}>
                {row.map((cell, index) => (
                  <td key={index}>
                    <TokenList tokens={cell.tokens} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "text":
      return t.tokens ? <TokenList tokens={t.tokens} /> : <>{t.text}</>;
    case "escape":
      return <>{t.text}</>;
    case "strong":
      return (
        <strong>
          <TokenList tokens={t.tokens} />
        </strong>
      );
    case "em":
      return (
        <em>
          <TokenList tokens={t.tokens} />
        </em>
      );
    case "del":
      return (
        <del>
          <TokenList tokens={t.tokens} />
        </del>
      );
    case "codespan":
      return <code>{t.text}</code>;
    case "br":
      return <br />;
    case "link": {
      const destination = t.autolink ? undefined : localLink(t.href);
      return destination
        ? (
          <a
            href={destination.href}
            class={destination.target === "request"
              ? "message-case-link"
              : undefined}
          >
            <TokenList tokens={t.tokens} />
          </a>
        )
        : <>{t.raw}</>;
    }
    case "html":
      return t.block ? <p>{t.text.trimEnd()}</p> : <>{t.raw}</>;
    default:
      return <>{token.raw}</>;
  }
}

/**
 * An agent's message as it reads in Markdown, read by marked and built as
 * elements, never as HTML. A link to a Request reads as a chip; a message too
 * long or too deeply nested to read safely stays plain text.
 */
export function MessageText({ text }: { text: string }) {
  const tokens = useMemo(() => lexMessage(text), [text]);
  return tokens ? <TokenList tokens={tokens} /> : <p>{text}</p>;
}

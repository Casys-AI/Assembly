import type { ComponentChildren } from "preact";
import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { since } from "../../../lib/cases/cases.ts";
import {
  crumbs,
  filesHref,
  type FileText,
} from "../../../lib/model/sources/files.ts";
import type { ModelFileLastChange } from "../../../../src/domain/model/records/revision.ts";
import { shortCommit } from "../../../lib/model/revisions/change.ts";
import { revisionInspectionHref } from "../../../lib/model/revisions/api.ts";
import { Problem } from "../../view/Problem.tsx";
import type { SourceTokens } from "../../../../src/domain/model/consultation/source-tokens.ts";
import { sourceTokenSegments } from "../../../lib/model/sources/tokens.ts";
import { useSourceTokens } from "./useSourceTokens.ts";
import { useCodeLines } from "./useCodeLines.ts";

const number = new Intl.NumberFormat("en");

/** What the page needs of an element to put a file where the address says. */
export interface Revealable {
  querySelector(selector: string): Pick<Element, "scrollIntoView"> | null;
  getBoundingClientRect(): Pick<DOMRect, "top">;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/** Brings the line the address points at to the middle of the window. */
export function revealLine(blob: Revealable | null, line: number | null) {
  if (line === null) return false;
  const row = blob?.querySelector(`[data-line="${line}"]`);
  row?.scrollIntoView({ block: "center" });
  return Boolean(row);
}

/**
 * A file opened without a line starts at its top: when the window was left
 * scrolled past it (the last file was read far down), it is brought back.
 */
export function revealTop(blob: Revealable | null, line: number | null) {
  if (line !== null || !blob || blob.getBoundingClientRect().top >= 0) {
    return false;
  }
  blob.scrollIntoView({ block: "start" });
  return true;
}

/**
 * One file as plain monospace text, one row a line, each line number a link to
 * that line (the one pointed at is highlighted and brought into view; its own
 * link clears it). Above it, the file's path and the commit that last changed
 * it, which is a link to that commit in Revisions. At most `MAX_SHOWN_LINES`
 * lines are drawn: a longer file shows a window of it and says which, and the
 * window stays put while the lines of it are clicked and cleared.
 */
export function FileBlob(
  {
    entry,
    text,
    line,
    version,
    sourceVersion,
    onRetry,
    now,
    actions,
  }: {
    entry: ModelFileLastChange;
    text: FileText;
    /** The line the address points at, counted from 1. */
    line: number | null;
    /** The version named in the address, if one is: the links keep it. */
    version?: string;
    /** Resolved immutable listing version, including when the URL follows head. */
    sourceVersion?: string;
    onRetry(): void;
    /** For relative dates; the clock when absent. */
    now?: number;
    actions?: ComponentChildren;
  },
) {
  const blob = useRef<HTMLDivElement>(null);
  const sourceText = text.status === "ready" ? text.text : null;
  const rawLines = useMemo(() => sourceText?.split("\n") ?? [], [sourceText]);
  const tokens = useSourceTokens(
    sourceVersion,
    entry.path,
    text.status === "ready" ? text.text : null,
  );
  const drawn = useCodeLines(
    `${version ?? ""}\n${entry.path}`,
    text.status === "ready" ? text.text : null,
    line,
  );
  // The line pointed at, once it is drawn; the top of a file that is opened.
  const lit = drawn && line !== null && line <= drawn.total ? line : null;
  useEffect(() => {
    revealTop(blob.current, line);
  }, [entry.path, version]);
  useEffect(() => {
    revealLine(blob.current, lit);
  }, [entry.path, version, lit, drawn !== null]);

  const { dirs, name } = crumbs(entry.path);
  const change = entry.lastChange;
  return (
    <div class="blob" ref={blob}>
      <div class="blob-head">
        <nav class="crumbs" aria-label="Path">
          {dirs.map((dir, index) => (
            <span key={index}>
              {dir}
              <span class="sep" aria-hidden="true">/</span>
            </span>
          ))}
          <b>{name}</b>
        </nav>
        <ModelContextLink
          class="last"
          href={revisionInspectionHref({
            selection: { kind: "commit", id: change.version },
          })}
          title="Last change to this file"
          // Stated either way: Fresh marks a link to the current path.
          aria-current="false"
        >
          <span class="msg">{change.message}</span>
          <code>{shortCommit(change.version)}</code>
          <time dateTime={change.createdAt}>
            {since(change.createdAt, now)}
          </time>
        </ModelContextLink>
      </div>
      {actions}
      {text.status === "reading" && (
        <p class="rev-empty" role="status">Reading the file…</p>
      )}
      {text.status === "failed" && (
        <div class="blob-problem">
          <Problem problem={text.problem}>
            {text.problem.code === "sources-failed" && (
              <button type="button" class="rev-retry" onClick={onRetry}>
                Try again
              </button>
            )}
          </Problem>
        </div>
      )}
      {drawn && drawn.total === 0 && (
        <p class="rev-empty" data-code="file-empty">This file is empty.</p>
      )}
      {drawn && drawn.total > drawn.lines.length && (
        <p
          class="blob-note"
          data-code="file-windowed"
          title="The page draws a window of a long file"
        >
          <span>
            Lines {number.format(drawn.first)}–{number.format(
              drawn.first + drawn.lines.length - 1,
            )} of {number.format(drawn.total)}
          </span>
          {drawn.first > 1 && (
            // Line 1 brings the window back to the top: with no line, a
            // window left far down the file would stay where it is.
            <ModelContextLink
              href={filesHref({ version, file: entry.path, line: 1 })}
            >
              First lines
            </ModelContextLink>
          )}
        </p>
      )}
      {drawn && drawn.lines.length > 0 && (
        <div class="code" role="group" aria-label={`Text of ${entry.path}`}>
          {drawn.lines.map((content, index) => {
            const at = drawn.first + index;
            return (
              <div
                key={at}
                class={at === lit ? "hl" : undefined}
                data-line={at}
              >
                <ModelContextLink
                  class="ln"
                  href={filesHref({
                    version,
                    file: entry.path,
                    line: at === lit ? null : at,
                  })}
                  aria-label={`Line ${at}`}
                  title={at === lit ? "Clear the line" : "Link to this line"}
                  aria-current={at === lit ? "location" : "false"}
                >
                  {at}
                </ModelContextLink>
                <SourceLine
                  content={content}
                  rawLine={rawLines[at - 1]}
                  line={at - 1}
                  tokens={tokens}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Every segment stays a text child of Preact, never generated source HTML. */
export function SourceLine(
  { content, rawLine = content, line, tokens }: {
    content: string;
    rawLine?: string;
    line: number;
    tokens: SourceTokens | null;
  },
) {
  return (
    <span>
      {tokens
        ? sourceTokenSegments(content, line, tokens, rawLine).map((
          segment,
          index,
        ) => <span key={index} class={segment.class}>{segment.text}</span>)
        : content}
    </span>
  );
}

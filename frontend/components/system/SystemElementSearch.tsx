import { useEffect, useRef, useState } from "preact/hooks";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import {
  searchBoard,
  searchResultHref,
} from "../../lib/system/board/search.ts";

export function SystemElementSearch({ board, version, locationSearch }: {
  board?: ModelBoard;
  version?: string;
  locationSearch: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        event.key === "/" && !open && board && !event.ctrlKey &&
        !event.metaKey && !event.altKey
      ) {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest(
            "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
          )
        ) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    globalThis.addEventListener?.("keydown", onKey, true);
    return () => globalThis.removeEventListener?.("keydown", onKey, true);
  }, [open, board]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [version, locationSearch]);
  useEffect(() => {
    if (!board) setOpen(false);
  }, [board]);
  const results = board ? searchBoard(board, query) : [];
  if (!board) return null;
  return (
    <div class="system-search" style={{ position: "relative" }}>
      <style>
        {`
        .system-search-trigger { border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; padding: 4px 10px; white-space: nowrap; cursor: pointer; }
        .system-search-trigger:hover, .system-search-trigger[aria-expanded=true] { background: var(--selected); color: var(--ink); }
        .system-search-trigger:disabled { opacity: .5; cursor: default; }
        .system-search kbd { margin-left: .4em; color: var(--muted); font: inherit; }
        @media (max-width: 600px) { .system-search-suffix, .system-search kbd { display: none; } .system-search-trigger { padding-inline: 6px; } }
        .system-search-panel { box-sizing: border-box; border-radius: 10px; box-shadow: 0 8px 24px #0002; font-size: 13px; }
        .system-search-panel input { box-sizing: border-box; width: 100%; margin-top: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); font: inherit; }
        .system-search-panel ul { list-style: none; margin: 8px 0 0; padding: 0; }
        .system-search-panel a { display: block; min-width: 0; padding: 7px 8px; border-radius: 6px; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
        .system-search-panel a:hover, .system-search-panel a:focus-visible { background: var(--selected); }
        .system-search-panel small { display: block; color: var(--muted); overflow-wrap: anywhere; }
        .system-search-panel p { color: var(--muted); }
      `}
      </style>
      <button
        class="system-search-trigger"
        aria-label="Search System"
        ref={button}
        type="button"
        disabled={!board}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="system-element-search"
      >
        Search<span class="system-search-suffix">&#32;System</span>{" "}
        <kbd aria-hidden="true">/</kbd>
      </button>
      {open && board && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            zIndex: 20,
            width: "min(18rem, calc(100vw - 2rem))",
            maxHeight: "60vh",
            overflow: "auto",
            padding: "1rem",
            background: "var(--card)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
          }}
          class="system-search-panel"
          id="system-element-search"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
          role="search"
          aria-label="Search System elements"
        >
          <label>
            Search elements{" "}
            <input
              ref={input}
              type="search"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {query.trim() && (results.length
            ? (
              <ul>
                {results.map((element) => (
                  <li key={element.id}>
                    <a
                      href={searchResultHref(element, version, locationSearch)}
                      onClick={() => setOpen(false)}
                    >
                      {element.title}
                      {element.qname && <small>{element.qname}</small>}
                    </a>
                  </li>
                ))}
              </ul>
            )
            : <p role="status">No match</p>)}
        </div>
      )}
    </div>
  );
}

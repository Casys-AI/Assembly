import { useEffect, useRef, useState } from "preact/hooks";
import { useOutsidePress } from "../view/useOutsidePress.ts";

const notYet = "Not available yet";

/**
 * The application menu of the top bar: global actions, present and to come.
 * Reading the model provider grants nothing; unavailable actions stay visible
 * and disabled so the place of each one is already known.
 */
export function AppMenu(
  { systemName, version, provider }: {
    systemName: string;
    version: string;
    provider?: string;
  },
) {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open && !about) return;
    // The first control takes the focus, so Escape reaches this menu first.
    area.current?.querySelector<HTMLElement>(
      open ? ".app-menu-list button" : ".app-about button",
    )?.focus();
  }, [open, about]);
  useOutsidePress(area, () => {
    setOpen(false);
    setAbout(false);
  }, open || about);
  function close() {
    setOpen(false);
    setAbout(false);
    trigger.current?.focus();
  }
  return (
    <div
      class="app-menu"
      ref={area}
      onFocusOut={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !area.current?.contains(event.relatedTarget)
        ) {
          setOpen(false);
          setAbout(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (open || about)) {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        class="app-menu-button"
        ref={trigger}
        aria-expanded={open ? "true" : "false"}
        aria-controls="app-menu-list"
        onClick={() => {
          setAbout(false);
          setOpen(!open);
        }}
      >
        Assembly
      </button>
      {open && (
        <div class="app-menu-list" id="app-menu-list">
          <button
            type="button"
            onClick={() => {
              // Keep focus inside while replacing the focused menu action.
              trigger.current?.focus();
              setOpen(false);
              setAbout(true);
            }}
          >
            About Assembly
          </button>
          <p class="app-menu-info">
            <span>Model provider</span>
            <span>{provider || "Unknown"}</span>
          </p>
          <hr />
          <button type="button" disabled title={notYet}>Switch system…</button>
          <button type="button" disabled title={notYet}>Settings…</button>
        </div>
      )}
      {about && (
        <div class="app-about" role="dialog" aria-label="About Assembly">
          <h2>Assembly</h2>
          <p>By Casys. Agentic systems engineering workbench.</p>
          <dl>
            <dt>System</dt>
            <dd>{systemName}</dd>
            <dt>Model</dt>
            <dd>{version}</dd>
            <dt>Model provider</dt>
            <dd>{provider || "Unknown"}</dd>
          </dl>
          <button type="button" onClick={close}>Done</button>
        </div>
      )}
    </div>
  );
}

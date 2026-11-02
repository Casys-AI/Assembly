import type { Ref, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  dockPile,
  dockSlots,
  followsLink,
  monogram,
} from "../../lib/workbench/desk.ts";

/**
 * Work in progress on the left of the logo: an open Case (#N), or, on a backend
 * without Cases, an operator conversation. Selecting it grants nothing.
 */
export interface DockWork {
  kind: "case" | "agent";
  id: string;
  name: string;
  /** The tile's few characters: "#N" for a Case, a monogram for an agent. */
  tile?: string;
  caseType?: "request" | "job" | "watch";
  href: string;
  busy: boolean;
  pending: boolean;
  active: boolean;
  /** A recently closed Case stays in reach, dimmed. */
  closed?: boolean;
  /** Pinned: it stands next to the Requests button and never piles. */
  pinned?: boolean;
  /** One line under the name in a stack: schedule, next wake, last result. */
  detail?: string;
}

/** A persistent place at the end of the Dock: System, Model or To decide. */
export interface DockPlace {
  id: "system" | "model" | "decide";
  label: string;
  href: string;
  pending: boolean;
  active: boolean;
  /** How many points wait in the place, shown on its tile; To decide has one. */
  count?: number;
  /** The selected conversation supplies context, not execution authority. */
  context?: { name: string; tint: "designer" | "request" };
}

/** Jobs or Watches: one Dock button that unfolds them as a vertical list. */
export interface DockStackGroup {
  id: "jobs" | "watches";
  label: string;
  items: readonly DockWork[];
  /** Said in the unfolded list when there is nothing yet. */
  empty: string;
}

export interface DockProps {
  /** Work in arrival order: the first item sits next to the logo, new ones go left. */
  work: readonly DockWork[];
  /** Jobs and Watches, on the right of the logo before the places. */
  stacks?: readonly DockStackGroup[];
  /**
   * The Requests page, next to the logo on the left, before pinned Cases.
   * `onNavigate` runs when the link is followed in this tab.
   */
  cases?: { href: string; active: boolean; onNavigate?(): void };
  places: readonly DockPlace[];
  central: { name: string; busy: boolean; pending: boolean };
  talking: boolean;
  onTalk(): void;
  /** Keep the model page open when selecting Designer. */
  designerHref?: string;
  circleRef?: Ref<HTMLElement>;
}

/** The keyboard shortcut that moves the focus to the logo. */
export const DOCK_SHORTCUT = "Control+Shift+D";

export function describe(name: string, busy: boolean, pending: boolean) {
  return [name, busy && "working", pending && "decision waiting"]
    .filter(Boolean).join(", ");
}

/** A place's name for assistive technology: what waits in it, or its count. */
const placeLabel = (place: DockPlace) =>
  place.count === undefined
    ? describe(place.label, false, place.pending)
    : `${place.label}, ${place.count} pending`;

const casesIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9" />
  </svg>
);

const stackIcons = {
  jobs: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  watches: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  ),
};

const placeIcons = {
  system: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="3" y="15.5" width="7" height="5" rx="1.5" />
      <rect x="14" y="15.5" width="7" height="5" rx="1.5" />
      <path d="M12 8.5v3.5H6.5v3.5M12 12h5.5v3.5" />
    </svg>
  ),
  model: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="7" cy="5.5" r="2.3" />
      <circle cx="7" cy="18.5" r="2.3" />
      <circle cx="17" cy="8.5" r="2.3" />
      <path d="M7 7.8v8.4M17 10.8v.7a5 5 0 0 1-5 5H7.2" />
    </svg>
  ),
  decide: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z" />
      <path d="M4 13.5h4.5l1 2h5l1-2H20" />
    </svg>
  ),
};

/** The Casys mark: the site's solid disc, cropped to fill the button. */
function CasysLogo() {
  return (
    <svg
      class="dock-logo"
      viewBox="69.5 69.5 236 236"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="187.5" cy="187.5" r="118" fill="#a48ea4" />
    </svg>
  );
}

/** Read the real left-hand track without counting the fixed Requests link as work. */
export function useDockSlots(
  dock: RefObject<HTMLElement>,
  hasCases: boolean,
  designerLink: boolean,
  beforeChange?: (previous: number, next: number) => void,
): number {
  const [slots, setSlots] = useState(Infinity);
  const slotsRef = useRef(Infinity);
  const beforeChangeRef = useRef(beforeChange);
  beforeChangeRef.current = beforeChange;
  useLayoutEffect(() => {
    const element = dock.current;
    const circle = element?.querySelector<HTMLElement>(".dock-circle");
    const casesLink = element?.querySelector<HTMLElement>("#cases-link");
    if (!element || !circle) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const style = getComputedStyle(element);
      const gap = parseFloat(style.getPropertyValue("--dock-gap")) || 14;
      const tile = parseFloat(style.getPropertyValue("--dock-tile")) || 50;
      const left = element.getBoundingClientRect().left +
        (parseFloat(style.paddingLeft) || 0);
      const circleLeft = circle.getBoundingClientRect().left;
      const fixedCasesWidth = casesLink
        ? casesLink.getBoundingClientRect().width + gap
        : 0;
      const room = Math.max(0, circleLeft - left - gap - fixedCasesWidth);
      const next = dockSlots({ room, tile, gap });
      if (slotsRef.current !== next) {
        beforeChangeRef.current?.(slotsRef.current, next);
        slotsRef.current = next;
        setSlots(next);
      }
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(circle);
    if (casesLink) observer?.observe(casesLink);
    globalThis.addEventListener("resize", measure);
    measure();
    return () => {
      active = false;
      observer?.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [dock, hasCases, designerLink]);
  return slots;
}

interface DockResizeFocus {
  readonly previous: Element;
  readonly expectedSlots: number;
  readonly work: { kind: "case" | "agent"; id: string } | null;
}

/** Capture only existing keyboard focus in the work list, before reparenting. */
export function captureDockResizeFocus(
  dock: HTMLElement,
  work: readonly DockWork[],
  oldSlots: number,
  nextSlots: number,
): DockResizeFocus | null {
  const active = document.activeElement;
  if (!active || !dock.contains(active) || !active.closest(".dock-work")) {
    return null;
  }
  const item = active.closest("[data-case-id], [data-agent-id]");
  if (item) {
    const caseId = item.getAttribute("data-case-id");
    const agentId = item.getAttribute("data-agent-id");
    return {
      previous: active,
      expectedSlots: nextSlots,
      work: caseId !== null
        ? { kind: "case", id: caseId }
        : agentId !== null
        ? { kind: "agent", id: agentId }
        : null,
    };
  }
  if (!active.closest("[data-dock-work-pile]")) return null;
  const { pile } = dockWorkLayout(work, oldSlots);
  const target = pile.at(-1) ?? work[0];
  return {
    previous: active,
    expectedSlots: nextSlots,
    work: target ? { kind: target.kind, id: target.id } : null,
  };
}

/** Restore only when reparenting actually removed the focused node. */
export function restoreDockResizeFocus(
  dock: HTMLElement,
  focus: DockResizeFocus,
): void {
  if (
    focus.previous.isConnected ||
    document.activeElement && document.activeElement !== document.body
  ) return;
  const candidates = dock.querySelectorAll<HTMLElement>(
    ".dock-work [data-case-id], .dock-work [data-agent-id]",
  );
  const target = [...candidates].find((item) =>
    focus.work &&
    item.getAttribute(
        focus.work.kind === "case" ? "data-case-id" : "data-agent-id",
      ) === focus.work.id
  );
  (target ??
    dock.querySelector<HTMLElement>(".dock-work [data-dock-work-pile]"))
    ?.focus();
}

/**
 * The desk Dock, always shown below the workspace: the Casys logo floats at the
 * exact centre, Requests float on its left (newest leftmost), and the right
 * holds Jobs and Watches, then the persistent places: System, Model and To
 * decide, which counts what waits for the person.
 */
export function Dock(
  {
    work,
    stacks = [],
    cases,
    places,
    central,
    talking,
    onTalk,
    circleRef,
    designerHref,
  }: DockProps,
) {
  const dock = useRef<HTMLElement>(null);
  const resizeFocus = useRef<DockResizeFocus | null>(null);
  const slots = useDockSlots(
    dock,
    Boolean(cases),
    Boolean(designerHref),
    (before, after) => {
      resizeFocus.current = dock.current
        ? captureDockResizeFocus(dock.current, work, before, after)
        : null;
    },
  );
  useLayoutEffect(() => {
    const focus = resizeFocus.current;
    if (!focus || focus.expectedSlots !== slots || !dock.current) return;
    resizeFocus.current = null;
    restoreDockResizeFocus(dock.current, focus);
  }, [slots, work]);
  useEffect(() => {
    const element = dock.current;
    if (!element) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        element.querySelector<HTMLElement>(".dock-circle")?.focus();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  return (
    <nav
      class="dock"
      aria-label={`Dock (${DOCK_SHORTCUT})`}
      ref={dock}
    >
      <div class="dock-group dock-work">
        <DockWorkList work={work} slots={slots} />
        {cases && (
          <a
            class={`dock-item dock-place dock-cases dock-pile${
              cases.active ? " is-active" : ""
            }`}
            id="cases-link"
            href={cases.href}
            onClick={(event) => followsLink(event) && cases.onNavigate?.()}
            aria-label="Requests"
            aria-current={cases.active ? "page" : undefined}
          >
            <span class="dock-tile" aria-hidden="true">{casesIcon}</span>
            <span class="dock-label" aria-hidden="true">Requests</span>
          </a>
        )}
      </div>
      {designerHref
        ? (
          <a
            class={`dock-circle${talking ? " is-open" : ""}${
              central.busy ? " is-busy" : ""
            }`}
            href={designerHref}
            aria-label={`Talk to ${central.name}`}
            ref={circleRef as Ref<HTMLAnchorElement>}
            aria-keyshortcuts={DOCK_SHORTCUT}
            aria-describedby={central.pending
              ? "dock-circle-status"
              : undefined}
          >
            <CasysLogo />
            {central.pending && (
              <span class="dock-circle-badge" aria-hidden="true" />
            )}
            <span class="dock-label" aria-hidden="true">{central.name}</span>
          </a>
        )
        : (
          <button
            type="button"
            class={`dock-circle${talking ? " is-open" : ""}${
              central.busy ? " is-busy" : ""
            }`}
            ref={circleRef as Ref<HTMLButtonElement>}
            aria-label={`Talk to ${central.name}`}
            aria-keyshortcuts={DOCK_SHORTCUT}
            aria-expanded={talking ? "true" : "false"}
            aria-controls="chat-panel"
            aria-describedby={central.pending
              ? "dock-circle-status"
              : undefined}
            onClick={onTalk}
          >
            <CasysLogo />
            {central.pending && (
              <span class="dock-circle-badge" aria-hidden="true" />
            )}
            <span class="dock-label" aria-hidden="true">{central.name}</span>
          </button>
        )}
      {central.pending && (
        <span class="sr-only" id="dock-circle-status">
          A decision is waiting
        </span>
      )}
      <div class="dock-group dock-rest">
        {stacks.length > 0 && (
          <ul class="dock-list" aria-label="Jobs and watches">
            {stacks.map((stack) => <DockStack key={stack.id} stack={stack} />)}
          </ul>
        )}
        <span class="dock-separator" aria-hidden="true" />
        <ul class="dock-list" aria-label="Places">
          {places.map((place) => (
            <li key={place.id} class="dock-slot">
              <a
                class={`dock-item dock-place${
                  place.active ? " is-active" : ""
                }${
                  place.context
                    ? ` has-context is-context-${place.context.tint}`
                    : ""
                }`}
                id={`${place.id}-link`}
                href={place.href}
                aria-label={place.context
                  ? `${placeLabel(place)}, ${place.context.name}`
                  : placeLabel(place)}
                title={place.context
                  ? `${place.label} · ${place.context.name}`
                  : undefined}
                aria-current={place.active ? "page" : undefined}
              >
                <span class="dock-tile" aria-hidden="true">
                  {placeIcons[place.id]}
                  {/* The Main is the place's default: only a Case is marked. */}
                  {place.context?.tint === "request" && (
                    <span class="dock-context-badge">
                      {monogram(
                        place.context.name.replace(
                          /^(?:Request|Job|Watch) · /,
                          "",
                        ),
                      )}
                    </span>
                  )}
                </span>
                {place.pending && (
                  <span
                    class="dock-badge"
                    aria-hidden="true"
                  />
                )}
                {!!place.count && (
                  <span class="decisions-count" aria-hidden="true">
                    {place.count}
                  </span>
                )}
                <span class="dock-label" aria-hidden="true">
                  {place.label}
                  {place.context ? ` · ${place.context.name}` : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

const tileText = (item: DockWork) => item.tile ?? monogram(item.name);
const workData = (item: DockWork) =>
  item.kind === "case"
    ? { "data-case-id": item.id }
    : { "data-agent-id": item.id };

function WorkItem({ item }: { item: DockWork }) {
  return (
    <a
      class={`dock-item${item.active ? " is-active" : ""}${
        item.busy ? " is-busy" : ""
      }${
        item.kind === "case" ? ` is-case is-${item.caseType ?? "request"}` : ""
      }${item.closed ? " is-closed" : ""}${item.pinned ? " is-pinned" : ""}`}
      href={item.href}
      aria-label={`${
        item.closed
          ? `${item.name}, closed`
          : describe(item.name, item.busy, item.pending)
      }${item.pinned ? ", pinned" : ""}`}
      aria-current={item.active ? "page" : undefined}
      {...workData(item)}
    >
      <span class="dock-tile" aria-hidden="true">{tileText(item)}</span>
      {item.pinned && <span class="dock-pin" aria-hidden="true" />}
      {item.pending && <span class="dock-badge" aria-hidden="true" />}
      <span class="dock-label" aria-hidden="true">{item.name}</span>
    </a>
  );
}

/**
 * Where work stands: pinned work next to the Requests button, in pin order,
 * never piled; the rest newest on the left, its oldest sharing one pile
 * between them when the slots run out.
 */
export function dockWorkLayout(work: readonly DockWork[], slots: number) {
  const pinned = work.filter((item) => item.pinned);
  const rest = work.filter((item) => !item.pinned);
  const { piled } = dockPile(rest.length, Math.max(0, slots - pinned.length));
  return { pinned, pile: rest.slice(0, piled), shown: rest.slice(piled) };
}

/**
 * Work tiles, newest on the left. When they do not all fit beside the centred
 * circle, the oldest share one pile, opened as a small list. Pinned work stays
 * next to the Requests button.
 */
export function DockWorkList(
  { work, slots }: { work: readonly DockWork[]; slots: number },
) {
  const { pinned, pile, shown } = dockWorkLayout(work, slots);
  if (!work.length) return null;
  const slot = (item: DockWork) => (
    <li key={`${item.kind}:${item.id}`} class="dock-slot">
      <WorkItem item={item} />
    </li>
  );
  return (
    <ul class="dock-list" aria-label="Work in progress">
      {[...shown].reverse().map(slot)}
      {pile.length > 0 && <DockPile items={pile} />}
      {[...pinned].reverse().map(slot)}
    </ul>
  );
}

function DockPile({ items }: { items: readonly DockWork[] }) {
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node && !area.current?.contains(event.target)
      ) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const pending = items.some((item) => item.pending);
  const active = items.some((item) => item.active);
  const busy = items.some((item) => item.busy);
  const label = `${items.length} earlier`;
  return (
    <li
      class="dock-slot dock-pile"
      ref={area}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          // Close only the pile; the conversation above stays open.
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        data-dock-work-pile=""
        class={`dock-item${active ? " is-active" : ""}${
          busy ? " is-busy" : ""
        }`}
        ref={trigger}
        aria-label={describe(label, busy, pending)}
        aria-expanded={open ? "true" : "false"}
        aria-controls="dock-pile-list"
        onClick={() => setOpen(!open)}
      >
        <span class="dock-tile" aria-hidden="true">+{items.length}</span>
        {pending && <span class="dock-badge" aria-hidden="true" />}
        {!open && <span class="dock-label" aria-hidden="true">{label}</span>}
      </button>
      {open && (
        <ul class="dock-pile-list" id="dock-pile-list" aria-label={label}>
          {[...items].reverse().map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <a
                class={[item.active && "is-active", item.closed && "is-closed"]
                  .filter(Boolean).join(" ") || undefined}
                href={item.href}
                aria-label={item.closed
                  ? `${item.name}, closed`
                  : describe(item.name, item.busy, item.pending)}
                aria-current={item.active ? "page" : undefined}
                {...workData(item)}
                onClick={() =>
                  setOpen(false)}
              >
                <span class="dock-pile-tile" aria-hidden="true">
                  {tileText(item)}
                </span>
                <span class="dock-pile-name">{item.name}</span>
                {item.pending && (
                  <span class="dock-pile-badge" aria-hidden="true" />
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Jobs or Watches behind one button, like a stack in a Mac Dock: it unfolds
 * them vertically, each item opening its page beside the conversation.
 */
function DockStack({ stack }: { stack: DockStackGroup }) {
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node && !area.current?.contains(event.target)
      ) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const { items } = stack;
  const pending = items.some((item) => item.pending);
  const active = items.some((item) => item.active);
  const busy = items.some((item) => item.busy);
  const listId = `dock-${stack.id}-list`;
  const label = items.length ? `${stack.label} (${items.length})` : stack.label;
  return (
    <li
      class="dock-slot dock-pile dock-stack"
      ref={area}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        class={`dock-item dock-place${active ? " is-active" : ""}${
          busy ? " is-busy" : ""
        }`}
        id={`${stack.id}-stack`}
        ref={trigger}
        aria-label={describe(label, busy, pending)}
        aria-expanded={open ? "true" : "false"}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <span class="dock-tile" aria-hidden="true">
          {stackIcons[stack.id]}
        </span>
        {items.length > 0 && (
          <span class="dock-count" aria-hidden="true">{items.length}</span>
        )}
        {pending && <span class="dock-badge" aria-hidden="true" />}
        {!open && <span class="dock-label" aria-hidden="true">{label}</span>}
      </button>
      {open && (
        <div class="dock-pile-list dock-stack-list" id={listId}>
          <p class="dock-stack-title">{stack.label}</p>
          {items.length
            ? (
              <ul aria-label={stack.label}>
                {items.map((item) => (
                  <li key={item.id}>
                    <a
                      class={[
                        item.active && "is-active",
                        item.busy && "is-busy",
                      ]
                        .filter(Boolean).join(" ") || undefined}
                      href={item.href}
                      aria-label={describe(item.name, item.busy, item.pending)}
                      aria-current={item.active ? "page" : undefined}
                      {...workData(item)}
                      onClick={() => setOpen(false)}
                    >
                      <span class="dock-pile-name">{item.name}</span>
                      {item.detail && (
                        <span class="dock-stack-detail">{item.detail}</span>
                      )}
                      {item.pending && (
                        <span class="dock-pile-badge" aria-hidden="true" />
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            )
            : <p class="dock-stack-empty">{stack.empty}</p>}
        </div>
      )}
    </li>
  );
}

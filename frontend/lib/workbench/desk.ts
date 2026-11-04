import type { ElementHome } from "../system/board/lookup.ts";
import { NEW_CASE } from "../cases/cases.ts";
import { pageOf, PLACE_PATH, placeOfPath, viewHref } from "./view-location.ts";

export { PLACE_PATH };

/** The System place's pages shown as tabs, in order; the first is where the place opens. */
export const SYSTEM_TABS = [
  "team",
  "performance",
  "explore",
  "flows",
  "requirements",
  "rights",
  "diagnostics",
] as const;

/** The System place's other pages, which the More menu lists, in order. */
export const SYSTEM_MORE = ["parts", "allocations"] as const;

export const SYSTEM_PAGES = [...SYSTEM_TABS, ...SYSTEM_MORE] as const;
export type SystemPage = typeof SYSTEM_PAGES[number];

/** What each page of the System place is called, on its tab and as its title. */
export const SYSTEM_PAGE_NAMES: Readonly<Record<SystemPage, string>> = {
  team: "Team",
  performance: "Performance",
  explore: "Explore",
  flows: "Flows",
  requirements: "Requirements",
  rights: "Rights",
  diagnostics: "Diagnostics",
  parts: "Parts",
  allocations: "Allocations",
};

/**
 * The pages that show an element as their subject. A concept without a page
 * of its own yet is explored on Explore, which holds every element; its page
 * takes it over when it comes.
 */
const HOME_PAGES: Readonly<Partial<Record<ElementHome, SystemPage>>> = {
  team: "team",
  structure: "parts",
  behavior: "flows",
  requirements: "requirements",
};

/** The page of the System place that is the home of an element. */
export function systemPageFor(home: ElementHome): SystemPage {
  return HOME_PAGES[home] ?? "explore";
}

/** The page of the System place an address opens: `?page=`, else the first. */
export function systemPageOf(url: Pick<URL, "searchParams">): SystemPage {
  return pageOf(url, SYSTEM_PAGES, SYSTEM_PAGES[0]);
}

/**
 * A page of the System place. The first page has the bare address, and
 * `select` names the element the page opens in place.
 */
export function systemHref(
  page: SystemPage = SYSTEM_PAGES[0],
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  return viewHref(PLACE_PATH.system, {
    page: page === SYSTEM_PAGES[0] ? null : page,
    ...params,
  });
}

/** The Model place's pages, in tab order; the first is where the place opens. */
export const MODEL_PAGES = [
  "activity",
  "revisions",
  "files",
  "releases",
  "sysml",
] as const;
/** `graph` is retained only for numeric execution-history links from the chat. */
export type ModelPage = typeof MODEL_PAGES[number] | "graph";

/**
 * The page of the Model place an address opens. `?page=` names it. Without
 * one, a link that names a revision (`?commit=`, `?proposal=`: every link that
 * predates the pages, and the one of a decision) opens Revisions on it, a link
 * that inspects a revision of the graph (`?revision=`, `?modelVersion=`: the
 * links of the page the graph lived on) opens Graph on it, and any other
 * Request branch address opens Files, and any other address opens the first
 * page.
 */
export function modelPageOf(url: Pick<URL, "searchParams">): ModelPage {
  const names = (parameter: string) => url.searchParams.get(parameter);
  const named = names("page");
  if (
    (named === "graph" || !named && !names("commit") && !names("proposal")) &&
    names("revision")
  ) return "graph";
  if (named === "graph") return "sysml";
  return pageOf(
    url,
    MODEL_PAGES,
    names("commit") || names("proposal")
      ? "revisions"
      : names("modelVersion")
      ? "sysml"
      : names("caseBranch")
      ? "files"
      : MODEL_PAGES[0],
  );
}

/**
 * A page of the Model place. The page an address reads without being told
 * (see `modelPageOf`) is not named in it: the first page has the bare address,
 * and a link to a revision keeps its `?commit=` or `?proposal=` alone.
 */
export function modelHref(
  page: ModelPage = MODEL_PAGES[0],
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const given = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value) given.set(name, value);
  }
  const implied = modelPageOf({ searchParams: given });
  return viewHref(PLACE_PATH.model, {
    page: page === implied ? null : page,
    ...params,
  });
}

/** What the desk shows beside the central conversation, or alone when it is closed. */
export type DeskItem =
  /** A Case named by `/chat?case=`: a Request is read on the Requests page. */
  | { kind: "case"; caseId: string }
  /**
   * The Requests page, with the Request it selects when the address names one,
   * and the sub-agent whose messages in that Request it reads; without one, the
   * Release a new Request starts from (`from`).
   */
  | { kind: "cases"; caseId?: string; agentId?: string; startFrom?: string }
  | { kind: "agent"; agentId: string }
  /** The System place and the page of it the address names. */
  | { kind: "system"; page: SystemPage }
  /** The Model place and the page of it the address names. */
  | { kind: "model"; page: ModelPage }
  /** The Activity place: pending decisions, followed by recorded events. */
  | { kind: "activity" };

/**
 * The address of the page that draws the native graph, when the desk shows one:
 * the Model place's Graph page. Inspecting a revision of the graph stays on
 * that address, and leaving it puts the desk back on the present.
 */
export function graphAddress(item: DeskItem | null): string | null {
  return item?.kind === "model" && item.page === "graph"
    ? modelHref("graph")
    : null;
}

export interface DeskLocation {
  /** The view opened from the Dock, if any. */
  item: DeskItem | null;
  /** The address asks for the central conversation. */
  talk: boolean;
  /** The central agent details to reveal with the conversation. */
  details: "tools" | null;
}

/**
 * Read the desk from an address. Fresh owns navigation, so every Dock item is a
 * plain link; the central conversation is a local layer opened by the circle.
 * Until the conversations load, an `agent` parameter is kept as a Dock item.
 */
export function deskLocation(
  url: URL,
  centralAgentId: string | null,
): DeskLocation {
  const none: DeskLocation = { item: null, talk: false, details: null };
  const place = placeOfPath(url.pathname);
  if (place === "system") {
    return { ...none, item: { kind: "system", page: systemPageOf(url) } };
  }
  // Every Request of the system as a list, or one Request and its conversations.
  if (url.pathname === "/cases") {
    const caseId = url.searchParams.get("case");
    const agentId = url.searchParams.get("agent");
    const startFrom = url.searchParams.get("from");
    return {
      ...none,
      item: {
        kind: "cases",
        ...(caseId
          ? { caseId, ...(agentId ? { agentId } : {}) }
          : startFrom
          ? { startFrom }
          : {}),
      },
    };
  }
  if (place === "model") {
    return { ...none, item: { kind: "model", page: modelPageOf(url) } };
  }
  if (place === "activity") return { ...none, item: { kind: "activity" } };
  if (url.pathname !== "/chat" && url.pathname !== "/tools") return none;
  // A Case opens beside the conversation, on the conversation's own address.
  const caseId = url.searchParams.get("case");
  // A Case is its own page; the designer's conversation stays closed. Nothing
  // is selected on the page of a Case not opened yet.
  if (caseId === NEW_CASE) return { ...none, item: { kind: "cases" } };
  if (caseId) return { ...none, item: { kind: "case", caseId } };
  // `/tools` opens the same conversation with its tools shown.
  const details = url.pathname === "/tools" ? "tools" : null;
  const agentId = url.searchParams.get("agent");
  return agentId && agentId !== centralAgentId
    ? { item: { kind: "agent", agentId }, talk: false, details }
    : { item: null, talk: true, details };
}

export function conversationHref(agentId?: string | null): string {
  const query = new URLSearchParams();
  if (agentId) query.set("agent", agentId);
  return `/chat${query.size ? `?${query}` : ""}`;
}

/** A click that follows its link in this tab: not a new tab or a new window. */
export function followsLink(
  event: Pick<
    MouseEvent,
    | "button"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
    | "shiftKey"
    | "defaultPrevented"
  >,
): boolean {
  return event.button === 0 && !event.defaultPrevented && !event.altKey &&
    !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/** One or two letters that tell Dock tiles apart without inventing icons. */
export function monogram(name: string): string {
  const [first, second] = (name.match(/[\p{L}\p{N}]+/gu) ?? []).map((
    word,
  ) => [...word]);
  if (!first) return "?";
  if (second) return (first[0] + second[0]).toLocaleUpperCase();
  return first[0].toLocaleUpperCase() + (first[1] ?? "").toLocaleLowerCase();
}

/**
 * Work in arrival order, oldest first, by the rank each conversation received
 * when it first appeared. A rank never changes, so a shown tile never moves;
 * the catalogue may insert a new thread before older ones without effect.
 */
export function arrivalOrder<T extends { agentId: string }>(
  conversations: readonly T[],
  arrivals: ReadonlyMap<string, number>,
): T[] {
  return conversations
    .map((entry, index) => ({
      entry,
      index,
      rank: arrivals.get(entry.agentId) ?? Infinity,
    }))
    .sort((a, b) => (a.rank - b.rank) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** How many work tiles fit in `room`, the width left of the centred logo. */
export function dockSlots(
  measure: { room: number; tile: number; gap: number },
): number {
  return Math.max(
    1,
    Math.floor((measure.room + measure.gap) / (measure.tile + measure.gap)),
  );
}

/** When work does not fit, the oldest items share one pile next to the circle. */
export function dockPile(count: number, slots: number) {
  const piled = count > slots ? count - Math.max(0, slots - 1) : 0;
  return { piled, shown: count - piled };
}

/**
 * The address of a page inside a place: `?page=<page>` names the page and
 * `?select=<id>` the element it opens in place, in the same style as `?case=`
 * and `?commit=`; `?flow=<id>` the flow or lifecycle the Flows page reads; a
 * file of the model is `?file=` and `?line=`, read at `?version=` or at the
 * admitted head. Fresh owns navigation, so every page is
 * a plain link.
 */

/**
 * Where the places live, and the only table that spells their paths. System
 * opens on its Team page; Model is the versioned model; To decide is
 * `/decide`. The paths an old link may still carry are `PLACE_ALIASES`.
 */
export const PLACE_PATH = {
  system: "/system",
  model: "/model",
  decide: "/decide",
} as const;

export type PlaceId = keyof typeof PLACE_PATH;

/**
 * Addresses that open a place without being its path. `/revisions` was the
 * Model place before it took `/model` (the links of a decision, a commit, a
 * bookmark): it keeps opening it, with its query.
 */
export const PLACE_ALIASES: Readonly<Record<string, PlaceId>> = {
  "/revisions": "model",
};

/** The place a path opens, by its own path or by an alias; none otherwise. */
export function placeOfPath(pathname: string): PlaceId | null {
  for (const place of Object.keys(PLACE_PATH) as PlaceId[]) {
    if (PLACE_PATH[place] === pathname) return place;
  }
  return Object.hasOwn(PLACE_ALIASES, pathname)
    ? PLACE_ALIASES[pathname]
    : null;
}

/**
 * The page the address names among a place's `pages`, or `fallback` when it
 * names none or an unknown one: an old link never lands on an empty page.
 */
export function pageOf<Page extends string>(
  url: Pick<URL, "searchParams">,
  pages: readonly Page[],
  fallback: Page,
): Page {
  const named = url.searchParams.get("page");
  return pages.find((page) => page === named) ?? fallback;
}

/** The element the address opens in place, if it names one. */
export function selectionOf(url: Pick<URL, "searchParams">): string | null {
  return url.searchParams.get("select") || null;
}

/**
 * The flow or lifecycle the address asks the Flows page to read, if it names
 * one; it is read the way the page is told to, so an element the address
 * selects inside another flow wins.
 */
export function flowOf(url: Pick<URL, "searchParams">): string | null {
  return url.searchParams.get("flow") || null;
}

/**
 * The file of the model the address opens, by its path in the model
 * (`?file=a.sysml`, `?file=lib/b.sysml`): never a `sources/` prefix.
 */
export function fileOf(url: Pick<URL, "searchParams">): string | null {
  return url.searchParams.get("file") || null;
}

/**
 * The line of that file the address points at, counted from 1. Anything that
 * is not a positive whole number (`0`, `-3`, `2.5`, `ten`) points at no line.
 */
export function lineOf(url: Pick<URL, "searchParams">): number | null {
  const named = url.searchParams.get("line");
  return named !== null && /^[1-9][0-9]{0,8}$/.test(named)
    ? Number(named)
    : null;
}

/**
 * The version of the model the address asks to read, as written; the page
 * that reads it says whether it is one. None means the admitted head.
 */
export function versionOf(url: Pick<URL, "searchParams">): string | null {
  return url.searchParams.get("version") || null;
}

/**
 * `base` (a path, possibly with a query of its own) with `params` set on it.
 * A parameter given as `null` or `undefined` is removed, so a page link never
 * carries what belongs to another page.
 */
export function viewHref(
  base: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const url = new URL(base, "http://view.invalid");
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  return url.pathname + url.search;
}

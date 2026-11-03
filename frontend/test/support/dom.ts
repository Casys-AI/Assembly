/**
 * Queries over rendered markup, in the spirit of Testing Library: a test finds
 * what the person meets — a role and its name, a label, a text — rather than
 * the tags, classes and attribute order that draw it. The markup is the string
 * the server renders, parsed by happy-dom; nothing is mounted and no global is
 * touched. Each query takes the markup or an element of it:
 *
 *     const page = within(renderToString(<Page />));
 *     page.byRole("heading", { level: 1, name: "Team" });
 *     page.byRole("link", { name: "Team", current: "page" });
 *     within(page.byRole("navigation", { name: "Dock" })).allByRole("link");
 *
 * `byX` finds exactly one element and fails with what is there otherwise;
 * `queryByX` finds one or none; `allByX` finds every match, in page order.
 */
import { Window } from "happy-dom";

/** Markup, or a part of markup already parsed. */
export type Scope = string | ParentNode;
/** A text is equal once its spaces are collapsed, or matches a pattern. */
export type TextMatch = string | RegExp;

export interface RoleOptions {
  /** The accessible name: `aria-label`, its label, its text or its title. */
  name?: TextMatch;
  /** A heading's level, from its tag or `aria-level`. */
  level?: number;
  /** `aria-current`: its value, true for any but "false", false for none. */
  current?: string | boolean;
  /** Include what `hidden` or `aria-hidden="true"` hides from the person. */
  hidden?: boolean;
}

let window: Window | undefined;

/** The markup as a detached fragment: a row or a cell stays as it is drawn. */
export function parse(html: string): ParentNode {
  window ??= new Window({
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      enableCSSFileLoading: false,
      enableImageFileLoading: false,
      enableIframePageLoading: false,
    },
  });
  const template = window.document.createElement("template");
  template.innerHTML = html;
  return template.content as unknown as ParentNode;
}

const root = (scope: Scope): ParentNode =>
  typeof scope === "string" ? parse(scope) : scope;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const matches = (text: string, expected: TextMatch) =>
  typeof expected === "string"
    ? text === squash(expected)
    : expected.test(text);

/**
 * The words of the markup as they read, one space between elements, entities
 * decoded: the one text helper of the tests.
 */
export function textOf(scope: Scope): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parts.push(child.textContent ?? "");
      else if (child.nodeType === 1) {
        if (/^(script|style|template)$/.test((child as Element).localName)) {
          continue;
        }
        parts.push(" ");
        walk(child);
        parts.push(" ");
      }
    }
  };
  walk(root(scope) as unknown as Node);
  return squash(parts.join(""));
}

const HEADING = /^h([1-6])$/;
/** `tag:role` pairs, read once: the roles a tag or an input type implies. */
const pairs = (list: string) =>
  Object.fromEntries(list.split(/\s+/).map((pair) => pair.split(":")));
const INPUT_ROLES: Record<string, string> = pairs(
  "button:button checkbox:checkbox image:button number:spinbutton radio:radio \
range:slider reset:button search:searchbox submit:button",
);
const TAG_ROLES: Record<string, string> = pairs(
  "article:article aside:complementary button:button details:group \
dialog:dialog fieldset:group footer:contentinfo form:form header:banner \
hr:separator li:listitem main:main menu:list nav:navigation ol:list \
option:option output:status progress:progressbar table:table tbody:rowgroup \
td:cell textarea:textbox tfoot:rowgroup thead:rowgroup tr:row ul:list",
);
/** Roles whose name is their content, when nothing else names them. */
const NAMED_BY_CONTENT = new Set(
  "button cell checkbox columnheader heading link menuitem option radio row \
rowheader switch tab treeitem".split(" "),
);

/** The element's role: its `role`, or the one its tag implies. */
export function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (HEADING.test(tag)) return "heading";
  if (tag === "a" || tag === "area") {
    return element.hasAttribute("href") ? "link" : null;
  }
  if (tag === "img") return element.getAttribute("alt") === "" ? null : "img";
  if (tag === "th") {
    return element.getAttribute("scope") === "row"
      ? "rowheader"
      : "columnheader";
  }
  if (tag === "section") {
    return element.hasAttribute("aria-label") ||
        element.hasAttribute("aria-labelledby")
      ? "region"
      : null;
  }
  if (tag === "select") {
    return element.hasAttribute("multiple") ? "listbox" : "combobox";
  }
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return type === "hidden" ? null : INPUT_ROLES[type] ?? "textbox";
  }
  return TAG_ROLES[tag] ?? null;
}

const top = (node: Node): ParentNode => {
  while (node.parentNode) node = node.parentNode;
  return node as unknown as ParentNode;
};

const byId = (element: Element, id: string) =>
  top(element).querySelector(`[id="${id.replaceAll('"', '\\"')}"]`);

const hides = (element: Element) =>
  element.hasAttribute("hidden") ||
  element.getAttribute("aria-hidden") === "true";

const hiddenFromPerson = (element: Element | null): boolean =>
  !!element && (hides(element) || hiddenFromPerson(element.parentElement));

/** What a name made of content reads: hidden parts left out, labels kept. */
function contentName(element: Element): string {
  let text = "";
  for (const child of element.childNodes) {
    if (child.nodeType === 3) text += child.textContent;
    else if (child.nodeType === 1) {
      const part = child as Element;
      if (hides(part)) continue;
      text += ` ${
        part.getAttribute("aria-label") ??
          (part.localName === "img" ? part.getAttribute("alt") ?? "" : null) ??
          contentName(part)
      } `;
    }
  }
  return squash(text);
}

/** The label of a field: `<label for>`, or the label around it. */
function labelOf(element: Element): string {
  const id = element.getAttribute("id");
  const label =
    (id ? top(element).querySelector(`label[for="${id}"]`) : null) ??
      element.closest("label");
  return label ? contentName(label) : "";
}

/** The accessible name, as a screen reader would announce it. */
export function nameOf(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return squash(
      labelledBy.split(/\s+/).map((id) => {
        const target = byId(element, id);
        return target ? contentName(target) : "";
      }).join(" "),
    );
  }
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return squash(label);
  if (/^(input|select|textarea)$/.test(element.localName)) {
    const text = labelOf(element);
    if (text) return text;
  }
  if (element.localName === "img") {
    const alt = element.getAttribute("alt");
    if (alt) return squash(alt);
  }
  const role = roleOf(element);
  if (role && NAMED_BY_CONTENT.has(role)) {
    const text = contentName(element);
    if (text) return text;
  }
  return squash(element.getAttribute("title") ?? "");
}

/** Whether the elements come in this order in the page, each after the last. */
export const inOrder = (...elements: (Element | null)[]): boolean =>
  elements.every((element, index) =>
    element !== null &&
    (index === 0 ||
      !!(elements[index - 1]!.compareDocumentPosition(element) & 4))
  );

const levelOf = (element: Element) =>
  Number(
    element.getAttribute("aria-level") ??
      HEADING.exec(element.localName)?.[1] ?? NaN,
  );

export function allByRole(
  scope: Scope,
  role: string,
  options: RoleOptions = {},
): Element[] {
  const { name, level, current, hidden = false } = options;
  return [...root(scope).querySelectorAll("*")].filter((element) => {
    if (roleOf(element) !== role) return false;
    if (!hidden && hiddenFromPerson(element)) return false;
    if (level !== undefined && levelOf(element) !== level) return false;
    if (current !== undefined) {
      const value = element.getAttribute("aria-current");
      const on = value !== null && value !== "false";
      if (typeof current === "boolean" ? on !== current : value !== current) {
        return false;
      }
    }
    return name === undefined || matches(nameOf(element), name);
  });
}

/** Every element whose own words match, the innermost when they nest. */
export function allByText(scope: Scope, text: TextMatch): Element[] {
  const found = [...root(scope).querySelectorAll("*")].filter((element) =>
    !/^(script|style|template)$/.test(element.localName) &&
    matches(textOf(element), text)
  );
  return found.filter((element) =>
    !found.some((other) => other !== element && element.contains(other))
  );
}

/** Every field whose label, `aria-label` or `aria-labelledby` matches. */
export function allByLabel(scope: Scope, label: TextMatch): Element[] {
  return [
    ...root(scope).querySelectorAll(
      "input, select, textarea, [aria-label], [aria-labelledby]",
    ),
  ].filter((element) => matches(nameOf(element), label));
}

const phrase = (role: string, options: RoleOptions) =>
  `role ${role}${
    Object.keys(options).length
      ? ` ${
        JSON.stringify(options, (_, v) => v instanceof RegExp ? `${v}` : v)
      }`
      : ""
  }`;

function single<A extends unknown[]>(
  all: (scope: Scope, ...args: A) => Element[],
  what: (...args: A) => string,
) {
  const query = (scope: Scope, ...args: A): Element | null => {
    const found = all(scope, ...args);
    if (found.length > 1) {
      throw new Error(`${found.length} elements for ${what(...args)}`);
    }
    return found[0] ?? null;
  };
  const get = (scope: Scope, ...args: A): Element => {
    const parsed = root(scope);
    const found = query(parsed, ...args);
    if (found) return found;
    const seen = allByRole(parsed, "heading").concat(
      allByRole(parsed, "button"),
      allByRole(parsed, "link"),
    ).map((element) => `${roleOf(element)} "${nameOf(element)}"`);
    throw new Error(
      `nothing for ${what(...args)}; among: ${seen.join(", ") || "nothing"}`,
    );
  };
  return [get, query] as const;
}

export const [byRole, queryByRole] = single(
  allByRole,
  (role: string, options: RoleOptions = {}) => phrase(role, options),
);
export const [byText, queryByText] = single(
  allByText,
  (text: TextMatch) => `text ${text}`,
);
export const [byLabel, queryByLabel] = single(
  allByLabel,
  (label: TextMatch) => `label ${label}`,
);

/** The queries, bound to one part of the page: the markup is parsed once. */
export function within(scope: Scope) {
  const at = root(scope);
  return {
    root: at,
    byRole: (role: string, options?: RoleOptions) => byRole(at, role, options),
    queryByRole: (role: string, options?: RoleOptions) =>
      queryByRole(at, role, options),
    allByRole: (role: string, options?: RoleOptions) =>
      allByRole(at, role, options),
    byText: (text: TextMatch) => byText(at, text),
    queryByText: (text: TextMatch) => queryByText(at, text),
    allByText: (text: TextMatch) => allByText(at, text),
    byLabel: (label: TextMatch) => byLabel(at, label),
    queryByLabel: (label: TextMatch) => queryByLabel(at, label),
    allByLabel: (label: TextMatch) => allByLabel(at, label),
  };
}

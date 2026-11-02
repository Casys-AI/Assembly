/**
 * The markup as the page means it. The renderer leaves a space where it skips
 * a `key` or a `ref`, and a `;` at the end of a style: neither says anything
 * about the page, and a test that asserts the markup should not spell them.
 * What is inside a quoted value (a title on several lines) is left as it is.
 */
export function tidy(html: string): string {
  return html
    .replace(
      /<([a-z][a-z0-9]*)((?:\s[^<>]*)?)>/g,
      (_, tag: string, attributes: string) =>
        `<${tag}${
          attributes
            .replace(
              /("[^"]*")|\s+/g,
              (_whole, quoted?: string) => quoted ?? " ",
            )
            .replace(/ $/, "")
        }>`,
    )
    .replace(/style="([^"]*?);"/g, 'style="$1"');
}

const VOID = new Set([
  "br",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "wbr",
  "col",
]);

/**
 * For each element named `tag` in the markup, the names of its direct
 * children, in order: what a list holds, or a table body. A test that says
 * "this is never a direct child of the list" reads it from here.
 */
export function childrenOf(html: string, tag: string): string[][] {
  const open: { name: string; children: string[] }[] = [];
  const found: string[][] = [];
  for (
    const [, closing, name] of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)
  ) {
    if (closing) {
      const done = open.pop();
      if (done?.name === tag) found.push(done.children);
    } else if (!VOID.has(name)) {
      open.at(-1)?.children.push(name);
      open.push({ name, children: [] });
    } else open.at(-1)?.children.push(name);
  }
  return found;
}

/** How many details are open in the markup: one at a time is the rule of the pages. */
export const asides = (html: string): number =>
  (html.match(/<aside /g) ?? []).length;

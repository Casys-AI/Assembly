import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  allByRole,
  allByText,
  byLabel,
  byRole,
  byText,
  inOrder,
  nameOf,
  queryByRole,
  roleOf,
  textOf,
  within,
} from "./dom.ts";

Deno.test("the text of markup reads as words: a space between elements, entities decoded, no script", () => {
  equal(
    textOf(
      "<p>Tools <b>web</b></p><p>1 &amp; 2 &quot;x&quot;</p><script>no</script>",
    ),
    'Tools web 1 & 2 "x"',
  );
  // A `>` inside a value is no end of tag.
  equal(textOf('<a title="a > b" href="/x">x</a>'), "x");
  equal(textOf(byRole("<ul><li>a</li><li> b\n c </li></ul>", "list")), "a b c");
});

Deno.test("roles come from the tag unless the markup names one", () => {
  const roles = (html: string) =>
    [...within(html).root.querySelectorAll("*")].map(roleOf);
  deepStrictEqual(
    roles(
      '<a href="/">x</a><a>y</a><h2>t</h2><nav></nav><section></section><section aria-label="S"></section><output></output><input><input type="checkbox"><th></th><div role="status alert"></div>',
    ),
    [
      "link",
      null,
      "heading",
      "navigation",
      null,
      "region",
      "status",
      "textbox",
      "checkbox",
      "columnheader",
      "status",
    ],
  );
  // A row and its cell stay what they are drawn as.
  equal(byRole("<tr><td>a</td></tr>", "cell").textContent, "a");
});

Deno.test("the name is aria-labelledby, aria-label, a label, the content for links and buttons, then the title", () => {
  const page = within(
    `<span id="n">Named</span><nav aria-labelledby="n"></nav>
     <a href="/s" aria-label="System, Main Operator"><svg aria-hidden="true"></svg>System</a>
     <button><span aria-hidden="true">×</span> Close <i aria-label="now"></i></button>
     <label for="f">Field</label><input id="f"><label>Around <select></select></label>
     <p title="Tip">Body</p><h1>Team</h1>`,
  );
  equal(nameOf(page.byRole("navigation")), "Named");
  equal(nameOf(page.byRole("link")), "System, Main Operator");
  equal(nameOf(page.byRole("button")), "Close now");
  equal(nameOf(page.byRole("textbox")), "Field");
  equal(nameOf(page.byRole("combobox")), "Around");
  equal(nameOf(page.root.querySelector("p")!), "Tip");
  equal(page.byRole("heading", { name: "Team" }).localName, "h1");
});

Deno.test("a role is found by its name, its level and aria-current, and what is hidden is left out", () => {
  const html = `<nav aria-label="Tabs"><a href="/a" aria-current="page">A</a>
    <a href="/b" aria-current="false">B</a></nav><h1>One</h1><h2>Two</h2>
    <section id="p" aria-label="Panel" hidden><h1>Hidden</h1></section>
    <span aria-hidden="true"><a href="/c">C</a></span>`;
  equal(byRole(html, "link", { current: "page" }).textContent, "A");
  equal(byRole(html, "link", { current: false }).textContent, "B");
  equal(byRole(html, "heading", { level: 2 }).textContent, "Two");
  equal(byRole(html, "heading", { name: /^O/ }).textContent, "One");
  deepStrictEqual(allByRole(html, "link").map(textOf), ["A", "B"]);
  equal(allByRole(html, "link", { hidden: true }).length, 3);
  equal(queryByRole(html, "region"), null);
  equal(byRole(html, "region", { hidden: true }).id, "p");
});

Deno.test("one element or a failure that says what is there", () => {
  const html = '<button>Save</button><button>Undo</button><a href="/">Home</a>';
  throws(
    () => byRole(html, "button", { name: "Close" }),
    /nothing for role button \{"name":"Close"\}; among: button "Save", button "Undo", link "Home"/,
  );
  throws(() => byRole(html, "button"), /2 elements for role button/);
  equal(queryByRole(html, "button", { name: /^S/ })?.textContent, "Save");
});

Deno.test("a text finds the innermost element whose words match", () => {
  const html = "<div><p>Reading <b>the</b> system…</p><p>Other</p></div>";
  equal(byText(html, "Reading the system…").localName, "p");
  deepStrictEqual(allByText(html, /\bthe\b/).map((e) => e.localName), ["b"]);
  throws(() => byText(html, "Missing"), /nothing for text Missing/);
});

Deno.test("a field is found by its label, wherever the label is", () => {
  const html =
    '<label for="q">Search</label><input id="q"><textarea aria-label="Message"></textarea>';
  equal(byLabel(html, "Search").id, "q");
  equal(byLabel(html, /mess/i).localName, "textarea");
});

Deno.test("within scopes every query to a part of the page", () => {
  const page = within(
    '<nav aria-label="Dock"><a href="/s">System</a></nav><main><a href="/x">X</a></main>',
  );
  const dock = within(page.byRole("navigation", { name: "Dock" }));
  deepStrictEqual(dock.allByRole("link").map(nameOf), ["System"]);
  equal(page.allByRole("link").length, 2);
});

Deno.test("elements are in order when each follows the one before it", () => {
  const page = within(
    "<a href='/1'>1</a><p><a href='/2'>2</a></p><a href='/3'>3</a>",
  );
  const [one, two, three] = page.allByRole("link");
  equal(inOrder(one, two, three), true);
  equal(inOrder(one, three, two), false);
  equal(inOrder(one, null), false);
});

import { deepStrictEqual, equal } from "node:assert/strict";
import { asides, childrenOf, tidy } from "./markup.ts";

Deno.test("the markup is tidied as the page means it: no space where the renderer skipped a key, no last ; in a style", () => {
  equal(tidy('<div  class="a"  >x</div>'), '<div class="a">x</div>');
  equal(tidy("<li   >x</li>"), "<li>x</li>");
  equal(
    tidy('<a  href="/x"   aria-label="y" >z</a>'),
    '<a href="/x" aria-label="y">z</a>',
  );
  equal(
    tidy('<i style="width:4px;height:2px;"></i>'),
    '<i style="width:4px;height:2px"></i>',
  );
  // Spaces and lines inside a quoted value, and between tags, are the page's.
  equal(tidy('<a title="a\nb  c">x  y</a>'), '<a title="a\nb  c">x  y</a>');
  equal(tidy("<p>a   b</p>"), "<p>a   b</p>");
});

Deno.test("the direct children of an element are read from the markup, not its descendants", () => {
  const html =
    '<ul class="a"><li>1<ul><li>x</li></ul></li><aside>no</aside><li>2<br></li></ul><ul></ul>';
  // Inner lists close first.
  deepStrictEqual(childrenOf(html, "ul"), [["li"], ["li", "aside", "li"], []]);
  deepStrictEqual(childrenOf(html, "li"), [[], ["ul"], ["br"]]);
  deepStrictEqual(childrenOf("<p>no list</p>", "ul"), []);
});

Deno.test("the details open in the markup are counted, whatever else is on the page", () => {
  equal(asides("<div>no detail</div>"), 0);
  equal(
    asides(
      '<li><aside class="detail">a</aside></li><aside class="detail">b</aside>',
    ),
    2,
  );
  // A word that only starts like one is no detail.
  equal(asides("<aside-menu>x</aside-menu><asides>y</asides>"), 0);
});

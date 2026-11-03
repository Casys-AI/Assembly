import { equal } from "node:assert/strict";
import {
  fileOf,
  flowOf,
  lineOf,
  pageOf,
  selectionOf,
  versionOf,
  viewHref,
} from "./view-location.ts";

const at = (path: string) => new URL(path, "https://atelier.test");
const pages = ["revisions", "graph"] as const;

Deno.test("?page= names a page of the place, else the fallback", () => {
  equal(pageOf(at("/revisions?page=graph"), pages, "revisions"), "graph");
  equal(pageOf(at("/revisions"), pages, "revisions"), "revisions");
  equal(pageOf(at("/revisions?page=files"), pages, "revisions"), "revisions");
  equal(pageOf(at("/revisions?page="), pages, "revisions"), "revisions");
  // Only the pages listed are pages: no inherited property names one.
  equal(
    pageOf(at("/revisions?page=constructor"), pages, "revisions"),
    "revisions",
  );
  // The first of several values wins, as for every parameter of the app.
  equal(
    pageOf(at("/revisions?page=graph&page=x"), pages, "revisions"),
    "graph",
  );
});

Deno.test("?select= names the element a page opens in place", () => {
  equal(selectionOf(at("/model?select=Pkg%3A%3Aunit")), "Pkg::unit");
  equal(selectionOf(at("/model")), null);
  equal(selectionOf(at("/model?select=")), null);
});

Deno.test("?flow= names the flow or lifecycle the Flows page reads, and is none when empty", () => {
  equal(flowOf(at("/system?page=flows&flow=a%23b")), "a#b");
  equal(flowOf(at("/system?page=flows")), null);
  equal(flowOf(at("/system?page=flows&flow=")), null);
  // The selection is its own parameter.
  equal(flowOf(at("/system?select=x")), null);
});

Deno.test("viewHref sets parameters on a path that may have a query of its own", () => {
  equal(viewHref("/model"), "/model");
  equal(viewHref("/model", { revision: "3" }), "/model?revision=3");
  equal(
    viewHref("/revisions?page=graph", { revision: "3" }),
    "/revisions?page=graph&revision=3",
  );
  // Absent parameters are removed, so a link never carries another page's state.
  equal(viewHref("/revisions?page=graph", { page: null }), "/revisions");
  equal(viewHref("/revisions?commit=a", { commit: undefined }), "/revisions");
  equal(
    viewHref("/revisions", { commit: "commit:abc" }),
    "/revisions?commit=commit%3Aabc",
  );
  // A parameter is replaced, never repeated.
  equal(viewHref("/model?revision=1", { revision: "2" }), "/model?revision=2");
});

Deno.test("?file= names a file of the model by its path, ?version= the version to read it at", () => {
  equal(fileOf(at("/revisions?page=files&file=lib%2Fa.sysml")), "lib/a.sysml");
  equal(fileOf(at("/revisions?page=files")), null);
  equal(fileOf(at("/revisions?page=files&file=")), null);
  const version = `commit:${"a".repeat(40)}`;
  equal(
    versionOf(
      at(`/revisions?page=files&version=${encodeURIComponent(version)}`),
    ),
    version,
  );
  equal(versionOf(at("/revisions?page=files")), null);
  equal(versionOf(at("/revisions?page=files&version=")), null);
  // The address is read as written: whether it is a version is for the page.
  equal(versionOf(at("/revisions?version=main")), "main");
});

Deno.test("?line= is a line counted from 1, and anything else points at no line", () => {
  equal(lineOf(at("/revisions?line=1")), 1);
  equal(lineOf(at("/revisions?line=42")), 42);
  for (
    const bad of [
      "0",
      "-3",
      "2.5",
      "ten",
      "",
      "01",
      "1e3",
      " 4",
      "0x10",
      "1234567890",
    ]
  ) {
    equal(lineOf(at(`/revisions?line=${encodeURIComponent(bad)}`)), null, bad);
  }
  equal(lineOf(at("/revisions")), null);
  // The first of several values wins, as for every parameter of the app.
  equal(lineOf(at("/revisions?line=3&line=9")), 3);
});

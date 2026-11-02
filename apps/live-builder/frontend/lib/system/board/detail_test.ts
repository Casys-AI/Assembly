import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  ANALYST,
  COORDINATOR,
  HEAD,
  item,
  linkedBoard,
  values,
} from "../../../test/support/board-fixture.ts";
import type { BoardElement } from "./lookup.ts";
import { detailOf, factsOf } from "./detail.ts";

const OPERATOR = `${COORDINATOR}.operator`;
const open = (
  selected: string | null,
  over: { sysml?: boolean; version?: string } = {},
) =>
  detailOf({
    board: linkedBoard(),
    page: "explore",
    selected,
    sysml: over.sysml ?? false,
    version: over.version,
    names: new Map([[COORDINATOR, "Coordinateur"]]),
  });

const element = (over: Partial<BoardElement> = {}): BoardElement => ({
  id: "e",
  kind: "policy",
  keyword: "part",
  title: "executionPolicy",
  home: "explore",
  column: "rules",
  ...over,
});

Deno.test("the address selects an element by a name the board knows; one it does not know selects nothing", () => {
  equal(open(`${COORDINATOR}.read`).selected?.title, "read_web_page");
  const none = open("ghost");
  equal(none.selected, undefined);
  equal(none.lens, undefined);
  equal(open(null).selected, undefined);
  equal(open("").selected, undefined);
  // The selection lights what it is related to.
  const lit = open(`${COORDINATOR}.read`);
  deepStrictEqual(lit.lens?.labels(OPERATOR), ["callable by"]);
});

Deno.test("units are called as the page calls them; any other element by its title, an unknown one by its id", () => {
  const detail = open(null);
  equal(detail.nameOf(COORDINATOR), "Coordinateur");
  // A unit the team has no name for is not given one.
  equal(detail.nameOf(ANALYST), "analyst");
  // Any other element is its title said as a phrase: one rule for every page.
  equal(detail.nameOf(`${COORDINATOR}.read`), "Read web page");
  equal(detail.nameOf(`${COORDINATOR}.promotion`), "Promotion");
  equal(detail.nameOf("ghost"), "ghost");
  // In SysML's words a unit is the identifier the model gives it, and so is everything else.
  const sysml = open(null, { sysml: true });
  equal(sysml.nameOf(COORDINATOR), "liveBuilder");
  equal(sysml.nameOf(`${COORDINATOR}.read`), "read_web_page");
  equal(sysml.nameOf(`${COORDINATOR}.promotion`), "promotion");
});

Deno.test("a word of the model is said as a phrase in the readable view and as written in SysML's, and units are named from their ids", () => {
  const readable = open(null);
  equal(readable.said("maxAgentDecisions"), "Max agent decisions");
  equal(readable.said("read_web_page"), "Read web page");
  equal(readable.said(""), "");
  equal(
    open(null, { sysml: true }).said("maxAgentDecisions"),
    "maxAgentDecisions",
  );
  // The names of the units an item is declared for: once each, in order, the board's units only.
  deepStrictEqual(
    readable.unitNames([ANALYST, COORDINATOR, ANALYST, "ghost"]),
    ["analyst", "Coordinateur"],
  );
  deepStrictEqual(readable.unitNames([]), []);
  deepStrictEqual(
    open(null, { sysml: true }).unitNames([COORDINATOR]),
    ["liveBuilder"],
  );
});

Deno.test("addresses stay on the page and at the version being read, and close to the page itself", () => {
  const plain = open(`${COORDINATOR}.read`);
  equal(plain.closeHref, "/system?page=explore");
  equal(
    plain.toggle(["a", "b"]),
    "/system?page=explore&select=a",
  );
  // Choosing again what is chosen closes it, whichever of its twins it is.
  equal(
    plain.toggle([`${ANALYST}.read`, `${COORDINATOR}.read`]),
    plain.closeHref,
  );
  const pinned = open(`${COORDINATOR}.read`, { version: HEAD });
  const at = `&version=${encodeURIComponent(HEAD)}`;
  equal(pinned.closeHref, `/system?page=explore${at}`);
  equal(pinned.toggle(["a"]), `/system?page=explore&select=a${at}`);
});

Deno.test("a page that reads more than the selection keeps it in the addresses that stay on the page, and in no other", () => {
  const detail = open(`${COORDINATOR}.read`, { version: HEAD });
  const at = `&version=${encodeURIComponent(HEAD)}`;
  const reading = detail.keeping({ flow: "f#1" });
  equal(reading.closeHref, `/system?page=explore&flow=f%231${at}`);
  equal(reading.toggle(["a"]), `/system?page=explore&flow=f%231&select=a${at}`);
  // Choosing again what is chosen closes it, the flow kept.
  equal(reading.toggle([`${COORDINATOR}.read`]), reading.closeHref);
  // What it was built from is not changed, and keeping again adds to it.
  equal(detail.closeHref, `/system?page=explore${at}`);
  equal(
    reading.keeping({ other: "x" }).closeHref,
    `/system?page=explore&flow=f%231&other=x${at}`,
  );
  equal(
    reading.keeping({ flow: "g" }).closeHref,
    `/system?page=explore&flow=g${at}`,
  );
  // It is the same selection, the same words, and addresses to other pages stay clean.
  equal(reading.selected, detail.selected);
  equal(reading.nameOf(COORDINATOR), detail.nameOf(COORDINATOR));
  deepStrictEqual(
    reading.where(detail.index.get(COORDINATOR)!),
    detail.where(detail.index.get(COORDINATOR)!),
  );
  equal(
    reading.source(detail.index.get(COORDINATOR)!),
    detail.source(detail.index.get(COORDINATOR)!),
  );
});

Deno.test("an element is opened on the page that is its home: a unit on Team, a part on Parts, a step on Flows, the rest on Explore", () => {
  const detail = open(null);
  const index = detail.index;
  const where = (id: string) => detail.where(index.get(id)!);
  deepStrictEqual(where(COORDINATOR), {
    page: "team",
    label: "Team",
    href: `/system?select=${COORDINATOR}`,
  });
  deepStrictEqual(where(`${COORDINATOR}.read`), {
    page: "explore",
    label: "Explore",
    href: `/system?page=explore&select=${COORDINATOR}.read`,
  });
  // What a unit holds is its structure, on Parts.
  deepStrictEqual(where(OPERATOR), {
    page: "parts",
    label: "Parts",
    href: `/system?page=parts&select=${OPERATOR}`,
  });
  // A flow's step lives on Flows.
  deepStrictEqual(where(`${COORDINATOR}.promotion.step0`), {
    page: "flows",
    label: "Flows",
    href: `/system?page=flows&select=${COORDINATOR}.promotion.step0`,
  });
  const pinned = open(null, { version: HEAD }).where(index.get(COORDINATOR)!);
  equal(
    pinned.href,
    `/system?select=${COORDINATOR}&version=${encodeURIComponent(HEAD)}`,
  );
});

Deno.test("the selection puts forward what it is: chosen, lit with the reason, in its context, or left alone", () => {
  const detail = open(`${COORDINATOR}.read`);
  // The tool itself.
  deepStrictEqual(detail.standing([`${COORDINATOR}.read`]), {
    chosen: true,
    why: [],
    class: "el is-selected",
  });
  // A twin of it is the choice too: an element goes by several ids.
  equal(
    detail.standing([`${ANALYST}.read`, `${COORDINATOR}.read`]).chosen,
    true,
  );
  // The operator that calls it is lit, and says why.
  deepStrictEqual(detail.standing([OPERATOR]), {
    chosen: false,
    why: ["callable by"],
    class: "el is-lit",
  });
  // What holds the operator holds the choice too: the unit is lit through it.
  equal(detail.standing([COORDINATOR]).class, "el is-lit");
  deepStrictEqual(detail.standing([COORDINATOR]).why, ["callable by"]);
  // A page that draws the operator itself says the reason there only: the unit
  // is still lit, and says nothing.
  deepStrictEqual(detail.standing([COORDINATOR], "own"), {
    chosen: false,
    why: [],
    class: "el is-lit",
  });
  deepStrictEqual(detail.standing([OPERATOR], "own").why, ["callable by"]);
  equal(detail.standing([OPERATOR], "inside").why.length, 1);
  // The choice says no reason, whichever way they are asked for.
  equal(detail.standing([`${COORDINATOR}.read`], "own").why.length, 0);
  // Nothing to do with it.
  deepStrictEqual(detail.standing([`${ANALYST}.read`]), {
    chosen: false,
    why: [],
    class: "el",
  });
  // The choice is an operator: its unit is context, not related.
  const inside = open(OPERATOR);
  deepStrictEqual(inside.standing([COORDINATOR]), {
    chosen: false,
    why: [],
    class: "el is-context",
  });
  // Without a choice nothing is put forward.
  deepStrictEqual(open(null).standing([OPERATOR]), {
    chosen: false,
    why: [],
    class: "el",
  });
  // Nor for a name the board does not know.
  equal(open("ghost").standing([OPERATOR]).class, "el");
});

Deno.test("the source of an element is its line in the model's files, at the version being read", () => {
  const sourced = element({ file: "lib/a.sysml", line: 12 });
  equal(
    open(null).source(sourced),
    "/model?page=files&file=lib%2Fa.sysml&line=12",
  );
  equal(
    open(null, { version: HEAD }).source(sourced),
    `/model?page=files&version=${
      encodeURIComponent(HEAD)
    }&file=lib%2Fa.sysml&line=12`,
  );
  // An element the sources do not place has no source to go to.
  equal(open(null).source(element()), undefined);
  equal(open(null).source(element({ file: "" })), undefined);
});

Deno.test("any line of a file of the model has the same address: the version being read, the file, the line when there is one", () => {
  equal(
    open(null).sourceAt("a.sysml", 3),
    "/model?page=files&file=a.sysml&line=3",
  );
  equal(
    open(null).sourceAt("lib/b.sysml"),
    "/model?page=files&file=lib%2Fb.sysml",
  );
  equal(
    open(null, { version: HEAD }).sourceAt("a.sysml", 3),
    `/model?page=files&version=${encodeURIComponent(HEAD)}&file=a.sysml&line=3`,
  );
  // The source of an element is the same address.
  const sourced = element({ file: "a.sysml", line: 3 });
  equal(open(null).source(sourced), open(null).sourceAt("a.sysml", 3));
});

Deno.test("a page whose choices are not elements of the board reads its choice from the address, and choosing it again closes it", () => {
  // The address says what it says, whether the board holds it or not.
  equal(open(null).choice, null);
  equal(open("").choice, null);
  equal(open("ghost").choice, "ghost");
  equal(open(`${COORDINATOR}.read`).choice, `${COORDINATOR}.read`);
  const cell = open("owner|candidate.admit");
  equal(cell.selected, undefined);
  equal(cell.choice, "owner|candidate.admit");
  // Choosing what is chosen closes it, though the board knows nothing of it; any other choice opens it.
  equal(cell.toggle(["owner|candidate.admit"]), cell.closeHref);
  equal(
    cell.toggle(["owner|model.decide"]),
    "/system?page=explore&select=owner%7Cmodel.decide",
  );
  // The pages of elements are not changed by it.
  equal(
    open(`${COORDINATOR}.read`).toggle(["ghost"]),
    "/system?page=explore&select=ghost",
  );
});

Deno.test("readable facts leave out what a person does not read, and say the rest in words", () => {
  const policy = item("p", "policy", "executionPolicy", {
    values: values({
      id: "live-builder-execution-v1",
      version: 1,
      revision: 2,
      configurationId: "cfg",
      envelopeKind: "x",
      envelopePattern: "1.3",
      evidenceLevel: "configured",
      source: "host",
      operatorName: "Coordinateur",
      maxAgentDecisions: 12,
      maxContextCharacters: 250000,
      timeoutMs: 90000,
      mayAddNetworkHosts: false,
      mayProposeSysmlRevision: true,
      allowedHosts: ["a.org", "b.org"],
      nothing: [],
      urlSelectionMode: "authorized-host",
    }),
  });
  const { facts, more } = factsOf(
    { ...element(), values: policy.values },
    false,
  );
  deepStrictEqual(facts.map((fact) => [fact.name, fact.value]), [
    ["Max agent decisions", "12"],
    ["Max context characters", "250k"],
    ["Timeout", "1.5 min"],
    ["May add network hosts", "no"],
    ["May propose sysml revision", "yes"],
    ["Allowed hosts", "a.org, b.org"],
  ]);
  ok(facts.every((fact) => !fact.code));
  // Two values were left out for room.
  equal(more, 2);
});

Deno.test("the lists a person reads: none, grants by the file and the roots they allow", () => {
  const { facts } = factsOf(
    element({
      values: values({
        nothing: [],
        grants: [{
          file: "mission.sysml",
          qualifiedRoots: ["Mission::qualificationPolicy", "Mission::source"],
        }, { file: "b.sysml", qualifiedRoots: ["B::c"] }],
      }),
    }),
    false,
  );
  deepStrictEqual(facts.map((fact) => [fact.name, fact.value]), [
    ["Nothing", "none"],
    ["Grants", "mission.sysml: qualificationPolicy, source; b.sysml: c"],
  ]);
});

Deno.test("SysML facts add how the element is declared and give every value as written", () => {
  const sysml = factsOf(
    element({
      qname: "Model::unit::executionPolicy",
      file: "configuration.sysml",
      line: 144,
      guard: "ok",
      expression: "a < b",
      values: values({
        id: "live-builder-execution-v1",
        maxAgentDecisions: 12,
        mayAddNetworkHosts: false,
        allowedHosts: ["a.org"],
        revision: 1,
      }),
    }),
    true,
  );
  deepStrictEqual(sysml.facts.map((fact) => [fact.name, fact.value]), [
    ["Name", "Model::unit::executionPolicy"],
    ["Source", "configuration.sysml:144"],
    ["Guard", "ok"],
    ["Expression", "a < b"],
    ["id", "live-builder-execution-v1"],
    ["maxAgentDecisions", "12"],
    ["mayAddNetworkHosts", "false"],
    ["allowedHosts", '["a.org"]'],
    ["revision", "1"],
  ]);
  ok(sysml.facts.every((fact) => fact.code));
  // The readable view says none of how it is declared; only the guard of a step.
  const readable = factsOf(
    element({
      qname: "Model::unit::executionPolicy",
      file: "configuration.sysml",
      line: 144,
      guard: "ok",
      expression: "a < b",
    }),
    false,
  );
  deepStrictEqual(readable.facts.map((fact) => fact.name), ["Guard"]);
});

Deno.test("the values listed are capped, readable at six and SysML at fourteen, and the rest are counted", () => {
  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, n) => [`value${n + 1}`, n]),
  );
  const declared = element({ values: values(many) });
  const readable = factsOf(declared, false);
  equal(readable.facts.length, 6);
  equal(readable.more, 14);
  const sysml = factsOf(declared, true);
  equal(sysml.facts.length, 14);
  equal(sysml.more, 6);
  equal(factsOf(element(), false).more, 0);
});

Deno.test("the elements a relation names are told by the name a person reads: what reads alike is named once, by the first of them", () => {
  const detail = open(null);
  const a = element({ id: "a", title: "read" });
  const b = element({ id: "b", title: "read" });
  const c = element({ id: "c", title: "write" });
  deepStrictEqual(
    detail.endpoints([a, b, c]).map(({ element, name }) => [element.id, name]),
    [["a", "Read"], ["c", "Write"]],
  );
  // A unit is told by the name the team gives it, in the readable view only.
  const unit = detail.index.get(COORDINATOR)!;
  deepStrictEqual(detail.endpoints([unit]).map(({ name }) => name), [
    "Coordinateur",
  ]);
  const sysml = open(null, { sysml: true });
  deepStrictEqual(sysml.endpoints([unit]).map(({ name }) => name), [
    unit.title,
  ]);
  deepStrictEqual(detail.endpoints([]), []);
});

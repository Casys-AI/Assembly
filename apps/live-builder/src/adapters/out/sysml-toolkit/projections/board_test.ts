import { NativeToolkitPanicError } from "../runtime/native-addon.ts";
import assert from "node:assert/strict";
import { projectToolkitBoard } from "./board.ts";
import type { ToolkitElement, ToolkitSession } from "../runtime/loader.ts";
import { canonicalProductName } from "../../../../domain/model/sysml-product-names.ts";

function fixture(fail = false, freeFailure = false) {
  const allocated: ToolkitElement[] = [];
  const released: ToolkitElement[] = [];
  const names = new WeakMap<ToolkitElement, string>();
  let sessionFreed = false;
  const session: ToolkitSession = {
    free() {
      sessionFreed = true;
    },
    check: () => "[]",
    query: () => "[]",
    resolve(name) {
      if (fail && allocated.length) throw new Error("anchor lookup failed");
      // This mock represents one current library family. Resolving every
      // arbitrary name would invent two competing native alias definitions.
      if (canonicalProductName(name) !== name) return undefined;
      const element: ToolkitElement = {
        free() {
          released.push(element);
          if (freeFailure) throw new Error("element disposal failed");
        },
      };
      names.set(element, name);
      allocated.push(element);
      return element;
    },
    elementById: () => undefined,
    elementId: (element) => names.get(element)!,
    qualifiedName: (element) => names.get(element),
    referenceSpelling: (element) => names.get(element),
    metaclass: () => "PartDefinition",
    isLibraryElement: () => true,
    owner: () => undefined,
    typings: () => [],
    rows: () => "[]",
    memberSource: () => "",
    memberExtent: () => undefined,
    references: () => "[]",
    units: () =>
      JSON.stringify([{
        unit: 0,
        name: "model.sysml",
        text: "package Empty;",
      }]),
    checkEdit: () => "{}",
    edit: () => {
      throw new Error("read-only projection attempted an edit");
    },
    property: () => "null",
    derived: () => "null",
    derivedElements: () => [],
    valueSource: () => undefined,
    redefinitionRoot: (element) => element,
    outline: () => JSON.stringify({ shape: { nodes: [], truncated: false } }),
    name: (element) => names.get(element),
    members: () => [],
    evaluate: () => "null",
    elementsOfMetaclass: () => [],
    docs: () => [],
    conforms: () => false,
    declarationSite: () => undefined,
  };
  return { session, allocated, released, sessionFreed: () => sessionFreed };
}

Deno.test("board projector releases every acquired native handle after success and leaves session ownership to adapter", async () => {
  const f = fixture();
  const sources = { "model.sysml": "package Empty;" };
  const board = await projectToolkitBoard(f.session, sources, {
    model: "empty",
    toolkitVersion: "0.10.10",
  });
  assert.equal(board.schema, "ase.board/1");
  assert.equal(board.meta.model, "empty");
  assert.ok(f.allocated.length > 0);
  assert.equal(f.released.length, f.allocated.length);
  assert.equal(new Set(f.released).size, f.allocated.length);
  assert.ok(f.allocated.every((element) => f.released.includes(element)));
  assert.equal(f.sessionFreed(), false);
  assert.deepEqual(sources, { "model.sysml": "package Empty;" });
});

Deno.test("board projector releases handles when a later Toolkit lookup fails", async () => {
  const f = fixture(true);
  await assert.rejects(
    () => projectToolkitBoard(f.session, { "model.sysml": "package Empty;" }),
    /anchor lookup failed/,
  );
  assert.equal(f.allocated.length, 1);
  assert.deepEqual(f.released, f.allocated);
  assert.equal(f.sessionFreed(), false);
});

Deno.test("board projector attempts all native releases when a handle disposal fails", async () => {
  const f = fixture(false, true);
  await assert.rejects(
    () => projectToolkitBoard(f.session, { "model.sysml": "package Empty;" }),
    /element disposal failed/,
  );
  assert.ok(f.allocated.length > 1);
  assert.equal(f.released.length, f.allocated.length);
  assert.equal(new Set(f.released).size, f.allocated.length);
});

Deno.test("board projector preserves a native panic and frees its just-acquired handle even when cleanup also fails", async () => {
  const f = fixture(false, true);
  const trap = new NativeToolkitPanicError("element identity trapped");
  f.session.elementId = () => {
    throw trap;
  };
  await assert.rejects(
    () => projectToolkitBoard(f.session, { "model.sysml": "package Empty;" }),
    (error) => error === trap,
  );
  assert.equal(f.allocated.length, 1);
  assert.deepEqual(f.released, f.allocated);
});

Deno.test("board projector preserves literal bullet stars returned by Session.docs", async () => {
  const f = fixture();
  const docPackage = f.session.resolve("DocProbe")!;
  f.session.elementsOfMetaclass = (metaclass) =>
    metaclass === "Package" ? [docPackage] : [];
  f.session.isLibraryElement = (element) => element !== docPackage;
  f.session.docs = (element) =>
    element === docPackage ? ["Rules apply:\n* first rule\n* second rule"] : [];
  const board = await projectToolkitBoard(f.session, {
    "model.sysml": "package DocProbe;",
  });
  assert.equal(
    board.meta.packages?.find((pkg) => pkg.qname === "DocProbe")?.doc,
    "Rules apply: * first rule * second rule",
  );
  assert.equal(f.released.length, f.allocated.length);
});

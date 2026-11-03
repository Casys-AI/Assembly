import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { createViewsApi, parseView, parseViewList } from "./api.ts";
import { sourceExport, sysmlLocation } from "./location.ts";

const version = `commit:${"a".repeat(40)}`;
const view = {
  id: "structure:A",
  title: "A",
  kind: "interconnection",
  group: "structure",
  element: "A",
  nodes: 1,
  edges: 0,
  diagram: {
    nodes: [{ id: "a", name: "", typeName: "T", kind: "block", rows: [] }],
    edges: [],
  },
};
const list = {
  toolkit: "0.10.10",
  views: [view],
  diagnostics: [],
  digest: "digest",
};
Deno.test("view reads pin a selected diagram and export to the exact version returned by the list", async () => {
  const paths: string[] = [];
  const api = createViewsApi({
    fetch: ((input: string | URL | Request) => {
      const path = String(input);
      paths.push(path);
      return Promise.resolve(
        new Response(
          path.includes("plantuml") ? "@startuml\n@enduml" : JSON.stringify(
            path.includes("diagram") ? { toolkit: "0.10.10", view } : list,
          ),
          { headers: { "x-model-version": version } },
        ),
      );
    }) as typeof fetch,
  });
  const read = await api.list();
  equal(read.version, version);
  equal((await api.diagram(read.version, view.id)).id, view.id);
  equal(paths.length, 2, "viewing does not request PlantUML");
  equal(await api.plantuml(read.version, view.id), "@startuml\n@enduml");
  deepStrictEqual(paths.map((p) => new URL(p, "http://test").pathname), [
    "/api/model/views",
    "/api/model/views/diagram",
    "/api/model/views/plantuml",
  ]);
  for (const path of paths.slice(1)) {
    equal(new URL(path, "http://test").searchParams.get("version"), version);
  }
});
Deno.test("diagram client rejects a different view, wrong source revision and malformed diagram payloads", async () => {
  throws(() => parseView({ view }, "structure:B"));
  throws(() =>
    parseView({
      view: {
        ...view,
        diagram: {
          nodes: [{ id: "a", label: "old composite", kind: "block", rows: [] }],
          edges: [],
        },
      },
    }, view.id)
  );
  throws(() => parseViewList({ ...list, views: [view, view] }));
  equal(
    parseView({ view }, view.id).diagram.nodes[0].name,
    "",
    "anonymous native names remain valid",
  );
  const api = createViewsApi({
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ view }), {
          headers: { "x-model-version": `commit:${"b".repeat(40)}` },
        }),
      )) as typeof fetch,
  });
  await rejects(api.diagram(version, view.id), /Invalid native/);
});
Deno.test("source navigation accepts old version links and source export is sorted without changing declarations", () => {
  deepStrictEqual(
    sysmlLocation(
      `?modelVersion=${version}&view=structure%3AA&select=A%3A%3Ax`,
    ),
    { version, view: "structure:A", selected: "A::x" },
  );
  equal(
    sourceExport({ "z.sysml": "package Z;\n", "a.sysml": "package A;\n" }),
    "// a.sysml\npackage A;\n\n// z.sysml\npackage Z;\n",
  );
});

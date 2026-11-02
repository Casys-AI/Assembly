// Builds the mock from the data snapshot in data/: dist/index.html (the System and Model spaces)
// and dist/sysml-<system>.html (the SysML viewer), each with its data inlined.
//   deno run --allow-read=. --allow-write=dist build.ts
const dir = new URL(".", import.meta.url).pathname;
const names = ["commercial-watch", "demo-ase"];
const read = async (file: string) => JSON.parse(await Deno.readTextFile(`${dir}data/${file}`));
const data: Record<string, unknown> = {};
for (const name of names) {
  const sysml = await read(`sysml-${name}.json`);
  data[name] = {
    ...(await read(`data-${name}.json`)),
    board: await read(`board-${name}.json`),
    // Action and state graphs from the Toolkit (toGraph), keyed by their definition.
    diagrams: Object.fromEntries(sysml.views.filter((v: { kind: string }) => v.kind === "action" || v.kind === "state").map((v: { element: string; kind: string; graph: unknown }) => [v.element, { kind: v.kind, graph: v.graph }])),
    sysmlViews: sysml.views.map((v: { id: string; title: string; group: string; graph: { nodes: { qname?: string }[] } }) => ({
      id: v.id, title: v.title, group: v.group, qnames: [...new Set(v.graph.nodes.map((n) => n.qname).filter(Boolean))],
    })),
  };
}
const inline = (value: unknown) => JSON.stringify(value).replaceAll("</", "<\\/");
await Deno.mkdir(`${dir}dist`, { recursive: true });
const workspace = await Deno.readTextFile(`${dir}template.html`);
const repo = await read("repo-demo-administration.json");
await Deno.writeTextFile(`${dir}dist/index.html`, workspace.replace("__DATA__", () => inline(data)).replace("__REPO__", () => inline(repo)));
const viewer = await Deno.readTextFile(`${dir}sysml-template.html`);
for (const name of names) {
  const model = await read(`sysml-${name}.json`);
  await Deno.writeTextFile(`${dir}dist/sysml-${name}.html`, viewer.replace("__MODEL__", () => inline(model)));
}
console.log("built");

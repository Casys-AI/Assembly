// Export prototype diagrams and PlantUML through the current native adapter.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SysmlToolkitAdapter } from "../../../src/adapters/out/sysml-toolkit/adapter.ts";
import { TOOLKIT_DIRECTORY } from "../../../src/adapters/sysml-toolkit-pin.ts";

const appDir = fileURLToPath(new URL("../../../", import.meta.url));
const [name, sourcesPath, out, toolkitDirectory] = Deno.args;
const packageDir = resolve(
  toolkitDirectory ??
    join(appDir, ".data/toolchains", TOOLKIT_DIRECTORY, "package"),
);
const raw = JSON.parse(await Deno.readTextFile(sourcesPath));
const sources: Record<string, string> = Array.isArray(raw)
  ? Object.fromEntries(
    raw.map((u: { name: string; text: string }) => [u.name, u.text]),
  )
  : raw;
const adapter = new SysmlToolkitAdapter({ packageDir });
const projection = await adapter.views(sources);
const views = [];
for (const summary of projection.views) {
  const view = await adapter.diagram(sources, summary);
  let plantuml = "";
  try {
    plantuml = await adapter.plantuml(sources, summary);
  } catch (error) {
    plantuml = "' PlantUML unavailable: " + String(error);
  }
  views.push({
    id: view.id,
    title: view.title,
    kind: view.kind,
    group: view.group,
    element: view.element,
    graph: view.diagram,
    plantuml,
  });
}
await Deno.writeTextFile(
  out,
  JSON.stringify({ name, toolkit: projection.toolkit, views, sources }),
);
console.log(name, views.length, "views");
Deno.exit(0);

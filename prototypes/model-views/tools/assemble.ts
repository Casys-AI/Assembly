// Assemble a prototype workspace from the current adapter's view list/diagram APIs.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SysmlToolkitAdapter } from "../../../src/adapters/out/sysml-toolkit/adapter.ts";
import { TOOLKIT_DIRECTORY } from "../../../src/adapters/sysml-toolkit-pin.ts";
import type { ModelView } from "../../../src/domain/model/records/diagram-views.ts";

const appDir = fileURLToPath(new URL("../../../", import.meta.url));
const [name, sourcesPath, boardPath, matrixPath, out, toolkitDirectory] =
  Deno.args;
const raw = JSON.parse(await Deno.readTextFile(sourcesPath));
const sources: Record<string, string> = Array.isArray(raw)
  ? Object.fromEntries(
    raw.map((u: { name: string; text: string }) => [u.name, u.text]),
  )
  : raw;
const packageDir = resolve(
  toolkitDirectory ??
    join(appDir, ".data/toolchains", TOOLKIT_DIRECTORY, "package"),
);
const adapter = new SysmlToolkitAdapter({ packageDir });
const projection = await adapter.views(sources);
const views: ModelView[] = [];
for (const summary of projection.views) {
  if (summary.group === "definitions" || summary.group === "declared") {
    views.push(await adapter.diagram(sources, summary));
  }
}
const data = {
  name,
  toolkit: projection.toolkit,
  board: JSON.parse(await Deno.readTextFile(boardPath)),
  matrix: JSON.parse(await Deno.readTextFile(matrixPath)),
  definitions: views.filter((v) => v.group === "definitions"),
  declared: views.filter((v) => v.group === "declared"),
  sources,
};
await Deno.writeTextFile(out, JSON.stringify(data));
console.log(name, "views", views.length, "bytes", JSON.stringify(data).length);
Deno.exit(0);

import { defaultToolkitPackageDir } from "../../../src/infrastructure/native/runtime-location.ts";
/** Assemble and validate the source set; never initialize a model database. */
import { ToolkitCompiler } from "../../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { validateSourceExecutable } from "../../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { discoverConversationUnits } from "../../../src/domain/model/records/source-identity.ts";

const directory = new URL("./", import.meta.url);
const sources: Record<string, string> = {};
for await (const entry of Deno.readDir(directory)) {
  if (entry.isFile && entry.name.endsWith(".sysml")) {
    sources[entry.name] = await Deno.readTextFile(
      new URL(entry.name, directory),
    );
  }
}
const compiler = new ToolkitCompiler({
  packageDir: Deno.env.get("SYSML_TOOLKIT_DIR") ?? defaultToolkitPackageDir(),
});
const revision = {
  ...await compiler.compile(sources),
  version: "branch:local-source-qualification",
};
const projectId = "git:bb93a73b-27e4-49a1-a2ec-8dc4acef7e97";
const units = discoverConversationUnits(revision, projectId);
const operators = [];
for (const unit of units) {
  const model = await validateSourceExecutable(
    revision,
    projectId,
    unit.systemQualifiedName,
  );
  operators.push({
    systemQualifiedName: unit.systemQualifiedName,
    operator: model.operator,
    agentId: model.identity.builderId,
    modelEditPolicy: model.modelEditPolicy ?? null,
    digest: model.version.digest,
    entries: model.operatorEntries,
    behaviors: (model.behaviors ?? []).map((behavior) => ({
      name: behavior.name,
      id: behavior.id,
      callerNativeId: behavior.callerNativeId,
      targetNativeId: behavior.targetNativeId,
      inputTypeId: behavior.inputTypeId,
    })),
  });
}
await Deno.writeTextFile(
  new URL("assembly-sources.json", directory),
  JSON.stringify(revision.sources, null, 2) + "\n",
);
console.log(JSON.stringify(
  {
    compiler: await compiler.version(),
    sourceFiles: Object.keys(sources).sort(),
    operators,
  },
  null,
  2,
));

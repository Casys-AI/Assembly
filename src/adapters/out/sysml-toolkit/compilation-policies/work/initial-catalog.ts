import { assert as requireValue } from "../../../../../domain/primitives/assert.ts";
import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import { isNamespacePartOccurrence } from "../../../../../domain/model/policies/model-occurrence.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import {
  type NativeInitialToolSeed,
  validateInitialToolManifest,
} from "../../../../../domain/work/records/initial-tool-catalog.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import type { ModelSources as Sources } from "../../../../../domain/model/value-objects/sources.ts";

const fields = ["id", "name", "description", "kind", "code"];

/** Compile only exact source-owned seed items from this operator's catalog. */
export function compileInitialTools(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): NativeInitialToolSeed[] {
  const packages = snapshot.elements.filter((element) =>
    sameProductName(element.qualifiedName, "AssemblyInitialTools")
  );
  if (!packages.length) return [];
  requireValue(
    packages.length === 1 && packages[0]!.metaclass === "Package",
    "Ambiguous initial tool package",
  );
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  requireValue(
    byId.size === snapshot.elements.length,
    "Duplicate initial tool identity",
  );
  const definitions = snapshot.elements.filter((element) =>
    sameProductName(element.qualifiedName, "AssemblyInitialTools::ToolSeed")
  );
  requireValue(
    definitions.length === 1 &&
      definitions[0]!.metaclass === "ItemDefinition" &&
      definitions[0]!.ownerId === packages[0]!.id,
    "Expected exact initial ToolSeed definition",
  );
  const definition = definitions[0]!;
  const members = snapshot.elements.filter((element) =>
    element.ownerId === definition.id
  );
  requireValue(
    members.length === fields.length &&
      members.every((element) =>
        fields.includes(element.name) &&
        element.metaclass === "AttributeUsage" &&
        element.declaredReference !== true && element.typeIds.length === 1
      ) && new Set(members.map((member) => member.name)).size === fields.length,
    "Initial ToolSeed definition requires exact String fields",
  );
  for (const member of members) {
    const type = byId.get(member.typeIds[0]!);
    requireValue(
      !type || type.qualifiedName === "ScalarValues::String",
      "Invalid initial tool field type",
    );
  }
  const system = byId.get(identity.systemId),
    catalog = byId.get(identity.catalogId);
  requireValue(
    system?.metaclass === "PartUsage" && system.typeIds.length === 1 &&
      (!system.isReference || namespaceOccurrence(system)) &&
      catalog?.metaclass === "PartUsage" &&
      catalog.ownerId === system.id && !catalog.isReference,
    "Missing local system or initial tool catalog",
  );
  const systemType = system.typeIds[0]!;
  const ownerSystem = (element: ElementRecord) => {
    const seen = new Set<string>();
    let owner = byId.get(element.ownerId);
    while (owner && !owner.typeIds.includes(systemType)) {
      requireValue(
        !seen.has(owner.id) && !owner.isReference &&
          !/Definition$/.test(owner.metaclass),
        "Initial tools require a concrete conversation system",
      );
      seen.add(owner.id);
      owner = byId.get(owner.ownerId);
    }
    requireValue(
      owner?.metaclass === "PartUsage" &&
        (!owner.isReference || namespaceOccurrence(owner)) &&
        owner.typeIds.length === 1,
      "Initial tools require a concrete conversation system",
    );
    return owner.id;
  };
  const seeds = snapshot.elements.filter((element) =>
    element.typeIds.includes(definition.id) && /Usage$/.test(element.metaclass)
  ).filter((element) => ownerSystem(element) === identity.systemId);
  const drafts = seeds.map((seed) => {
    requireValue(
      seed.metaclass === "ItemUsage" && !seed.isReference &&
        seed.ownerId === identity.catalogId && seed.typeIds.length === 1,
      "Initial tool selection must be an owned item of its local catalog",
    );
    const attributes = snapshot.elements.filter((element) =>
      element.ownerId === seed.id
    );
    requireValue(
      attributes.length === fields.length &&
        attributes.every((attribute) => fields.includes(attribute.name)),
      "Initial tool selection requires exact native fields",
    );
    const sourceIds = new Set([
      packages[0]!.id,
      definition.id,
      identity.systemId,
      identity.catalogId,
      seed.id,
    ]);
    const seenLiteralIds = new Set<string>();
    const values: Record<string, string> = {};
    for (const name of fields) {
      const member = members.find((member) => member.name === name)!;
      const own = attributes.filter((attribute) => attribute.name === name);
      const found = literals.filter((literal) =>
        literal.owner === seed.id && literal.name === name
      );
      requireValue(
        own.length === 1 && found.length === 1,
        "Expected one native initial tool literal " + name,
      );
      const attribute = own[0]!, literal = found[0]!;
      requireValue(
        attribute.metaclass === "AttributeUsage" &&
          attribute.declaredReference !== true &&
          attribute.typeIds.length === 1 &&
          attribute.typeIds[0] === member.typeIds[0] &&
          attribute.redefinedIds.length === 1 &&
          attribute.redefinedIds[0] === member.id &&
          literal.attributeId === attribute.id && literal.literalId &&
          !seenLiteralIds.has(literal.literalId) &&
          literal.kind === "LiteralString" && literal.typeIds.length === 1 &&
          literal.typeIds[0] === member.typeIds[0] &&
          literal.typeNames.length === 1 &&
          literal.typeNames[0] === "ScalarValues::String",
        "Invalid typed native initial tool literal " + name,
      );
      seenLiteralIds.add(literal.literalId);
      sourceIds.add(member.id);
      sourceIds.add(member.typeIds[0]!);
      sourceIds.add(attribute.id);
      sourceIds.add(literal.literalId);
      values[name] = literal.value;
    }
    return { seed, values, sourceIds: [...sourceIds].sort() };
  });
  const selected = validateInitialToolManifest({
    format: 1,
    tools: drafts.map((draft) => draft.values),
  });
  return selected.map((selection, index) => ({
    ...selection,
    nativeId: drafts[index]!.seed.id,
    sourceIds: drafts[index]!.sourceIds,
  })).sort((a, b) => persistedOrder(a.id, b.id));
}

/** Mask comments and strings so text in code/docs cannot select a source owner. */
function syntax(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (text) => text.replace(/[^\n\r]/g, " "),
  );
}

/** At creation only, translate a closed selection to explicit SysML seed items. */
export function withInitialTools(
  sources: Sources,
  manifest: unknown,
  definitionSource: string,
): Sources {
  const selection = validateInitialToolManifest(manifest);
  if (!selection.length) return structuredClone(sources);
  const owners = Object.entries(sources).flatMap(([path, source]) => {
    const text = syntax(source);
    requireValue(
      !/\b(?:AssemblyInitialTools|ASEInitialTools)\s*::\s*ToolSeed\b/.test(
        text,
      ),
      "A source selection already exists; use an explicit source revision",
    );
    return [
      ...text.matchAll(
        /\bpart\s+catalog\s*:\s*(?:(?:AssemblyLiveBuilder|ASELiveBuilder)\s*::\s*)?ToolCatalog\s*\{/g,
      ),
    ].map((match) => ({
      path,
      at: match.index + match[0].length,
    }));
  });
  requireValue(
    owners.length === 1,
    "Initial tool selection requires one unambiguous catalog source occurrence",
  );
  const owner = owners[0]!, source = sources[owner.path]!;
  const packages = [
    ...syntax(definitionSource).matchAll(
      /\bpackage\s+(AssemblyInitialTools|ASEInitialTools)\s*\{/g,
    ),
  ];
  requireValue(
    packages.length === 1,
    "Expected one qualified initial tool library",
  );
  const seedType = `${packages[0]![1]}::ToolSeed`;
  const declarations = selection.map((selection, index) => {
    const values = { id: selection.id, ...selection.draft };
    return `\n            item initialTool${index + 1} : ${seedType} {\n${
      fields.map((name) =>
        `                attribute :>> ${name} = ${
          JSON.stringify(values[name as keyof typeof values]).replaceAll(
            "\u2028",
            "\\u2028",
          ).replaceAll("\u2029", "\\u2029")
        };`
      ).join("\n")
    }\n            }\n`;
  }).join("");
  requireValue(
    !sources["initial-tools.sysml"] ||
      sources["initial-tools.sysml"] === definitionSource,
    "Initial tool library differs from the qualified definition",
  );
  return {
    ...sources,
    "initial-tools.sysml": definitionSource,
    [owner.path]: source.slice(0, owner.at) + declarations +
      source.slice(owner.at),
  };
}

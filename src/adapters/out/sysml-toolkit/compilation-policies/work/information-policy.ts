import { assert as requireValue } from "../../../../../domain/primitives/assert.ts";
import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import { isNamespacePartOccurrence } from "../../../../../domain/model/policies/model-occurrence.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
/** Compile opt-in information policies from exact native declarations and
 * literals. Policy presence never grants a behavior invocation permission. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type {
  NativeContextPolicy,
  NativeInitialSkill,
  NativeMemoryPolicy,
  NativeModelingGuidance,
  NativeSkillPolicy,
} from "../../../../../domain/model/execution/native-contracts.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import { validateNetworkScope } from "../../../../../domain/governance/policies/network-policy.ts";

type Scalar = "String" | "Integer" | "Boolean";
const skillFields = {
  id: "String",
  revision: "Integer",
  allowedHosts: "String",
  maxSkillBytes: "Integer",
  maxInstalledSkills: "Integer",
  maxLoadedSkills: "Integer",
  maxLoadedCharacters: "Integer",
} as const;
const initialSkillFields = {
  id: "String",
  source: "String",
  digest: "String",
  loaded: "Boolean",
} as const;
const contextFields = {
  id: "String",
  revision: "Integer",
  recentMessages: "Integer",
  maxMessageCharacters: "Integer",
  maxCollectionItems: "Integer",
  maxContextCharacters: "Integer",
} as const;
const memoryFields = {
  id: "String",
  revision: "Integer",
  allowedScopes: "String",
  requireSourceRefs: "Boolean",
  requireKnownOutcome: "Boolean",
  maxValidityMs: "Integer",
  allowSelfAdmission: "Boolean",
} as const;
const guidanceFields = {
  id: "String",
  revision: "Integer",
  content: "String",
} as const;
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function compileInformationPolicies(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): {
  contextPolicy?: NativeContextPolicy;
  memoryPolicy?: NativeMemoryPolicy;
  modelingGuidance?: NativeModelingGuidance[];
  skillPolicy?: NativeSkillPolicy;
  initialSkills?: NativeInitialSkill[];
} {
  const result: {
    contextPolicy?: NativeContextPolicy;
    memoryPolicy?: NativeMemoryPolicy;
    modelingGuidance?: NativeModelingGuidance[];
    skillPolicy?: NativeSkillPolicy;
    initialSkills?: NativeInitialSkill[];
  } = {};
  // The historical model remains unchanged when neither contract is declared.
  if (
    !snapshot.elements.some((element) =>
      ["APEContext", "APEMemory", "APESkills"].includes(element.qualifiedName)
    )
  ) return result;
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  requireValue(
    byId.size === snapshot.elements.length,
    "Duplicate native information policy identity",
  );
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  const system = byId.get(identity.systemId);
  requireValue(
    system?.metaclass === "PartUsage" &&
      (!system.isReference || namespaceOccurrence(system)) &&
      system.typeIds.length === 1,
    "Missing concrete native information policy system",
  );
  const systemType = byId.get(system.typeIds[0]!);
  requireValue(
    systemType?.metaclass === "PartDefinition" &&
      sameProductName(
        systemType.qualifiedName,
        "AssemblyLiveBuilder::ConversationSystem",
      ),
    "Invalid native information policy system type",
  );
  const exact = (qualifiedName: string, metaclass: string) => {
    const matches = snapshot.elements.filter((element) =>
      element.qualifiedName === qualifiedName && element.metaclass === metaclass
    );
    requireValue(
      matches.length === 1,
      `Expected one native information declaration ${qualifiedName}`,
    );
    return matches[0]!;
  };
  const compile = (
    packageName: "APEContext" | "APEMemory" | "APESkills",
    typeName: string,
    fields: Record<string, Scalar>,
    maximum = 1,
  ) => {
    const packages = snapshot.elements.filter((element) =>
      element.qualifiedName === packageName
    );
    if (!packages.length) return;
    requireValue(
      packages.length === 1 && packages[0]!.metaclass === "Package",
      `Ambiguous native information package ${packageName}`,
    );
    const pkg = packages[0]!;
    const definition = exact(`${packageName}::${typeName}`, "PartDefinition");
    requireValue(
      definition.ownerId === pkg.id,
      `Information policy type belongs to another package ${typeName}`,
    );
    const sources = new Set([identity.systemId, pkg.id, definition.id]);
    const declarationFields = snapshot.elements.filter((element) =>
      element.ownerId === definition.id
    );
    requireValue(
      declarationFields.length === Object.keys(fields).length &&
        new Set(declarationFields.map((element) => element.name)).size ===
          declarationFields.length,
      `Unsupported native information policy declaration ${typeName}`,
    );
    const baseFields = new Map<string, ElementRecord>();
    for (const [name, scalar] of Object.entries(fields)) {
      const declaration = exact(
        `${packageName}::${typeName}::${name}`,
        "AttributeUsage",
      );
      requireValue(
        declaration.ownerId === definition.id &&
          declaration.typeIds.length === 1,
        `Invalid native information declaration ${name}`,
      );
      // ModelSnapshot omits library DataTypes. The exact scalar name is
      // therefore checked on the native literal tuple when instantiated,
      // together with equality to this declaration's native type identity.
      const suppliedType = byId.get(declaration.typeIds[0]!);
      requireValue(
        !suppliedType ||
          suppliedType.qualifiedName === `ScalarValues::${scalar}`,
        `Invalid native information declaration ${name}`,
      );
      sources.add(declaration.id);
      sources.add(declaration.typeIds[0]!);
      baseFields.set(name, declaration);
    }
    const occurrences = snapshot.elements.filter((element) =>
      element.metaclass === "PartUsage" &&
      element.typeIds.includes(definition.id)
    );
    const local: ElementRecord[] = [];
    const ancestors = new Map<string, string[]>();
    for (const occurrence of occurrences) {
      const visited = new Set<string>();
      let owner = byId.get(occurrence.ownerId);
      const concreteOwners: string[] = [];
      while (owner && owner.typeIds[0] !== systemType.id) {
        requireValue(
          !visited.has(owner.id) && owner.metaclass === "PartUsage" &&
            !owner.isReference && owner.typeIds.length <= 1,
          "Information policy must belong to a concrete conversation system",
        );
        visited.add(owner.id);
        concreteOwners.push(owner.id);
        owner = byId.get(owner.ownerId);
      }
      requireValue(
        owner?.metaclass === "PartUsage" &&
          (!owner.isReference || namespaceOccurrence(owner)) &&
          owner.typeIds.length === 1,
        "Information policy must belong to a concrete conversation system",
      );
      if (owner.id !== identity.systemId) continue;
      requireValue(
        !occurrence.isReference && occurrence.typeIds.length === 1,
        `Information policy must be a concrete occurrence in its system ${typeName}`,
      );
      ancestors.set(occurrence.id, concreteOwners);
      local.push(occurrence);
    }
    requireValue(
      local.length <= maximum,
      `Ambiguous native information policy ${typeName}`,
    );
    if (!local.length) return;
    return local.toSorted((a, b) => persistedOrder(a.id, b.id)).map(
      (occurrence) => {
        const occurrenceSources = new Set(sources);
        occurrenceSources.add(occurrence.id);
        for (const owner of ancestors.get(occurrence.id) ?? []) {
          occurrenceSources.add(owner);
        }
        const attributes = snapshot.elements.filter((element) =>
          element.ownerId === occurrence.id
        );
        requireValue(
          attributes.length === Object.keys(fields).length &&
            attributes.every((attribute) => attribute.name in fields),
          `Unsupported native information policy fields ${typeName}`,
        );
        const seenLiteralIds = new Set<string>();
        const value = (name: string, scalar: Scalar) => {
          const base = baseFields.get(name)!;
          const attributes = snapshot.elements.filter((element) =>
            element.ownerId === occurrence.id && element.name === name
          );
          const matches = literals.filter((literal) =>
            literal.owner === occurrence.id && literal.name === name
          );
          requireValue(
            attributes.length === 1 && matches.length === 1,
            `Expected one native information literal ${name}`,
          );
          const attribute = attributes[0]!, literal = matches[0]!;
          requireValue(
            attribute.metaclass === "AttributeUsage" &&
              attribute.redefinedIds.length === 1 &&
              attribute.redefinedIds[0] === base.id &&
              attribute.typeIds.length === 1 &&
              attribute.typeIds[0] === base.typeIds[0] &&
              literal.attributeId === attribute.id && literal.literalId &&
              !seenLiteralIds.has(literal.literalId) &&
              literal.kind === `Literal${scalar}` &&
              literal.typeIds.length === 1 &&
              literal.typeIds[0] === base.typeIds[0] &&
              literal.typeNames.length === 1 &&
              literal.typeNames[0] === `ScalarValues::${scalar}`,
            `Invalid typed native information literal ${name}`,
          );
          seenLiteralIds.add(literal.literalId);
          occurrenceSources.add(attribute.id);
          occurrenceSources.add(literal.literalId);
          return literal.value;
        };
        const integer = (name: string, minimum: number, maximum: number) => {
          const text = value(name, "Integer");
          const parsed = Number(text);
          requireValue(
            /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(parsed) &&
              parsed >= minimum && parsed <= maximum,
            `Invalid native information Integer ${name}`,
          );
          return parsed;
        };
        const string = (name: string) => {
          const text = value(name, "String");
          requireValue(
            text.length > 0 && text.length <= 128 && text.trim() === text &&
              !hasControlCharacters(text),
            `Invalid native information String ${name}`,
          );
          return text;
        };
        const boolean = (name: string) => {
          const text = value(name, "Boolean");
          requireValue(
            text === "true" || text === "false",
            `Invalid native information Boolean ${name}`,
          );
          return text === "true";
        };
        return {
          occurrence,
          sources: occurrenceSources,
          value,
          integer,
          string,
          boolean,
        };
      },
    );
  };
  const context = compile("APEContext", "DecisionContextPolicy", contextFields)
    ?.[0];
  if (context) {
    result.contextPolicy = {
      kind: "separated-context",
      pattern: "5.1",
      id: context.string("id"),
      revision: context.integer("revision", 1, Number.MAX_SAFE_INTEGER),
      elementId: context.occurrence.id,
      recentMessages: context.integer("recentMessages", 1, 100),
      maxMessageCharacters: context.integer(
        "maxMessageCharacters",
        256,
        100_000,
      ),
      maxCollectionItems: context.integer("maxCollectionItems", 1, 128),
      maxContextCharacters: context.integer(
        "maxContextCharacters",
        4096,
        2_000_000,
      ),
      sourceIds: [],
    };
    result.contextPolicy.sourceIds = [...context.sources].toSorted();
  }
  const memory = compile("APEMemory", "GovernedMemoryPolicy", memoryFields)
    ?.[0];
  if (memory) {
    const rawScopes = memory.value("allowedScopes", "String");
    requireValue(
      rawScopes.length <= 8192,
      "Native memory scope list exceeds limit",
    );
    let scopes: unknown;
    try {
      scopes = JSON.parse(rawScopes);
    } catch {
      throw new Error("Invalid native memory allowedScopes JSON");
    }
    requireValue(
      Array.isArray(scopes) && scopes.length >= 1 && scopes.length <= 32 &&
        scopes.every((scope) =>
          typeof scope === "string" && scope.length > 0 &&
          scope.length <= 128 &&
          scope.trim() === scope && !hasControlCharacters(scope)
        ) && new Set(scopes).size === scopes.length,
      "Invalid native memory allowedScopes",
    );
    requireValue(
      byId.get(identity.builderId)?.ownerId === identity.systemId &&
        byId.get(identity.builderId)?.metaclass === "PartUsage" &&
        !byId.get(identity.builderId)?.isReference,
      "Invalid native memory owner",
    );
    memory.sources.add(identity.builderId);
    result.memoryPolicy = {
      kind: "governed-memory",
      pattern: "5.2",
      id: memory.string("id"),
      revision: memory.integer("revision", 1, Number.MAX_SAFE_INTEGER),
      elementId: memory.occurrence.id,
      ownerId: identity.builderId,
      allowedScopes: scopes as string[],
      requireSourceRefs: memory.boolean("requireSourceRefs"),
      requireKnownOutcome: memory.boolean("requireKnownOutcome"),
      maxValidityMs: memory.integer("maxValidityMs", 1, 31_536_000_000),
      allowSelfAdmission: memory.boolean("allowSelfAdmission"),
      sourceIds: [],
    };
    result.memoryPolicy.sourceIds = [...memory.sources].toSorted();
  }
  const guidance = compile(
    "APEContext",
    "ModelingGuidance",
    guidanceFields,
    16,
  );
  if (guidance) {
    result.modelingGuidance = guidance.map((entry) => {
      const content = entry.value("content", "String");
      requireValue(
        content.trim().length > 0 && content.length <= 16_000 &&
          !content.includes("\0"),
        "Invalid native modeling guidance content",
      );
      const result = {
        id: entry.string("id"),
        revision: entry.integer("revision", 1, Number.MAX_SAFE_INTEGER),
        elementId: entry.occurrence.id,
        content,
        sourceIds: [] as string[],
      };
      result.sourceIds = [...entry.sources].toSorted();
      return result;
    });
    requireValue(
      new Set(result.modelingGuidance.map((entry) => entry.id)).size ===
        result.modelingGuidance.length,
      "Duplicate native modeling guidance id",
    );
  }
  const skill = compile("APESkills", "SkillPolicy", skillFields)?.[0];
  if (skill) {
    let allowedHosts: unknown;
    try {
      allowedHosts = JSON.parse(skill.value("allowedHosts", "String"));
    } catch {
      throw new Error("Invalid native skill allowedHosts JSON");
    }
    const network = validateNetworkScope({ allowedHosts });
    const maxInstalledSkills = skill.integer("maxInstalledSkills", 1, 128);
    const maxLoadedSkills = skill.integer(
      "maxLoadedSkills",
      1,
      maxInstalledSkills,
    );
    skill.sources.add(identity.builderId);
    result.skillPolicy = {
      kind: "lazy-skills",
      id: skill.string("id"),
      revision: skill.integer("revision", 1, Number.MAX_SAFE_INTEGER),
      elementId: skill.occurrence.id,
      ownerId: identity.builderId,
      allowedHosts: network.allowedHosts,
      maxSkillBytes: skill.integer("maxSkillBytes", 256, 1_048_576),
      maxInstalledSkills,
      maxLoadedSkills,
      maxLoadedCharacters: skill.integer("maxLoadedCharacters", 256, 1_048_576),
      sourceIds: [...skill.sources].toSorted(),
    };
  }
  const initial = compile("APESkills", "InitialSkill", initialSkillFields, 32);
  if (initial) {
    requireValue(
      !!result.skillPolicy,
      "Initial skills require their local native skill policy",
    );
    result.initialSkills = initial.map((entry) => {
      const source = entry.value("source", "String");
      const digest = entry.value("digest", "String");
      requireValue(
        source.length <= 127 &&
          /^bundle:[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(source),
        "Invalid initial skill source: expected a closed bundle identifier",
      );
      requireValue(
        /^[a-f0-9]{64}$/.test(digest),
        "Invalid initial skill digest",
      );
      const id = entry.string("id");
      requireValue(
        id.length <= 120 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(id),
        "Invalid initial skill id",
      );
      return {
        nativeId: entry.occurrence.id,
        id,
        source,
        digest,
        loaded: entry.boolean("loaded"),
        sourceIds: [...entry.sources].toSorted(),
      };
    });
    requireValue(
      new Set(result.initialSkills.map((entry) => entry.id)).size ===
        result.initialSkills.length,
      "Duplicate initial skill id",
    );
    requireValue(
      result.initialSkills.length <= result.skillPolicy!.maxInstalledSkills,
      "Initial skill catalog exceeds its native policy",
    );
    const loaded = result.initialSkills.filter((entry) => entry.loaded);
    requireValue(
      loaded.length <= result.skillPolicy!.maxLoadedSkills,
      "Initial loaded skills exceed their native policy",
    );
  }
  return result;
}

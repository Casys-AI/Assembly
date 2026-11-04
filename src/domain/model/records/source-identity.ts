import { sourceSnapshot } from "../projections/source-facts.ts";
import type { ElementRecord } from "./snapshot.ts";
import { isNamespacePartOccurrence } from "../policies/model-occurrence.ts";
import { assert } from "../../primitives/assert.ts";
import type { ModelIdentity } from "../../shared-kernel/model-identity.ts";
import type { SourceRevision } from "./source-revision.ts";
import type { JsonObject as Element } from "./compiled-model.ts";
import { productNameInModel } from "../sysml-product-names.ts";
import { id } from "../value-objects/source-elements.ts";
import {
  createModelSourceIndex,
  modelSourceElement,
  type ModelSourceIndex,
} from "../editing/source-index.ts";

/** Omitted scope is the persisted historical ASE identity encoding. */
export const DEFAULT_SYSTEM = "ASELiveBuilder::liveBuilder";

export function sourceModelIdentity(
  revision: SourceRevision,
  projectId: string,
  systemQualifiedName = DEFAULT_SYSTEM,
): ModelIdentity {
  return identityFromSource(
    revision,
    projectId,
    systemQualifiedName,
    createModelSourceIndex(revision),
  );
}

function identityFromSource(
  revision: SourceRevision,
  projectId: string,
  systemQualifiedName: string,
  index: ModelSourceIndex,
): ModelIdentity {
  systemQualifiedName = productNameInModel(
    revision.elements,
    systemQualifiedName,
  );
  assert(
    /^git:[a-f0-9-]{36}$/.test(projectId),
    "Expected a versioned model repository namespace",
  );
  assert(
    /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/.test(
      systemQualifiedName,
    ),
    "Unsupported native conversation system qualified name",
  );
  const lookup = (name: string) =>
    modelSourceElement(
      index,
      productNameInModel(revision.elements, name),
      "PartUsage",
    );
  const system = lookup(systemQualifiedName);
  const catalog = lookup(`${systemQualifiedName}::catalog`);
  const builder = lookup(`${systemQualifiedName}::builder`);
  let reviewer: Element | undefined;
  try {
    const element = modelSourceElement(
      index,
      `${systemQualifiedName}::reviewer`,
    );
    if (element["@type"] === "PartUsage") reviewer = element;
  } catch (error) {
    if (
      !(error && typeof error === "object" && "code" in error &&
        error.code === "TARGET_MISSING")
    ) throw error;
  }
  return {
    ...(systemQualifiedName !== DEFAULT_SYSTEM ? { systemQualifiedName } : {}),
    projectId,
    editingContextId: `${projectId}/main`,
    rootId: `${projectId}/root`,
    systemId: id(system),
    catalogId: id(catalog),
    builderId: id(builder),
    ...(reviewer ? { reviewerId: id(reviewer) } : {}),
  };
}

export interface ConversationUnitIdentity {
  systemQualifiedName: string;
  identity: ModelIdentity;
}

/** Discover real occurrences, never library members or references. */
export function discoverConversationUnits(
  revision: SourceRevision,
  projectId: string,
): ConversationUnitIdentity[] {
  const snapshot = sourceSnapshot(revision.elements, `${projectId}/root`);
  const types = snapshot.elements.filter((element) =>
    element.name === "ConversationSystem" &&
    element.metaclass === "PartDefinition"
  );
  assert(
    types.length === 1,
    "Expected one native ConversationSystem definition",
  );
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  const concrete = (ownerId: string): boolean => {
    const seen = new Set<string>();
    let owner = byId.get(ownerId);
    while (owner && !seen.has(owner.id)) {
      if (/^(Library)?Package$/.test(owner.metaclass)) return true;
      if (
        /Definition$/.test(owner.metaclass) ||
        (owner.isReference && !namespaceOccurrence(owner))
      ) {
        return false;
      }
      seen.add(owner.id);
      owner = byId.get(owner.ownerId);
    }
    return false;
  };
  const units = snapshot.elements.filter((element) =>
    element.metaclass === "PartUsage" &&
    (!element.isReference || namespaceOccurrence(element)) &&
    element.typeIds.length === 1 && element.typeIds[0] === types[0]!.id &&
    concrete(element.ownerId)
  ).map((element) => String(element.qualifiedName));
  assert(units.length > 0, "No concrete native conversation system");
  const index = createModelSourceIndex(revision);
  return units.toSorted().map((systemQualifiedName) => ({
    systemQualifiedName,
    identity: identityFromSource(
      revision,
      projectId,
      systemQualifiedName,
      index,
    ),
  }));
}

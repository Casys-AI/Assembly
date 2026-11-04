import type { ModelToolingPort } from "../tooling.ts";
import type { ModelSourceFilesPort } from "../source-files.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import {
  HostEditError,
  type HostEditRequest,
  spelling,
} from "../../../domain/model/editing/host-edit.ts";
import {
  id,
  one,
  reference,
  references,
} from "../../../domain/model/value-objects/source-elements.ts";
import {
  modelSourceElement,
  modelToolingTarget,
} from "../../../domain/model/editing/source-index.ts";
import { sourceSnapshot } from "../../../domain/model/projections/source-facts.ts";
import {
  productNameInModel,
  productSourceForModel,
  sameProductName,
} from "../../../domain/model/sysml-product-names.ts";
import {
  DYNAMIC_MANDATE_SOURCE,
  LEGACY_DYNAMIC_MANDATE_SOURCE,
} from "../../../domain/governance/mandates.ts";
import { normalizeMember } from "../../../domain/model/editing/source-text.ts";

type Element = Record<string, unknown>;

/** Fill the reviewer template; a function replacement keeps `$&`, `$'` and
 * `` $` `` in operator-supplied values literal. */
export function declareReviewer(
  template: string,
  id: unknown,
  name: unknown,
): string {
  const declaration = `part reviewer : ${
    template.includes("AssemblyLiveBuilder::IndependentReviewer")
      ? "AssemblyLiveBuilder"
      : "ASELiveBuilder"
  }::IndependentReviewer { attribute operatorId : ScalarValues::String = ${
    spelling(id)
  }; attribute configuredName : ScalarValues::String = ${spelling(name)}; }`;
  // This is a new declaration only. Keep the admitted template bytes and all
  // other literals intact; recognize only its exact historical source field.
  const currentTemplate = template.replace(
    `attribute :>> source = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};`,
    `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
  );
  return currentTemplate.replace(
    template.includes("AssemblyLiveBuilder::IndependentReviewer")
      ? "part reviewer : AssemblyLiveBuilder::IndependentReviewer;"
      : "part reviewer : ASELiveBuilder::IndependentReviewer;",
    () => declaration,
  );
}

/** A promotion dependent with no reinsertable enclosing member. The context
 * names the element; the message carries its source location when the Toolkit
 * graph records one. Raised before any Toolkit edit is applied. */
function dependentReferenceFailure(
  systemQualifiedName: string,
  element: string,
  qualifiedName?: string,
  location?: string,
): never {
  throw new HostEditError(
    "MIGRATION_DEPENDENT_REFERENCE",
    {
      opIndex: -1,
      op: "setFeatureType",
      target: { qualifiedName: qualifiedName ?? systemQualifiedName },
    },
    `Reviewer migration refuses a dependent reference to a promotion child: ${element}${
      location ? ` at ${location}` : ""
    }`,
  );
}

/** One dependent member removed verbatim before the promotion type change and
 * reinserted verbatim, in the same owner, after it. */
export interface RemovedMember {
  elementId: string;
  metaclass: string;
  ownerQualifiedName: string;
  text: string;
}

/** Under each owner, the reinserted members must equal the removed members,
 * comparing normalized member texts (whitespace and indentation ignored, the
 * rest identical). Anything else in the owner is covered by the off-target
 * control in `verifyEdits`; no whole-view byte comparison is made, so a view
 * written with 2-space or tab indentation passes. */
export async function assertReinsertedMembers(
  tooling: ModelToolingPort,
  revision: SourceRevision,
  removed: readonly RemovedMember[],
): Promise<void> {
  const groups = new Map<string, RemovedMember[]>();
  for (const member of removed) {
    const key = `${member.ownerQualifiedName}\0${member.metaclass}`;
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  for (const [key, members] of groups) {
    const [ownerQualifiedName, metaclass] = key.split("\0") as [
      string,
      string,
    ];
    let owner: Element;
    try {
      owner = modelSourceElement(revision, ownerQualifiedName);
    } catch {
      throw new HostEditError("READ_BACK_MISMATCH", {
        opIndex: -1,
        op: "insertMember",
        target: { qualifiedName: ownerQualifiedName },
      }, `Reinsertion owner is missing or ambiguous: ${ownerQualifiedName}`);
    }
    const ownerId = id(owner);
    const available: string[] = [];
    for (
      const candidate of revision.elements.filter((element) =>
        reference(element.owner) === ownerId &&
        element["@type"] === metaclass
      )
    ) {
      try {
        const description = await tooling.describe(
          revision.sources,
          modelToolingTarget(revision, id(candidate), {
            allowAnonymous: true,
          }),
        );
        available.push(normalizeMember(description.source.text));
      } catch {
        // An undescribable sibling is not a reinserted member; the
        // off-target control in verifyEdits covers its preservation.
      }
    }
    // A reinserted member may later gain an inserted child (for example
    // `expose reviewerActions;` inside a restored overview): match whole
    // normalized texts as line multisets, extra candidate lines allowed,
    // changed or missing lines refused.
    const lineCounts = (text: string) => {
      const counts = new Map<string, number>();
      for (const line of text.split("\n")) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
      return counts;
    };
    for (const member of members) {
      const expected = normalizeMember(member.text);
      const needed = lineCounts(expected);
      const at = available.findIndex((candidate) => {
        const present = lineCounts(candidate);
        return [...needed].every(([line, count]) =>
          (present.get(line) ?? 0) >= count
        );
      });
      if (at < 0) {
        throw new HostEditError(
          "READ_BACK_MISMATCH",
          {
            opIndex: -1,
            op: "insertMember",
            target: { qualifiedName: ownerQualifiedName },
          },
          `Reinserted member differs under ${ownerQualifiedName}: ${
            expected.slice(0, 120)
          }`,
        );
      }
      available.splice(at, 1);
    }
  }
}

/** Build host operations from native identities, never from lexical nesting. */
export async function reviewerPromotionEdits(
  tooling: ModelToolingPort,
  revision: SourceRevision,
  files: ModelSourceFilesPort,
  systemQualifiedName: string,
): Promise<{
  requests: HostEditRequest[];
  removedMembers: RemovedMember[];
}> {
  const fail = (message: string): never => {
    throw new HostEditError("TOOLKIT_REFUSED", {
      opIndex: -1,
      op: "setFeatureType",
      target: { qualifiedName: systemQualifiedName },
    }, message);
  };
  const find = (name: string, type: string) => {
    try {
      return one(revision, name, type);
    } catch {
      return fail(`Ambiguous reviewer migration: ${name}`);
    }
  };
  const describe = async (element: Element) =>
    await tooling.describe(
      revision.sources,
      modelToolingTarget(revision, id(element), { allowAnonymous: true }),
    );
  const canonical = await tooling.snapshot(
    await files.initialSources({ information: false }),
  );
  const original = find(
    "AssemblyLiveBuilder::CapabilityPromotion",
    "ActionDefinition",
  );
  const expected = one(
    canonical,
    "AssemblyLiveBuilder::CapabilityPromotion",
    "ActionDefinition",
  );
  const expectedDescription = await tooling.describe(
    canonical.sources,
    modelToolingTarget(canonical, id(expected)),
  );
  if (
    normalizeMember(
      productSourceForModel(
        (await describe(original)).source.text,
        canonical.elements,
      ),
    ) !==
      normalizeMember(expectedDescription.source.text)
  ) fail("Reviewer migration refuses a customized CapabilityPromotion");
  const system = find(systemQualifiedName, "PartUsage");
  const promotion = find(
    `${systemQualifiedName}::promotion`,
    "PerformActionUsage",
  );
  const promotionDescription = await describe(promotion);
  if (
    promotionDescription.types.length !== 1 ||
    !sameProductName(
      promotionDescription.types[0]!.qualifiedName,
      "AssemblyLiveBuilder::CapabilityPromotion",
    )
  ) fail("Reviewer migration requires the original unreviewed promotion");
  const definitions = [
    "ReviewedConfiguredAdmission",
    "ReviewedCapabilityPromotion",
  ];
  const present = definitions.map((name) =>
    revision.elements.some((e) =>
      sameProductName(e.qualifiedName, `AssemblyLiveBuilder::${name}`) &&
      e["@type"] === "ActionDefinition"
    )
  );
  if (present[0] !== present[1]) {
    fail("Ambiguous reviewer migration: partial reviewed definitions");
  }
  const requests: HostEditRequest[] = [];
  if (!present[0]) {
    requests.push({
      op: "insertMember",
      owner: {
        qualifiedName: productNameInModel(
          revision.elements,
          "AssemblyLiveBuilder",
        ),
      },
      text: productSourceForModel(
        await files.template(
          "configuration-reviewed-promotion.sysml",
        ),
        revision.elements,
      ),
      expect: [],
    });
  }
  const legacy = revision.elements.filter((e) =>
    e.qualifiedName === `${systemQualifiedName}::review` &&
    e["@type"] === "PerformActionUsage"
  );
  if (legacy.length) {
    fail("Ambiguous reviewer migration: review occurrence");
  }
  // Changing the promotion type changes its inherited children's identities.
  // Dependents are discovered only from structured Toolkit graph references
  // (snapshot elements and connector end chains; never SysML source text and
  // never error-message parsing). Each dependent's nearest reinsertable
  // enclosing member is removed verbatim before the type change and
  // reinserted verbatim, in the same owner, after it; no view is emptied and
  // no member text is synthesized. A dependent with no such member (a
  // reference inside an expression, an alias membership the graph records
  // without a source extent) refuses with MIGRATION_DEPENDENT_REFERENCE
  // before any Toolkit edit is applied.
  const byId = new Map(revision.elements.map((e) => [String(e["@id"]), e]));
  const promotionId = id(promotion);
  const snapshot = sourceSnapshot(revision.elements, "migration:dependents");
  // Reverse containment for graph elements whose `owner` is null (exposes,
  // memberships, relations): the element that lists them contains them.
  const containedBy = new Map<string, string>();
  for (const element of revision.elements) {
    for (
      const field of [
        "ownedImport",
        "importedMembership",
        "ownedRelationship",
        "ownedSpecialization",
        "ownedMembership",
        "featureMembership",
        "connectorEnd",
        "ownedAnnotation",
        "ownedElement",
        "member",
        "membership",
      ]
    ) {
      for (const child of references(element[field])) {
        if (!containedBy.has(child)) {
          containedBy.set(child, String(element["@id"]));
        }
      }
    }
  }
  // Last-resort parent: whichever element references this one at all (some
  // membership kinds are listed under kind-specific fields).
  const referencedBy = new Map<string, string>();
  for (const element of revision.elements) {
    for (const value of Object.values(element)) {
      for (const child of references(value)) {
        if (child !== String(element["@id"]) && !referencedBy.has(child)) {
          referencedBy.set(child, String(element["@id"]));
        }
      }
    }
  }
  const parentOf = (element: Element): Element | undefined =>
    byId.get(
      reference(element.owner) ??
        reference(element.owningMembership) ??
        reference(element.membershipOwningNamespace) ??
        reference(element.owningType) ??
        reference(element.owningNamespace) ??
        reference(element.owningRelatedElement) ?? "",
    ) ?? byId.get(containedBy.get(String(element["@id"])) ?? "") ??
      byId.get(referencedBy.get(String(element["@id"])) ?? "");
  const locationOf = (element: Element): string | undefined => {
    const seen = new Set<string>();
    let current: Element | undefined = element;
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      if (
        typeof current["sysx:sourceDocument"] === "string" &&
        typeof current["sysx:sourceLine"] === "number"
      ) {
        return `${current["sysx:sourceDocument"]}:${
          current["sysx:sourceLine"]
        }:${current["sysx:sourceColumn"]}`;
      }
      current = parentOf(current);
    }
    return undefined;
  };
  const labelOf = (element: Element): string =>
    `${String(element["@type"])} ${
      typeof element.qualifiedName === "string"
        ? element.qualifiedName
        : typeof element.declaredName === "string"
        ? element.declaredName
        : typeof element.memberName === "string"
        ? element.memberName
        : String(element["@id"])
    }`;
  // Tainted identities: the promotion's inherited children, everything owned
  // by the original definition or by a tainted element, every feature chain
  // reaching past the promotion, and members of (non-library) types of
  // tainted features, so deep paths such as promotion.admit.decision.admitted
  // resolve as dependents. References to the promotion itself are not
  // dependents: its identity survives the type change.
  const tainted = new Set<string>([promotionId]);
  {
    let grew = true;
    while (grew) {
      grew = false;
      const taintedTypes = new Set<string>();
      for (const elementId of tainted) {
        const element = byId.get(elementId);
        if (!element || element.isLibraryElement === true) continue;
        for (const typeId of references(element.type)) {
          const type = byId.get(typeId);
          if (type && type.isLibraryElement !== true) {
            taintedTypes.add(typeId);
          }
        }
      }
      for (const element of revision.elements) {
        const elementId = String(element["@id"]);
        if (tainted.has(elementId) || element.isLibraryElement === true) {
          continue;
        }
        const parent = parentOf(element);
        const parentId = parent ? String(parent["@id"]) : "";
        const chain = references(element.chainingFeature);
        if (
          parentId && (tainted.has(parentId) || taintedTypes.has(parentId)) ||
          chain.length > 1 && chain.some((segment) => tainted.has(segment)) ||
          chain.length === 1 && chain[0] !== promotionId &&
            tainted.has(chain[0]!)
        ) {
          tainted.add(elementId);
          grew = true;
        }
      }
    }
  }
  let reviewAllocations = 0;
  for (const connector of snapshot.connectors) {
    const sourceChain = connector.ends[0]?.chain ?? [];
    if (
      connector.metaclass === "AllocationUsage" &&
      sourceChain[0]?.id === promotionId && sourceChain[1] &&
      byId.get(sourceChain[1].id)?.declaredName === "review"
    ) reviewAllocations++;
  }
  const scaffold =
    /(?:Membership|Subsetting|Typing|Chaining|Redefinition|Specialization|Subclassification|Relationship|ConnectorEnd|Documentation|Comment)$/;
  const containmentFields = new Set([
    "owner",
    "member",
    "membership",
    "feature",
    "ownedImport",
    "ownedRelationship",
    "ownedSpecialization",
    "ownedMembership",
    "featureMembership",
    "connectorEnd",
    "ownedElement",
    "ownedAnnotation",
    "importedMembership",
    "documentation",
    "featureTarget",
    "assertedConstraint",
  ]);
  const insideDefinition = (element: Element): boolean => {
    const seen = new Set<string>();
    let current: Element | undefined = element;
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      if (
        String(current["@id"]) === id(original) ||
        String(current["@id"]) === promotionId
      ) return true;
      current = parentOf(current);
    }
    return false;
  };
  // Nearest enclosing member that can be removed and reinserted as-is: a
  // describable usage or view whose owner has a qualified name. An expose
  // has no Toolkit source extent of its own, so its enclosing member is its
  // view, removed and reinserted whole (never emptied). A reference carried
  // by an expression or an extent-less membership has no such member.
  const enclosingMember = async (
    start: Element,
  ): Promise<RemovedMember | undefined> => {
    const seen = new Set<string>();
    let current: Element | undefined = start;
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      const metaclass = String(current["@type"]);
      if (metaclass.includes("Expression") || metaclass === "FeatureValue") {
        return undefined;
      }
      if (
        metaclass === "MembershipExpose" || metaclass === "NamespaceExpose"
      ) {
        const view = parentOf(current);
        current = view && view["@type"] === "ViewUsage" ? view : undefined;
        continue;
      }
      if (metaclass.includes("Membership")) {
        // A membership's enclosing member is the member it introduces.
        const member = byId.get(references(current.memberElement)[0] ?? "");
        if (member && member !== current) {
          current = member;
          continue;
        }
      }
      if (insideDefinition(current)) return undefined;
      // A member inside a type definition does not resolve through the
      // promotion instance; it is never a reinsertable dependent here.
      if (owningDefinition(current) !== "") return undefined;
      if (
        !scaffold.test(metaclass) && metaclass !== "Feature" &&
        current !== promotion && current !== system &&
        String(current["@id"]) !== id(original)
      ) {
        try {
          const description = await describe(current);
          if (description.owner?.qualifiedName && description.source.text) {
            const candidate: RemovedMember = {
              elementId: String(current["@id"]),
              metaclass,
              ownerQualifiedName: description.owner.qualifiedName,
              text: description.source.text,
            };
            // Only two kinds are reinserted verbatim: a view (its exposes
            // have no extent of their own) and an allocation whose source
            // chain reaches through a promotion child. Every other
            // enclosing member (bind, connect, succession, subsetting,
            // a target-end allocation, …) has no reinsertion rule here
            // and refuses coded in the caller.
            if (metaclass === "ViewUsage") return candidate;
            if (metaclass === "AllocationUsage") {
              const connector = connectorById.get(candidate.elementId);
              const source = connector?.ends[0]?.chain ?? [];
              if (
                source.length > 1 &&
                source.some((segment) => tainted.has(segment.id))
              ) return candidate;
            }
            return undefined;
          }
        } catch {
          // Not describable as a member; climb to its container.
        }
      }
      current = parentOf(current);
    }
    return undefined;
  };
  // A reference from inside the very definition that owns its target (a
  // sibling feature of a promotion child's type, say) does not resolve
  // through the promotion and is not a dependent.
  const owningDefinition = (element: Element): string => {
    const seen = new Set<string>();
    let current: Element | undefined = element;
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      if (/Definition$/.test(String(current["@type"]))) {
        return String(current["@id"]);
      }
      current = parentOf(current);
    }
    return "";
  };
  // A dependent resolves through this system's promotion only. An element
  // that is, or is contained in, another PartUsage (a sibling conversation
  // system sharing the same promotion definition) resolves through that
  // system's own promotion instance: its references to the shared
  // definition's children are not dependents of this migration.
  const inSystemScope = (element: Element): boolean => {
    const seen = new Set<string>();
    let current: Element | undefined = element;
    let foreignPart = false;
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      if (current === system) return true;
      if (String(current["@type"]) === "PartUsage") foreignPart = true;
      current = parentOf(current);
    }
    return !foreignPart;
  };
  const removed = new Map<string, RemovedMember>();
  const connectorById = new Map(snapshot.connectors.map((c) => [c.id, c]));
  // Transitive closure: a removed named member's own dependents (a view
  // exposing a removed allocation, an overview exposing a removed view, …)
  // are removed and reinserted the same way.
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of revision.elements) {
      const elementId = String(element["@id"]);
      if (
        removed.has(elementId) ||
        element === promotion || element === system ||
        element.isLibraryElement === true || insideDefinition(element) ||
        owningDefinition(element) !== "" ||
        ["Package", "LibraryPackage", "Namespace"].includes(
          String(element["@type"]),
        ) || !inSystemScope(element)
      ) continue;
      const hits = new Set<string>();
      const ownDefinition = owningDefinition(element);
      for (const [field, value] of Object.entries(element)) {
        if (containmentFields.has(field)) continue;
        for (const hit of references(value)) {
          if (hit === promotionId || !tainted.has(hit)) continue;
          const target = byId.get(hit);
          if (
            target && ownDefinition &&
            owningDefinition(target) === ownDefinition
          ) continue;
          hits.add(hit);
        }
      }
      const connector = connectorById.get(elementId);
      if (
        connector?.ends.some((end) =>
          end.chain.length > 1 &&
          end.chain.some((segment) => tainted.has(segment.id))
        )
      ) hits.add(elementId);
      if (!hits.size) continue;
      const member = await enclosingMember(element);
      if (!member) {
        dependentReferenceFailure(
          systemQualifiedName,
          labelOf(element),
          typeof element.qualifiedName === "string"
            ? element.qualifiedName
            : systemQualifiedName,
          locationOf(element),
        );
      }
      if (removed.has(member!.elementId)) {
        continue;
      }
      removed.set(member!.elementId, member!);
      tainted.add(member!.elementId);
      changed = true;
    }
  }
  if (reviewAllocations !== 0) {
    fail("Ambiguous reviewer migration: review occurrence or allocation");
  }
  // Batch 0 removes every dependent member; batch 1 changes the promotion
  // type; batch 2 reinserts each removed member verbatim in its original
  // owner. Reinsertion order may differ from the original order: the Toolkit
  // exposes no moveMember operation through ModelToolingPort, so no position
  // is rewritten.
  const staged: HostEditRequest[] = [];
  // Removals run in reverse discovery order: a dependent of a removed
  // member (discovered later, transitively) is removed before the member
  // it references, so no intermediate state breaks a reference.
  for (const member of [...removed.values()].reverse()) {
    staged.push({
      op: "remove",
      target: { elementId: member.elementId },
      batch: 0,
    });
  }
  staged.push(...requests.map((request) => ({ ...request, batch: 1 })));
  staged.push({
    op: "setFeatureType",
    target: { qualifiedName: `${systemQualifiedName}::promotion` },
    type: productNameInModel(
      revision.elements,
      "AssemblyLiveBuilder::ReviewedCapabilityPromotion",
    ),
    batch: 1,
  });
  for (const member of removed.values()) {
    staged.push({
      op: "insertMember",
      owner: { qualifiedName: member.ownerQualifiedName },
      text: member.text,
      expect: [],
      batch: 2,
    });
  }
  return { requests: staged, removedMembers: [...removed.values()] };
}

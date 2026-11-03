import { assert } from "../../../domain/primitives/assert.ts";
import {
  canonicalProductName,
  productNameInModel,
  productSourceForModel,
  sameProductName,
} from "../../../domain/model/sysml-product-names.ts";
import { MAX_OPERATOR_UNITS } from "../../../domain/work/records/conversations.ts";
import {
  DYNAMIC_MANDATE_SOURCE,
  LEGACY_DYNAMIC_MANDATE_SOURCE,
} from "../../../domain/governance/mandates.ts";
import { assertCandidateDelegationReceipt } from "../../../domain/governance/policies/tool-admission-policy.ts";
import { verifyPublicationReadback } from "../../../domain/model/publication/compatibility.ts";
import { loadInitialSources } from "../../out/filesystem/initial-model-sources.ts";
import {
  applyEdits,
  assertSourceSplices,
  incarnationInventory,
  normalizeMember,
  verifyEdits,
} from "./editing/host-writer.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { buildOperationJournal } from "../../../domain/model/editing/write-command.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  buildActivationCommand,
  buildApprovedChangeCommand,
} from "../../../application/model/publication/write-queue.ts";
import type { ModelWriteSubmissionPort } from "../../../application/model/publication/submission.ts";
import {
  isTeamOperatorSpec,
  mainExecutionSpace,
  modelEditingAuthorityRoots,
} from "../../../domain/governance/operator-authority.ts";
import {
  assertCreationWithinPolicy,
  assertOperatorCreationCapacity,
  creationPreviewExercise,
  exactChildCreationGrant,
  mainCreationScope,
  matchesTeamProvision,
  requestedCreationPolicyId,
} from "../../../domain/governance/policies/operator-creation-policy.ts";
import { operatorAuthorityRequests } from "../../governance/authority/operator/writer.ts";
import { compareModelSources } from "./changes/diff.ts";
import {
  OperatorAuthorityError,
  type PreparedChangeDiff,
} from "../../../domain/governance/operator-authority.ts";
import {
  HostEditError,
  type HostEditRequest,
  hostEditTarget,
  spelling,
} from "../../../domain/model/editing/host-edit.ts";
import {
  CandidateActivationError,
  requireActivation,
} from "../../../domain/work/policies/candidate-activation.ts";
import {
  APPROVAL_RECEIPT_RESERVE_BYTES,
  type ApprovedChangePublication,
  assertPublicationMatches,
  assertPublicationSize,
  type CandidateActivationPublication,
  type ChangePublication,
  changePublication,
  ChangePublicationError,
  publicationFailure,
  publicationSourceVersion,
  type SourcePublication,
} from "../../../domain/model/publication/change.ts";
import type { SystemSourcesUpdateOptions } from "../../../application/model/repository.ts";
import type { ModelRevisionHeader } from "../../../domain/model/records/revision.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import {
  assertApprovable,
  assertChangeAuthorityReceipt,
} from "../../../domain/governance/policies/change-approvability.ts";
import type { ElementRecord } from "../../../domain/model/records/snapshot.ts";
import { isNamespacePartOccurrence } from "../../../domain/model/policies/model-occurrence.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  type AuthorityExercise,
  AuthorityInvariantError,
  exerciseOwnerAuthority,
} from "../../../domain/governance/authority.ts";
/** Source-authoritative model adapter. Provider data is read from an admitted
 * immutable Git revision; every write recompiles a complete SysML source set. */
import type { ModelPort } from "../../../application/work/runtime/ports.ts";
import type { ModelToolingPort } from "../../../application/model/tooling.ts";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import type { ModelEditOperation } from "../../../domain/governance/policies/model-edit-policy.ts";
import type { ModelDelegationRequest } from "../../../domain/governance/records/model-delegation-request.ts";
import { prepareModelAdministration } from "../../governance/model-access/administration/operations.ts";
import { applyModelDelegations } from "../../governance/model-access/delegation/state.ts";
import { compileModelAdministrationPolicy } from "../../out/sysml-toolkit/compilation-policies/governance/model-access/administration/policy.ts";
import type { ModelProposalAuthorization } from "../../../domain/governance/records/model-edit-authorization.ts";
import { createOperatorEditAuthorization } from "../../governance/model-access/source-authorization.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  createModelSourceIndex,
  modelSourceElement,
  type ModelSourceIndex,
  modelToolingTarget,
  resolveModelEdits,
} from "./editing/tooling.ts";
import type {
  Candidate,
  ModelBinding,
} from "../../../domain/work/candidates.ts";
import type {
  ModelIdentity,
  ModelRevisionProposal,
  ModelRevisionRequest,
  ModelSourceProposalStatus,
  ModelSourceRevision,
  PublishedModelRevision,
} from "../../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../../domain/governance/records/pending-change.ts";
import type {
  SystemConfiguration,
} from "../../../domain/governance/records/system-configuration.ts";
import {
  projectSourceGraph,
  sourceLiterals,
  sourceSnapshot,
  sourceValues,
} from "../projections/graph/source.ts";
import {
  compileExecutableModel,
  isPrimaryDesigner,
} from "../../out/sysml-toolkit/compilation-policies/work/execution-model.ts";
import { compileBehaviorCatalog } from "../../out/sysml-toolkit/compilation-policies/work/behavior-catalog.ts";
import { compileOperatorEntries } from "../../out/sysml-toolkit/compilation-policies/work/operator-entries.ts";
import { resolveNativeActionBaseIds } from "../../out/sysml-toolkit/compilation-policies/work/operator-flow.ts";
import { compileEvolutionPolicy } from "../../out/sysml-toolkit/compilation-policies/governance/model-access/evolution/policy.ts";
import { createEvolutionCompilationEvidence } from "../../governance/model-access/evolution/evidence.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import { compileSpaceControlPolicy } from "../../out/sysml-toolkit/compilation-policies/governance/authority/space-execution-policy.ts";
import { compileModelEditPolicy } from "../../out/sysml-toolkit/compilation-policies/governance/model-access/editing/policy.ts";
import { compileInformationPolicies } from "../../work/information/policy.ts";
import { compileInitialTools } from "../../work/tools/initial-catalog.ts";
import { compileWorkResultContracts } from "../../out/sysml-toolkit/compilation-policies/work/result-policy.ts";
import { compileWorkBudgetPolicy } from "../../out/sysml-toolkit/compilation-policies/work/budget-policy.ts";
import { compileCaseTypes } from "../../out/sysml-toolkit/compilation-policies/work/case-types.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { validateNetworkScope } from "../../../domain/governance/policies/network-policy.ts";
import { PinnedExecutableCache } from "../../../infrastructure/pinned-executable-cache.ts";

type Element = Record<string, unknown>;
type Sources = Record<string, string>;

export interface SourceRevision {
  version: string;
  sources: Sources;
  elements: Element[];
}

export interface SourceRepository {
  initialize(sources: Sources): Promise<SourceRevision>;
  current(): Promise<SourceRevision>;
  headVersion?(): Promise<string | null>;
  at(version: string): Promise<SourceRevision>;
  header?(version: string): Promise<ModelRevisionHeader>;
  listProposals?(): Promise<
    readonly (ModelSourceProposalStatus & { author: string })[]
  >;
  history?(options?: { limit?: number }): Promise<{
    headVersion: string;
    truncated: boolean;
    commits: readonly Pick<
      PublishedModelRevision,
      "version" | "sourceDigest" | "author" | "createdAt"
    >[];
  }>;
  propose(
    input: {
      baseVersion: string;
      sources: Sources;
      author: string;
      reason: string;
      addresses?:
        import("../../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
      authorization?: ModelProposalAuthorization;
    },
  ): Promise<{ id: string; baseVersion: string; status: string }>;
  publishSystemSources(
    sources: Sources,
    expectedVersion: string,
    author: string,
  ): Promise<SourceRevision>;
  /** Pure source transformation, once under the repository's shared writer lock. */
  updateSystemSources(
    update: (current: SourceRevision) => Sources | Promise<Sources>,
    author: string,
    options?: SystemSourcesUpdateOptions,
  ): Promise<SourceRevision>;
  findPublication(
    changeId: string,
  ): Promise<{ revision: SourceRevision; receipt?: SourcePublication } | null>;
}

export interface SourceModelOptions {
  repository: SourceRepository;
  /** Namespaces the identity independently of an editor or mutable branch head. */
  projectId: string;
  /** Exact concrete ConversationSystem occurrence in the shared model. */
  systemQualifiedName?: string;
  sourcesDir?: URL;
  /** Explicit migration input prepared and backed up outside this adapter. */
  initialSources?: Sources;
  /** Required source tooling; stored compilation and admission stay unchanged. */
  tooling: ModelToolingPort;
  writer?: ModelWriteSubmissionPort;
  /** A branch publication of a Main Operator's decision: its recorded
   * delegated exercise, compared instead of Main's current policy (4.8c A2). */
  recordedDelegation?: { exercise: AuthorityExercise };
  /** A branch preview/publication: creation policies read in the
   * requester's branch with its verified whole-team size (4.8e E1/E4).
   * Absent on main, where the model's own main scope applies. */
  creationScope?:
    import("../../../domain/governance/policies/operator-creation-policy.ts").CreationScope;
}

function reference(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const id = (value as Element)["@id"];
  return typeof id === "string" ? id : undefined;
}

function references(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const id = reference(entry);
    return id ? [id] : [];
  });
}

function id(element: Element): string {
  const value = element["@id"];
  assert(
    typeof value === "string" && value.length > 0,
    "Missing model identity",
  );
  return value;
}

function one(
  revision: SourceRevision,
  name: string,
  metaclass?: string,
): Element {
  return modelSourceElement(
    revision,
    productNameInModel(revision.elements, name),
    metaclass,
  );
}

function owned(
  revision: SourceRevision,
  owner: string,
  name: string,
): Element {
  let found = revision.elements.filter((element) =>
    reference(element.owner) === owner && element.declaredName === name
  );
  if (found.length === 0) {
    const attributes = sourceLiterals(revision.elements).filter((value) =>
      value.owner === owner && value.name === name
    );
    found = attributes.flatMap((value) =>
      revision.elements.filter((element) =>
        element["@id"] === value.attributeId
      )
    );
  }
  assert(
    found.length === 1,
    `Expected one owned feature ${name}; found ${found.length}`,
  );
  return found[0]!;
}

function literal(revision: SourceRevision, attribute: Element): Element {
  const matches = sourceLiterals(revision.elements).filter((value) =>
    value.attributeId === id(attribute)
  );
  assert(
    matches.length === 1,
    `Expected one explicit feature value for ${attribute.qualifiedName}`,
  );
  const direct = revision.elements.find((element) =>
    element["@id"] === matches[0]!.literalId
  );
  assert(
    direct &&
      /^Literal(String|Boolean|Integer|Rational|Real)$/.test(
        String(direct["@type"]),
      ),
    `Expected an explicit literal for ${
      attribute.qualifiedName ?? id(attribute)
    }`,
  );
  return direct;
}

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
interface RemovedMember {
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
async function assertReinsertedMembers(
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
async function reviewerPromotionEdits(
  tooling: ModelToolingPort,
  revision: SourceRevision,
  sourcesDir: URL,
  systemQualifiedName: string,
  creating = false,
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
    await loadInitialSources(sourcesDir, { information: false }),
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
  if (!creating) {
    const reviewer = find(`${systemQualifiedName}::reviewer`, "PartUsage");
    const description = await describe(reviewer);
    if (
      description.types.length !== 1 ||
      !sameProductName(
        description.types[0]!.qualifiedName,
        "AssemblyLiveBuilder::IndependentReviewer",
      )
    ) fail("Reviewer migration requires one configured reviewer");
  }
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
        await Deno.readTextFile(
          new URL("configuration-reviewed-promotion.sysml", sourcesDir),
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
  if (legacy.length > 1 || creating && legacy.length) {
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
  const handled = new Set<string>();
  let legacyAllocations = 0, reviewAllocations = 0;
  const legacyConnectorIds: string[] = [];
  for (const connector of snapshot.connectors) {
    const sourceChain = connector.ends[0]?.chain ?? [];
    const viaLegacyReview = legacy.length === 1 &&
      sourceChain.length === 1 && sourceChain[0]?.id === id(legacy[0]!);
    if (viaLegacyReview) {
      const targetChain = connector.ends[1]?.chain ?? [];
      if (
        targetChain.length !== 1 ||
        byId.get(targetChain[0]!.id)?.qualifiedName !==
          `${systemQualifiedName}::reviewer`
      ) fail("Ambiguous reviewer migration: customized promotion allocation");
      legacyAllocations++;
      legacyConnectorIds.push(connector.id);
      handled.add(connector.id);
      continue;
    }
    if (
      connector.metaclass === "AllocationUsage" &&
      sourceChain[0]?.id === promotionId && sourceChain[1] &&
      byId.get(sourceChain[1].id)?.declaredName === "review"
    ) reviewAllocations++;
  }
  const exposureTargets = (view: Element): string[] => {
    const targets: string[] = [];
    for (const importId of references(view.ownedImport)) {
      const expose = byId.get(importId);
      if (!expose) continue;
      if (expose["@type"] === "NamespaceExpose") {
        const namespace = references(expose.importedNamespace)[0];
        if (namespace) targets.push(namespace);
        continue;
      }
      const membership = byId.get(
        references(expose.importedMembership)[0] ?? "",
      );
      const target = membership
        ? references(membership.memberElement)[0]
        : undefined;
      if (target) targets.push(target);
    }
    return targets;
  };
  // The reviewer view is the migration's own target, not a preserved
  // dependent: in migration it is replaced by the reviewed template, and a
  // customized one refuses. Exactly one agentOverview exposure of it is
  // required; builderActions stays optional and is handled generically.
  let reviewerActionsView: Element | undefined;
  let reviewerActionsNext: string | undefined;
  if (sameProductName(systemQualifiedName, DEFAULT_SYSTEM) && !creating) {
    reviewerActionsView = find(
      "AssemblyLiveBuilder::reviewerActions",
      "ViewUsage",
    );
    const overviews = revision.elements.filter((e) =>
      sameProductName(e.qualifiedName, "AssemblyLiveBuilder::agentOverview") &&
      e["@type"] === "ViewUsage"
    );
    const exposures = overviews.length === 1
      ? exposureTargets(overviews[0]!).filter((target) =>
        target === id(reviewerActionsView!)
      ).length
      : 0;
    if (exposures !== 1) {
      fail("Ambiguous reviewer migration: reviewer overview exposure");
    }
    reviewerActionsNext = (await Deno.readTextFile(
      new URL("configuration-reviewer-views.sysml", sourcesDir),
    )).trim();
    const expected = legacy.length
      ? reviewerActionsNext.replaceAll(
        "liveBuilder::promotion::review",
        "liveBuilder::review",
      )
      : reviewerActionsNext;
    if (
      normalizeMember((await describe(reviewerActionsView)).source.text) !==
        normalizeMember(expected)
    ) {
      fail(
        `Reviewer migration refuses a customized ${reviewerActionsView.declaredName} view`,
      );
    }
    handled.add(id(reviewerActionsView));
  }
  if (legacy.length) handled.add(id(legacy[0]!));
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
            if (handled.has(candidate.elementId)) return candidate;
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
  //
  // The reviewer view is replaced, so whatever references it (agentOverview's
  // `expose reviewerActions;`) must be removed before it and reinserted
  // verbatim after, like any dependent of a changed identity. Without the
  // builderActions dependent, that overview would otherwise stay in place and
  // removing the view would break its reference. The view joins `tainted`
  // only once the closure has converged without it: its referrers are then
  // discovered after every other dependent, so the reverse-order removals
  // below take them out first and a referrer never outlives a member it
  // references.
  let changed = true;
  let replacedView = reviewerActionsView;
  while (changed || replacedView) {
    if (!changed && replacedView) {
      tainted.add(id(replacedView));
      replacedView = undefined;
    }
    changed = false;
    for (const element of revision.elements) {
      const elementId = String(element["@id"]);
      if (
        handled.has(elementId) || removed.has(elementId) ||
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
      if (handled.has(member!.elementId) || removed.has(member!.elementId)) {
        continue;
      }
      removed.set(member!.elementId, member!);
      tainted.add(member!.elementId);
      changed = true;
    }
  }
  if (
    legacy.length !== legacyAllocations ||
    reviewAllocations !== (creating || legacy.length ? 0 : 1)
  ) fail("Ambiguous reviewer migration: review occurrence or allocation");
  let legacyAllocation: string | undefined;
  if (legacy.length) {
    const text = normalizeMember((await describe(legacy[0]!)).source.text);
    if (text !== "perform action review : APEPromotion::ReviewCandidate;") {
      fail("Ambiguous reviewer migration: customized review occurrence");
    }
    legacyAllocation = "allocate promotion.review to reviewer;";
  }
  // Batch 0 removes every dependent member (and the legacy pair and the old
  // reviewer view); batch 1 changes the promotion type; batch 2 reinserts
  // each removed member verbatim in its original owner. Reinsertion order
  // may differ from the original order: the Toolkit exposes no moveMember
  // operation through ModelToolingPort, so no position is rewritten.
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
  for (const connectorId of legacyConnectorIds) {
    staged.push({ op: "remove", target: { elementId: connectorId }, batch: 0 });
  }
  if (reviewerActionsView) {
    staged.push({
      op: "remove",
      target: {
        qualifiedName: String(reviewerActionsView.qualifiedName),
      },
      batch: 0,
    });
  }
  // The legacy occurrence is removed last: the legacy allocation above and
  // the reviewer view both still reference it until they are gone.
  if (legacy.length) {
    staged.push({
      op: "remove",
      target: { qualifiedName: `${systemQualifiedName}::review` },
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
  if (legacyAllocation) {
    staged.push({
      op: "insertMember",
      owner: { qualifiedName: systemQualifiedName },
      text: legacyAllocation,
      expect: [],
      batch: 1,
    });
  }
  for (const member of removed.values()) {
    staged.push({
      op: "insertMember",
      owner: { qualifiedName: member.ownerQualifiedName },
      text: member.text,
      expect: [],
      batch: 2,
    });
  }
  if (reviewerActionsNext) {
    staged.push({
      op: "insertMember",
      owner: {
        qualifiedName: productNameInModel(
          revision.elements,
          "AssemblyLiveBuilder",
        ),
      },
      text: reviewerActionsNext,
      expect: [],
      batch: 2,
    });
  }
  return { requests: staged, removedMembers: [...removed.values()] };
}

/** Check the immutable published revision, including when the updater was skipped. */
async function assertPublishedEdits(
  revision: SourceRevision,
  receipt: SourcePublication,
  systemId: string,
): Promise<void> {
  try {
    await verifyPublicationReadback(receipt.edits, {
      scalarTarget: (edit) => {
        let attribute = revision.elements.find((element) =>
          element["@id"] === edit.owner
        );
        assert(attribute, `Missing publication owner: ${edit.owner}`);
        for (const name of edit.name.split("::")) {
          attribute = owned(revision, id(attribute), name);
        }
        const target = modelToolingTarget(revision, id(attribute));
        return {
          id: id(attribute),
          qualifiedName: target.qualifiedName,
          metaclass: target.metaclass,
          preimage: "", // Historical scalar receipts have no preparation preimage.
        };
      },
      verify: (edits) => verifyEdits(revision, edits),
    });
  } catch (error) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: receipt.changeId,
      systemId,
    }, error instanceof Error ? error.message : String(error));
  }
}

async function candidateName(candidate: Candidate): Promise<string> {
  assert(
    candidate.id && /^[a-f0-9]{64}$/i.test(candidate.digest),
    "Candidate identity/digest missing",
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(candidate.id),
    ),
  );
  return "tool_" +
    Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
      .slice(0, 24);
}

/** Omitted scope is the persisted historical ASE identity encoding. */
const DEFAULT_SYSTEM = "ASELiveBuilder::liveBuilder";

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

async function compileScopedExecutable(
  revision: SourceRevision,
  identity: ModelIdentity,
  managedSystemIds: readonly string[],
  captureDigestInput?: (input: Record<string, unknown>) => void,
): Promise<ExecutableModel> {
  const hash = (input: Record<string, unknown>) => {
    captureDigestInput?.(structuredClone(input));
    return executionDigest(input);
  };
  const snapshot = sourceSnapshot(revision.elements, identity.rootId);
  const graph = projectSourceGraph(revision.elements, identity);
  const caseTypes = compileCaseTypes(
    snapshot,
    sourceValues(revision.elements),
    identity,
  );
  const model = await compileExecutableModel(
    snapshot,
    { ...graph, diagnostics: graph.executionDiagnostics ?? graph.diagnostics },
    sourceLiterals(revision.elements),
    identity,
    caseTypes,
    captureDigestInput,
    resolveNativeActionBaseIds(revision.elements),
  );
  model.version.repositoryVersion = revision.version;
  const evolutionPolicy = compileEvolutionPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (evolutionPolicy) {
    model.evolutionPolicy = evolutionPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      evolutionPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...evolutionPolicy.sourceIds]),
    ].sort();
  }
  const behaviors = compileBehaviorCatalog(
    revision,
    identity,
    managedSystemIds,
  );
  if (behaviors.length) {
    model.behaviors = behaviors;
    model.version.digest = await hash({
      base: model.version.digest,
      behaviors,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...behaviors.flatMap((behavior) => behavior.sourceIds),
      ]),
    ].sort();
  }
  const teamLiterals = sourceLiterals(revision.elements).filter((literal) =>
    literal.owner === identity.systemId
  );
  const teamFields = [
    "creationParentOperatorId",
    "originatingRequestOperatorId",
    "originatingRequestId",
  ];
  if (teamLiterals.some((literal) => teamFields.includes(literal.name))) {
    const teamValue = (name: string) => {
      const found = teamLiterals.filter((literal) => literal.name === name);
      assert(
        found.length === 1 && found[0]!.kind === "LiteralString" &&
          found[0]!.typeNames.length === 1 &&
          found[0]!.typeNames[0] === "ScalarValues::String" &&
          !!found[0]!.value.trim(),
        `Expected one typed native team origin ${name}`,
      );
      return found[0]!;
    };
    const parent = teamValue("creationParentOperatorId"),
      owner = teamValue("originatingRequestOperatorId"),
      request = teamValue("originatingRequestId");
    const policy = teamLiterals.some((literal) =>
        literal.name === "creationPolicyId"
      )
      ? teamValue("creationPolicyId")
      : undefined;
    model.operatorTeam = {
      parentOperatorId: parent.value,
      requestOwnerId: owner.value,
      requestId: request.value,
      ...(policy ? { creationPolicyId: policy.value } : {}),
    };
    model.version.digest = await hash({
      base: model.version.digest,
      operatorTeam: model.operatorTeam,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...[parent, owner, request, ...(policy ? [policy] : [])].flatMap((
          literal,
        ) => [literal.attributeId, literal.literalId]),
      ]),
    ].sort();
  }
  const entries = compileOperatorEntries(revision.elements, identity);
  if (entries.length) {
    model.operatorEntries = entries;
    model.version.digest = await hash({
      base: model.version.digest,
      operatorEntries: entries,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...entries.flatMap((entry) => entry.sourceIds),
      ]),
    ].sort();
  }
  const spaceControlPolicy = compileSpaceControlPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (spaceControlPolicy) {
    model.spaceControlPolicy = spaceControlPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      spaceControlPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...spaceControlPolicy.sourceIds]),
    ].sort();
  }
  const modelEditPolicy = compileModelEditPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (modelEditPolicy) {
    model.modelEditPolicy = modelEditPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      modelEditPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...modelEditPolicy.sourceIds]),
    ].sort();
  }
  const administration = compileModelAdministrationPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (administration) {
    model.modelAdministrationPolicy = administration;
    model.version.digest = await hash({
      base: model.version.digest,
      administration,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...administration.sourceIds]),
    ].sort();
  }
  const information = compileInformationPolicies(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (Object.keys(information).length) {
    Object.assign(model, information);
    model.version.digest = await hash({
      base: model.version.digest,
      information,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...[
          information.contextPolicy,
          information.memoryPolicy,
          information.skillPolicy,
          ...(information.initialSkills ?? []),
          ...(information.modelingGuidance ?? []),
        ].flatMap((policy) => policy?.sourceIds ?? []),
      ]),
    ].sort();
  }
  assert(
    !entries.some((entry) => entry.kind.startsWith("memory-")) ||
      !!model.memoryPolicy,
    "Native memory entries require their admitted local memory policy",
  );
  assert(
    !entries.some((entry) => entry.kind === "context-evidence") ||
      !!model.contextPolicy,
    "Native context evidence requires its admitted context policy",
  );
  assert(
    !entries.some((entry) => entry.kind.startsWith("skill-")) ||
      !!model.skillPolicy,
    "Native skill entries require their admitted local skill policy",
  );
  if (model.initialSkills?.length) {
    assert(
      entries.some((entry) =>
        entry.kind === "skill-install" &&
        behaviors.some((behavior) =>
          behavior.targetNativeId === entry.id &&
          behavior.callerNativeId === identity.builderId
        )
      ),
      "Initial skills require an admitted local installation exposure",
    );
  }
  if (model.initialSkills?.some((skill) => skill.loaded)) {
    for (const kind of ["skill-list", "skill-load"] as const) {
      assert(
        entries.some((entry) =>
          entry.kind === kind &&
          behaviors.some((behavior) =>
            behavior.targetNativeId === entry.id &&
            behavior.callerNativeId === identity.builderId
          )
        ),
        "Initial loaded skills require admitted local listing and loading exposures",
      );
    }
  }
  const initialTools = compileInitialTools(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (initialTools.length) {
    model.initialTools = initialTools;
    model.version.digest = await hash({
      base: model.version.digest,
      initialTools,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...initialTools.flatMap((tool) => tool.sourceIds),
      ]),
    ].sort();
  }
  const workBudgetPolicy = compileWorkBudgetPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (workBudgetPolicy) {
    model.workBudgetPolicy = workBudgetPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      workBudgetPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...workBudgetPolicy.sourceIds]),
    ].sort();
  }
  const workResultContracts = compileWorkResultContracts(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
    behaviors,
    revision.elements,
  );
  if (workResultContracts.length) {
    model.workResultContracts = workResultContracts;
    model.version.digest = await hash({
      base: model.version.digest,
      workResultContracts,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...workResultContracts.flatMap((contract) => contract.sourceIds),
      ]),
    ].sort();
  }
  if (caseTypes.length) {
    model.caseTypes = caseTypes;
    model.version.digest = await hash({
      base: model.version.digest,
      caseTypes,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...caseTypes.flatMap((caseType) => caseType.sourceIds),
      ]),
    ].sort();
  }
  return model;
}

function isModelRevisionId(version: string): boolean {
  try {
    parseModelRevisionId(version);
    return true;
  } catch {
    return false;
  }
}

type ValidatedSourceExecutables = Array<
  { unit: ConversationUnitIdentity; model: ExecutableModel }
>;
const sourceExecutableCache = new Map<
  string,
  Promise<ValidatedSourceExecutables>
>();

/** Compile every admitted scope once, retaining the ordinary compilation refusals. */
export async function validateSourceExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ValidatedSourceExecutables> {
  return structuredClone(await cachedSourceExecutables(revision, projectId));
}

async function cachedSourceExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ValidatedSourceExecutables> {
  // Unpublished compilations and mutable fixture identities are never reusable.
  if (!isModelRevisionId(revision.version)) {
    return await compileSourceExecutables(revision, projectId);
  }
  // Verification can label changed sources with the base commit until admission.
  const sourceDigest = await modelSourceDigest(revision.sources);
  const key = JSON.stringify([projectId, revision.version, sourceDigest]);
  let entry = sourceExecutableCache.get(key);
  if (!entry) {
    entry = compileSourceExecutables(revision, projectId);
    sourceExecutableCache.set(key, entry);
    if (sourceExecutableCache.size > 16) {
      sourceExecutableCache.delete(sourceExecutableCache.keys().next().value!);
    }
  }
  try {
    return await entry;
  } catch (error) {
    if (sourceExecutableCache.get(key) === entry) {
      sourceExecutableCache.delete(key);
    }
    throw error;
  }
}

async function compileSourceExecutables(
  revision: SourceRevision,
  projectId: string,
  captured?: Map<string, Record<string, unknown>[]>,
): Promise<ValidatedSourceExecutables> {
  const units = discoverConversationUnits(revision, projectId);
  if (units.length > MAX_OPERATOR_UNITS) {
    throw new OperatorAuthorityError(
      "OPERATOR_CAPACITY_EXCEEDED",
      `The admitted source exceeds the technical registry limit of ${MAX_OPERATOR_UNITS} operators`,
    );
  }
  const managedSystemIds = units.map((unit) => unit.identity.systemId);
  const compiled: Array<
    { unit: ConversationUnitIdentity; model: ExecutableModel }
  > = [];
  for (const unit of units) {
    const inputs: Record<string, unknown>[] = [];
    if (captured) captured.set(unit.systemQualifiedName, inputs);
    compiled.push({
      unit,
      model: await compileScopedExecutable(
        revision,
        unit.identity,
        managedSystemIds,
        captured ? (input) => inputs.push(input) : undefined,
      ),
    });
  }
  const authorityRoots = modelEditingAuthorityRoots(
    sourceSnapshot(revision.elements, `${projectId}/root`).elements,
  );
  for (const { model } of compiled) {
    model.modelEditingAuthorityRoots = authorityRoots;
  }
  await applyModelDelegations(
    revision,
    compiled.map(({ unit, model }) => ({
      systemQualifiedName: unit.systemQualifiedName,
      model,
    })),
    captured
      ? (name, input) => captured.get(name)!.push(structuredClone(input))
      : undefined,
  );
  const primary = compiled.filter(({ model }) => model.operator?.primary);
  assert(primary.length <= 1, "Ambiguous native primary conversation endpoint");
  const primaryUnit = primary[0] ??
    compiled.find(({ unit }) =>
      sameProductName(unit.systemQualifiedName, DEFAULT_SYSTEM)
    ) ??
    (compiled.length === 1 ? compiled[0] : undefined);
  const membershipUnits = compiled.filter(({ model }) => !model.operatorTeam);
  if (membershipUnits.length > 1 && primaryUnit) {
    // Admission of the main contact covers who belongs to this operator system
    // and which human inboxes are exposed, without coupling it to a peer's
    // instructions, work state or tool-catalog observations. Request-scoped
    // teams belong to their admitted creator, not Main's human inbox contract.
    const operatorMembership = membershipUnits.map(({ unit, model }) => ({
      systemQualifiedName: unit.systemQualifiedName,
      systemId: model.identity.systemId,
      agentId: model.identity.builderId,
      ...(model.identity.reviewerId
        ? { reviewerId: model.identity.reviewerId }
        : {}),
      primary: model.operator?.primary ?? model === primaryUnit.model,
      humanInput: model.operator?.humanInput ?? model === primaryUnit.model,
    }));
    const membershipDigestInput = {
      base: primaryUnit.model.version.digest,
      operatorMembership,
    };
    if (captured) {
      captured.get(primaryUnit.unit.systemQualifiedName)!.push(
        structuredClone(membershipDigestInput),
      );
    }
    primaryUnit.model.version.digest = await executionDigest(
      membershipDigestInput,
    );
    primaryUnit.model.version.sourceIds = [
      ...new Set([
        ...primaryUnit.model.version.sourceIds,
        ...operatorMembership.flatMap((entry) => [
          entry.systemId,
          entry.agentId,
          ...(entry.reviewerId ? [entry.reviewerId] : []),
        ]),
      ]),
    ].sort();
  }
  return compiled;
}

/** Compile fresh, complete evidence for all consumers without changing legacy digests. */
export async function validateSourceEvolutionExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ScopedExecutableModel[]> {
  const captured = new Map<string, Record<string, unknown>[]>();
  const compiled = await compileSourceExecutables(
    revision,
    projectId,
    captured,
  );
  return await Promise.all(compiled.map(async ({ unit, model }) => ({
    systemQualifiedName: unit.systemQualifiedName,
    model,
    evidence: await createEvolutionCompilationEvidence(
      model,
      captured.get(unit.systemQualifiedName)!,
      revision.elements,
    ),
  })));
}

/** Validate the complete shared source version before any scope is published. */
export async function validateSourceExecutable(
  revision: SourceRevision,
  projectId: string,
  systemQualifiedName?: string,
): Promise<ExecutableModel> {
  const compiled = await cachedSourceExecutables(revision, projectId);
  return structuredClone(
    selectValidatedSourceExecutable(compiled, systemQualifiedName),
  );
}

/** Select from a complete validated collection with the same default rules. */
export function selectValidatedSourceExecutable(
  compiled: ValidatedSourceExecutables,
  systemQualifiedName?: string,
): ExecutableModel {
  const primary = compiled.filter(({ model }) => model.operator?.primary);
  const requested = systemQualifiedName ??
    primary[0]?.unit.systemQualifiedName ??
    (compiled.some(({ unit }) =>
        sameProductName(unit.systemQualifiedName, DEFAULT_SYSTEM)
      )
      ? compiled.find(({ unit }) =>
        sameProductName(unit.systemQualifiedName, DEFAULT_SYSTEM)
      )!.unit.systemQualifiedName
      : compiled.length === 1
      ? compiled[0]!.unit.systemQualifiedName
      : undefined);
  const selected = compiled.filter(({ unit }) =>
    sameProductName(unit.systemQualifiedName, requested ?? "")
  );
  assert(selected.length === 1, "Select an exact native conversation system");
  return selected[0]!.model;
}

export class SourceModel implements ModelPort {
  readonly repository: SourceRepository;
  readonly proposeEdit: ModelPort["proposeEdit"];
  readonly #projectId: string;
  #systemQualifiedName: string;
  readonly #sourcesDir: URL;
  readonly #seed?: Sources;
  readonly #recordedDelegation?: { exercise: AuthorityExercise };
  readonly #creationScope?: SourceModelOptions["creationScope"];
  readonly #tooling: ModelToolingPort;
  readonly #writer?: ModelWriteSubmissionPort;
  readonly #executablePins = new PinnedExecutableCache<{
    identity: ModelIdentity;
    model: ExecutableModel;
  }>(16);

  constructor(options: SourceModelOptions) {
    assert(
      /^git:[a-f0-9-]{36}$/.test(options.projectId),
      "Model identity must belong to a local Git project",
    );
    this.repository = options.repository;
    this.#tooling = options.tooling;
    this.#writer = options.writer;
    this.#projectId = options.projectId;
    this.#systemQualifiedName = options.systemQualifiedName ??
      canonicalProductName(DEFAULT_SYSTEM);
    this.#sourcesDir = options.sourcesDir ??
      new URL("../../../../models/", import.meta.url);
    this.#seed = options.initialSources
      ? structuredClone(options.initialSources)
      : undefined;
    this.#recordedDelegation = options.recordedDelegation;
    this.#creationScope = options.creationScope
      ? structuredClone(options.creationScope)
      : undefined;
    this.proposeEdit = (identity, request, expectedDigest) =>
      this.#proposeEdit(this.#tooling, identity, request, expectedDigest);
  }

  /** Where creation policies are read for this model: the caller's branch
   * scope on a branch preview/publication, the main scope otherwise. */
  #scopeFor(current: Pick<ExecutableModel, "identity">) {
    return this.#creationScope ?? mainCreationScope(current.identity);
  }

  async #proposeEdit(
    tooling: ModelToolingPort,
    identity: ModelIdentity,
    input: ModelEditRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before targeted source proposal",
    );
    assert(
      current.policy.mayProposeSysmlRevision === true,
      "The admitted model does not permit SysML revision proposals",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    // Check operation authority before invoking the editor. The repository checks
    // the complete compiled output, including every rewritten reference, afterwards.
    await createOperatorEditAuthorization(
      current,
      await this.repository.at(current.version.repositoryVersion!),
      request.edits.map((edit) => edit.kind),
    );
    assert(
      typeof request.sourceDigest === "string" &&
        request.sourceDigest === await modelSourceDigest(base.sources),
      "Source digest differs from the consulted source version",
    );
    const result = await tooling.edit(
      base.sources,
      resolveModelEdits(base, request.edits),
    );
    assertSourceSplices(base.sources, result, {
      // This checks the whole call, including rename and general expressions;
      // no individual Host operation can accurately identify the divergence.
      opIndex: -1,
      op: "proposeEdit",
      target: { qualifiedName: this.#systemQualifiedName },
    });
    // The ordinary path rechecks the current authority, compiles with the embedded Toolkit,
    // and writes an isolated proposal. It never adopts or activates the edit.
    return await this.#proposeSourceChanges(
      identity,
      {
        baseVersion: request.baseVersion,
        sources: result.sources,
        reason: request.reason,
        ...(request.addresses !== undefined
          ? { addresses: request.addresses }
          : {}),
      },
      expectedDigest,
      request.edits.map((edit) => edit.kind),
    );
  }

  async proposeDelegation(
    identity: ModelIdentity,
    input: ModelDelegationRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before administration proposal",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    assert(
      request.sourceDigest === await modelSourceDigest(base.sources),
      "Source digest differs from the consulted source version",
    );
    const prepared = await prepareModelAdministration(
      base,
      this.#projectId,
      current,
      request.change,
    );
    const record = await this.repository.propose({
      baseVersion: request.baseVersion,
      sources: prepared.sources,
      author: `agent:${identity.builderId}`,
      reason: request.reason,
      authorization: prepared.authorization,
    });
    assert(
      record.status === "proposed",
      "Repository did not persist an administration proposal",
    );
    return {
      id: record.id,
      baseVersion: record.baseVersion,
      status: "pending",
    };
  }

  async #initialSources(): Promise<Sources> {
    return await loadInitialSources(this.#sourcesDir);
  }

  #identity(revision: SourceRevision): ModelIdentity {
    const identity = sourceModelIdentity(
      revision,
      this.#projectId,
      this.#systemQualifiedName,
    );
    this.#systemQualifiedName = identity.systemQualifiedName ?? DEFAULT_SYSTEM;
    return identity;
  }

  #verifyStable(identity: ModelIdentity, revision: SourceRevision): void {
    this.#verifyStableIdentity(identity, this.#identity(revision));
  }

  #verifyProject(identity: ModelIdentity): void {
    assert(
      identity.projectId === this.#projectId &&
        identity.editingContextId === `${this.#projectId}/main`,
      "Foreign model identity: use a separate project instance",
    );
  }

  #verifyStableIdentity(identity: ModelIdentity, actual: ModelIdentity): void {
    this.#verifyProject(identity);
    assert(
      !identity.systemQualifiedName ||
        identity.systemQualifiedName ===
          (actual.systemQualifiedName ?? DEFAULT_SYSTEM),
      "Native conversation scope changed",
    );
    for (
      const field of ["rootId", "systemId", "catalogId", "builderId"] as const
    ) {
      assert(
        actual[field] === identity[field],
        `Native model identity drift: ${field}`,
      );
    }
  }

  #verify(identity: ModelIdentity, revision: SourceRevision): void {
    this.#verifyStable(identity, revision);
    const actual = this.#identity(revision);
    if (identity.reviewerId) {
      assert(
        actual.reviewerId === identity.reviewerId,
        "Native reviewer identity drift",
      );
    }
  }

  async initialize(
    existing?: ModelIdentity,
    configuration?: SystemConfiguration,
  ): Promise<ModelIdentity> {
    if (existing) {
      assert(
        existing.projectId === this.#projectId,
        "Foreign model identity: use a separate project instance",
      );
    }
    await this.repository.initialize(
      this.#seed ?? await this.#initialSources(),
    );
    // An empty instance identifier is a technical provisioning value. Declared
    // behavior, rights, scope and policy are retained exactly from the sources.
    let prepared: Awaited<ReturnType<typeof applyEdits>> | undefined;
    let head: SourceRevision;
    let expectedId: string;
    const revision = await this.repository.updateSystemSources(
      async (revision) => {
        head = revision;
        const identity = this.#identity(revision);
        if (existing) this.#verify(existing, revision);
        const configId = owned(revision, identity.systemId, "configurationId");
        if (literal(revision, configId).value !== "") return revision.sources;
        expectedId = configuration?.id ?? crypto.randomUUID();
        prepared = await applyEdits(this.#tooling, revision, [{
          op: "setFeatureValue",
          target: { elementId: id(configId) },
          value: expectedId,
        }]);
        return prepared.sources;
      },
      "ase:provision-instance-id",
      {
        verify: async (candidate) => {
          if (!prepared) return;
          await verifyEdits(candidate, prepared.edits, { base: head });
          const executable = await this.#executable(candidate);
          if (executable.configuration.id !== expectedId) {
            throw new HostEditError("READ_BACK_MISMATCH", {
              opIndex: 0,
              op: prepared.edits[0]!.op,
              target: hostEditTarget(prepared.edits[0]!),
            }, "Provisioned configuration identity differs");
          }
        },
      },
    );
    return this.#identity(revision);
  }

  async currentRevision(identity: ModelIdentity): Promise<SourceRevision> {
    const revision = await this.repository.current();
    this.#verify(identity, revision);
    return revision;
  }

  async #executable(revision: SourceRevision): Promise<ExecutableModel> {
    return await validateSourceExecutable(
      revision,
      this.#projectId,
      this.#systemQualifiedName,
    );
  }

  async validateRevision(
    revision: SourceRevision,
  ): Promise<ExecutableModel> {
    return await this.#executable(revision);
  }

  async readExecutableModel(
    identity: ModelIdentity,
    repositoryVersion?: string,
  ): Promise<ExecutableModel> {
    this.#verifyProject(identity);
    const version = repositoryVersion ?? await this.repository.headVersion?.();
    if (version && isModelRevisionId(version)) {
      const value = await this.#executablePins.read(version, async () => {
        const revision = await this.repository.at(version);
        assert(
          revision.version === version,
          "Loaded model revision differs from requested pin",
        );
        this.#verify(identity, revision);
        const actual = this.#identity(revision);
        return { identity: actual, model: await this.#executable(revision) };
      }, ({ identity: actual }) => {
        this.#verifyStableIdentity(identity, actual);
        if (identity.reviewerId) {
          assert(
            actual.reviewerId === identity.reviewerId,
            "Native reviewer identity drift",
          );
        }
      });
      return value.model;
    }
    const revision = repositoryVersion
      ? await this.repository.at(repositoryVersion)
      : await this.currentRevision(identity);
    this.#verify(identity, revision);
    return await this.#executable(revision);
  }

  async readSourceRevision(
    identity: ModelIdentity,
  ): Promise<ModelSourceRevision> {
    let revision = await this.currentRevision(identity);
    if (!this.repository.history) {
      return {
        version: revision.version,
        sources: structuredClone(revision.sources),
      };
    }
    const limit = 32;
    const history = await this.repository.history({ limit });
    if (history.headVersion !== revision.version) {
      revision = await this.repository.at(history.headVersion);
      this.#verify(identity, revision);
      assert(
        revision.version === history.headVersion,
        "Source snapshot does not match the publication history head",
      );
    }
    const proposals = this.repository.listProposals
      ? await this.repository.listProposals()
      : [];
    const proposalLimit = 64;
    let remainingProposals = proposalLimit;
    let proposalsTruncated = false;
    const commits = history.commits.slice(0, limit).map((commit) => {
      const accepted = proposals.filter((proposal) =>
        proposal.status === "accepted" &&
        proposal.acceptedVersion === commit.version
      );
      const selected = accepted.slice(0, remainingProposals);
      remainingProposals -= selected.length;
      if (selected.length < accepted.length) proposalsTruncated = true;
      return {
        version: commit.version,
        sourceDigest: commit.sourceDigest,
        author: commit.author,
        createdAt: commit.createdAt,
        ...(selected.length > 0
          ? {
            proposals: selected.map(({ id, author }) => ({ id, author })),
          }
          : {}),
      };
    });
    return structuredClone({
      version: revision.version,
      sources: revision.sources,
      publishedRevisions: {
        limit,
        proposalLimit,
        truncated: history.truncated || history.commits.length > limit ||
          proposalsTruncated,
        commits,
      },
    });
  }

  async readSourceProposals(
    identity: ModelIdentity,
  ): Promise<ModelSourceProposalStatus[]> {
    await this.currentRevision(identity);
    if (!this.repository.listProposals) return [];
    const proposals = await this.repository.listProposals();
    return structuredClone(
      proposals.filter((proposal) =>
        proposal.author === `agent:${identity.builderId}`
      ).map((proposal) => ({
        id: proposal.id,
        baseVersion: proposal.baseVersion,
        status: proposal.status,
        ...(proposal.addresses !== undefined
          ? { addresses: proposal.addresses }
          : {}),
        ...(proposal.acceptedVersion !== undefined
          ? { acceptedVersion: proposal.acceptedVersion }
          : {}),
      })),
    );
  }

  async proposeRevision(
    identity: ModelIdentity,
    request: ModelRevisionRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    return await this.#proposeSourceChanges(identity, request, expectedDigest, [
      "replace-source",
    ]);
  }

  async #proposeSourceChanges(
    identity: ModelIdentity,
    input: ModelRevisionRequest,
    expectedDigest: string,
    operations: readonly ModelEditOperation[],
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before source proposal",
    );
    assert(
      current.policy.mayProposeSysmlRevision === true,
      "The admitted model does not permit SysML revision proposals",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    const authorization = await createOperatorEditAuthorization(
      current,
      await this.repository.at(current.version.repositoryVersion!),
      operations,
    );
    const sources = { ...base.sources, ...request.sources };
    const record = await this.repository.propose({
      baseVersion: request.baseVersion,
      sources,
      author: `agent:${identity.builderId}`,
      reason: request.reason,
      authorization,
      ...(request.addresses !== undefined
        ? { addresses: request.addresses }
        : {}),
    });
    assert(
      record.status === "proposed",
      "Repository did not persist a validated source proposal",
    );
    return {
      id: record.id,
      baseVersion: record.baseVersion,
      status: "pending",
      ...(request.addresses !== undefined
        ? { addresses: request.addresses }
        : {}),
    };
  }

  async findApprovedChange(
    identity: ModelIdentity,
    changeId: string,
  ): Promise<ApprovedChangePublication | null> {
    const published = await this.repository.findPublication(changeId);
    if (!published) return null;
    assert(
      published.receipt?.type !== "candidate-activation",
      "Expected a mandate publication",
    );
    this.#verifyStable(identity, published.revision);
    if (published.receipt) {
      await assertPublishedEdits(
        published.revision,
        published.receipt,
        identity.systemId,
      );
    }
    return {
      model: await this.#executable(published.revision),
      receipt: published.receipt,
    };
  }

  async #prepareApprovedChange(
    identity: ModelIdentity,
    revision: SourceRevision,
    change: PendingChange,
    expectedDigest: string,
    preview = false,
  ) {
    const requirePriorAuthority = (condition: unknown, message: string) => {
      if (!condition) {
        throw new AuthorityInvariantError(
          3,
          "ADMISSION_NOT_AUTHORIZED",
          message,
        );
      }
    };
    const edits: Array<
      { owner: string; name: string; value: string | boolean | number }
    > = [];
    this.#verify(identity, revision);
    if (change.kind === "operator-creation") {
      assertOperatorCreationCapacity(
        discoverConversationUnits(revision, identity.projectId).length,
      );
    }
    const current = await this.#executable(revision);
    if (
      current.version.digest !== expectedDigest ||
      current.configuration.revision !== change.baseRevision ||
      (change.baseModelDigest !== undefined &&
        change.baseModelDigest !== current.version.digest)
    ) {
      throw new AuthorityInvariantError(
        3,
        "STALE_PROPOSAL",
        "Execution model changed before source approval",
      );
    }
    if (!preview) {
      assertChangeAuthorityReceipt(
        current,
        change,
        this.#scopeFor(current),
        this.#recordedDelegation,
      );
    }
    if (
      !preview && change.kind === "operator-creation" && change.operator &&
      !isTeamOperatorSpec(change.operator) && change.operator.creationGrant &&
      (change.authority !== "human" ||
        change.authorityExercise?.creationDelegation)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "An independent operator's initial creation grant requires its explicit human creation decision",
      );
    }
    assertApprovable(current, change, this.#scopeFor(current));
    if (
      !preview && change.requestedRights &&
      ("operatorAuthority" in change.requestedRights ||
        "toolAdmission" in change.requestedRights ||
        "operatorCreation" in change.requestedRights) &&
      !change.diff
    ) {
      throw new OperatorAuthorityError(
        "CHANGE_PREVIEW_MISMATCH",
        "Operator policy approval requires the displayed source diff",
        { changeId: change.id },
      );
    }
    if (
      change.kind === "operator-creation" ||
      change.requestedRights &&
        ("grantModelEditing" in change.requestedRights ||
          "operatorAuthority" in change.requestedRights ||
          "toolAdmission" in change.requestedRights ||
          "operatorCreation" in change.requestedRights)
    ) {
      return await this.#prepareOperatorAuthorityChange(
        revision,
        current,
        change,
      );
    }
    const mandate = owned(revision, identity.systemId, "builderMandate");
    const mandateId = id(mandate);
    const operations: HostEditRequest[] = [];
    let removedMembers: RemovedMember[] = [];
    if (change.kind === "mandate-change") {
      const rights = change.requestedRights;
      assert(
        rights && Object.keys(rights).length === 1,
        "Unsupported exact mandate change",
      );
      if ("addNetworkHosts" in rights) {
        requirePriorAuthority(
          current.policy.mayAddNetworkHosts,
          "Source policy forbids network additions",
        );
        const additions =
          validateNetworkScope({ allowedHosts: rights.addNetworkHosts })
            .allowedHosts;
        assert(
          additions.length > 0 && additions.length <= 8 &&
            additions.every((host) =>
              !current.configuration.network!.allowedHosts.includes(host)
            ),
          "Network addition is not exact and new",
        );
        const network = validateNetworkScope({
          allowedHosts: [
            ...current.configuration.network!.allowedHosts,
            ...additions,
          ],
        });
        edits.push({
          owner: identity.systemId,
          name: "networkHosts",
          value: JSON.stringify(network.allowedHosts),
        });
      } else if (
        "mayAdmitOwnCandidates" in rights &&
        rights.mayAdmitOwnCandidates === true
      ) {
        requirePriorAuthority(
          current.policy.mayDelegateOwnAdmission &&
            current.configuration.builder.admissionAuthority === "human",
          "Source policy forbids own-admission delegation",
        );
        edits.push({ owner: mandateId, name: "mayAdmit", value: true }, {
          owner: identity.systemId,
          name: "admissionMode",
          value: "builder",
        });
      } else if ("setUrlSelectionMode" in rights) {
        requirePriorAuthority(
          current.policy.mayChangeUrlSelection &&
            ["user-provided", "authorized-host"].includes(
              String(rights.setUrlSelectionMode),
            ),
          "Source policy forbids this URL selection change",
        );
        const conversation = owned(
          revision,
          identity.systemId,
          "conversation",
        );
        const policy = owned(revision, id(conversation), "executionPolicy");
        edits.push({
          owner: id(policy),
          name: "urlSelectionMode",
          value: String(rights.setUrlSelectionMode),
        });
      } else throw new Error("Unsupported exact mandate change");
    } else if (change.kind === "reviewer-creation") {
      requirePriorAuthority(
        current.policy.mayCreateReviewer &&
          !current.configuration.reviewer &&
          change.role === "reviewer" && change.name?.trim() &&
          change.name.length <= 80 && change.mandate &&
          Object.keys(change.mandate).length === 2 &&
          change.mandate.mayReviewExactCandidate === true &&
          change.mandate.mayAdmitReviewedCandidates === true,
        "Source policy forbids this exact reviewer declaration",
      );
      const reviewer = declareReviewer(
        await Deno.readTextFile(
          new URL("configuration-reviewer.sysml", this.#sourcesDir),
        ),
        change.id,
        change.name,
      );
      {
        const migration = await reviewerPromotionEdits(
          this.#tooling,
          revision,
          this.#sourcesDir,
          this.#systemQualifiedName,
          true,
        );
        operations.push(...migration.requests);
        removedMembers = migration.removedMembers;
      }
      operations.push({
        op: "insertMember",
        batch: 1,
        owner: { qualifiedName: this.#systemQualifiedName },
        text: productSourceForModel(reviewer, revision.elements),
        expect: [],
      });
      if (sameProductName(this.#systemQualifiedName, DEFAULT_SYSTEM)) {
        operations.push({
          op: "insertMember",
          batch: 1,
          owner: {
            qualifiedName: productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder",
            ),
          },
          text: productSourceForModel(
            await Deno.readTextFile(
              new URL("configuration-reviewer-views.sysml", this.#sourcesDir),
            ),
            revision.elements,
          ),
          expect: [],
        });
        // Batch 2: the overview may itself be a removed and reinserted
        // dependent, so its new exposure lands after reinsertion (the host
        // writer defers it until the overview exists in that batch).
        operations.push({
          op: "insertMember",
          batch: 2,
          owner: {
            qualifiedName: productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder::agentOverview",
            ),
          },
          text: "expose reviewerActions;",
          expect: [],
        });
      }
      edits.push({ owner: mandateId, name: "mayAdmit", value: false }, {
        owner: identity.systemId,
        name: "admissionMode",
        value: "reviewer",
      });
    } else throw new Error("Unsupported exact source change");
    const next = current.configuration.builder.mandateRevision + 1;
    edits.push({ owner: mandateId, name: "version", value: String(next) }, {
      owner: mandateId,
      name: "id",
      value: `builder-v${next}`,
    }, {
      owner: identity.systemId,
      name: "configurationRevision",
      value: String(current.configuration.revision + 1),
    });
    if (change.kind === "reviewer-creation") {
      for (
        const [owner, values] of Object.entries({
          reviewer: {
            operatorId: change.id,
            configuredName: change.name!,
          },
          reviewerMandate: {
            id: "reviewer-v1",
            version: "1",
            scope:
              "Review the exact tested candidate and admit the reviewed candidate",
            source: DYNAMIC_MANDATE_SOURCE,
            evidenceLevel: "configured",
            grantingOperator: "unknown",
            mayProposeReadWebPage: false,
            mayProposeReadWebPageOutline: false,
            mayInvokeActiveCatalog: false,
            mayReviewExactCandidate: change.mandate!.mayReviewExactCandidate,
            mayAdmit: change.mandate!.mayAdmitReviewedCandidates,
            mayActivate: false,
            mayChangeOwnMandate: false,
            mayCreateAgents: false,
          },
        })
      ) {
        for (const [name, value] of Object.entries(values)) {
          const insertion = operations.find((op) =>
            op.op === "insertMember" && op.owner &&
            "qualifiedName" in op.owner &&
            op.owner.qualifiedName === this.#systemQualifiedName &&
            op.text.includes("part reviewer :")
          );
          assert(
            insertion?.op === "insertMember",
            "Missing reviewer insertion",
          );
          insertion.expect.push({ path: `${owner}::${name}`, value });
        }
      }
    }
    {
      const prepared = await applyEdits(
        this.#tooling,
        revision,
        [
          ...operations,
          ...edits.map((edit) => ({
            op: "setFeatureValue" as const,
            target: { elementId: id(owned(revision, edit.owner, edit.name)) },
            value: edit.value,
          })),
        ],
      );
      return {
        ...prepared,
        removedMembers,
        expected: {
          reviewer: change.kind === "reviewer-creation"
            ? { id: change.id, name: change.name! }
            : undefined,
          configurationId: current.configuration.id,
          configurationRevision: current.configuration.revision + 1,
          mandateRevision: next,
          allowedHosts: change.requestedRights &&
              "addNetworkHosts" in change.requestedRights &&
              change.requestedRights.addNetworkHosts
            ? [
              ...current.configuration.network!.allowedHosts,
              ...change.requestedRights.addNetworkHosts,
            ]
            : current.configuration.network!.allowedHosts,
          admissionAuthority: change.requestedRights &&
              "mayAdmitOwnCandidates" in change.requestedRights &&
              change.requestedRights.mayAdmitOwnCandidates === true
            ? "builder"
            : change.kind === "reviewer-creation"
            ? "reviewer" as const
            : current.configuration.builder.admissionAuthority,
          urlSelectionMode: change.requestedRights &&
              "setUrlSelectionMode" in change.requestedRights
            ? change.requestedRights.setUrlSelectionMode
            : current.policy.urlSelectionMode,
        },
      };
    }
  }

  async #compilePrepared(
    sources: Sources,
    version: string,
  ): Promise<SourceRevision> {
    return { ...await this.#tooling.compile(sources), version };
  }

  async #prepareOperatorAuthorityChange(
    base: SourceRevision,
    current: ExecutableModel,
    change: PendingChange,
  ) {
    const mandate = `${this.#systemQualifiedName}::builderMandate`;
    const next = current.configuration.builder.mandateRevision + 1;
    const scalarRequests: HostEditRequest[] = [
      {
        op: "setFeatureValue",
        target: { qualifiedName: `${mandate}::version` },
        value: String(next),
      },
      {
        op: "setFeatureValue",
        target: { qualifiedName: `${mandate}::id` },
        value: `builder-v${next}`,
      },
      {
        op: "setFeatureValue",
        target: {
          qualifiedName: `${this.#systemQualifiedName}::configurationRevision`,
        },
        value: String(current.configuration.revision + 1),
      },
    ];
    const common = {
      systemName: this.#systemQualifiedName,
      changeId: change.id,
    };
    const policyRequest = change.requestedRights &&
        "operatorAuthority" in change.requestedRights
      ? change.requestedRights.operatorAuthority
      : undefined;
    const toolPolicyRequest =
      change.requestedRights && "toolAdmission" in change.requestedRights
        ? change.requestedRights.toolAdmission
        : undefined;
    const creationPolicyRequest = change.requestedRights &&
        "operatorCreation" in change.requestedRights
      ? change.requestedRights.operatorCreation
      : undefined;
    if (
      (policyRequest || toolPolicyRequest) && !isPrimaryDesigner(
        current,
        this.#systemQualifiedName,
        sourceLiterals(base.elements),
      )
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_POLICY_FORBIDDEN",
        "Only the Main Operator can request a policy",
      );
    }
    const teamCreation = change.kind === "operator-creation" &&
      change.operator && isTeamOperatorSpec(change.operator);
    const creationReceipt = change.authorityExercise?.creationDelegation;
    const creationPolicy = teamCreation &&
        (creationReceipt ||
          current.operatorCreationPolicies?.some((policy) =>
            policy.enabled &&
            policy.holderNativeId === current.identity.builderId
          ))
      ? assertCreationWithinPolicy(
        current,
        change.operator!,
        creationReceipt,
        this.#scopeFor(current),
      )
      : undefined;
    if (
      teamCreation &&
      (change.requestedBy !== current.identity.builderId || !change.teamOrigin)
    ) {
      throw new OperatorAuthorityError(
        "INVALID_OPERATOR_REQUEST",
        "A teammate creation requires its exact creator and originating Request",
      );
    }
    const request = change.kind === "operator-creation"
      ? {
        ...common,
        op: "createRequestOperator" as const,
        name: change.name!,
        operator: change.operator!,
        ...(teamCreation
          ? {
            teamOrigin: change.teamOrigin!,
            parentOperatorId: current.identity.builderId,
            creatorMayAddNetworkHosts: current.policy.mayAddNetworkHosts,
            ...(creationPolicy
              ? {
                creationPolicy: {
                  id: creationPolicy.id,
                  revision: creationPolicy.revision,
                  elementId: creationPolicy.elementId,
                },
              }
              : {}),
          }
          : {}),
      }
      : creationPolicyRequest
      ? {
        ...common,
        op: "publishOperatorCreationPolicy" as const,
        policy: creationPolicyRequest,
      }
      : toolPolicyRequest
      ? {
        ...common,
        op: "publishToolAdmissionPolicy" as const,
        policy: toolPolicyRequest,
      }
      : policyRequest
      ? {
        ...common,
        op: "publishOperatorAuthorityPolicy" as const,
        policy: policyRequest,
      }
      : {
        ...common,
        op: "grantModelEditing" as const,
        grant: (change.requestedRights as {
          grantModelEditing:
            import("../../../domain/governance/operator-authority.ts").ModelEditingGrant;
        }).grantModelEditing,
      };
    // One changeset, one immutable base: all preimages now share that base.
    const declaration = await operatorAuthorityRequests(base, request);
    const requests = [...scalarRequests, ...declaration.requests];
    const { compiledRevision, ...prepared } = await applyEdits(
      this.#tooling,
      base,
      requests,
      {
        compile: (sources) => this.#compilePrepared(sources, base.version),
        retainCompiledRevision: true,
      },
    );
    const systemQualifiedName = declaration.systemQualifiedName;
    const verify = async (candidate: SourceRevision) => {
      await verifyEdits(candidate, prepared.edits, { base });
      const actual = await this.#executable(candidate);
      if (
        actual.configuration.revision !== current.configuration.revision + 1 ||
        actual.configuration.builder.mandateRevision !== next ||
        JSON.stringify(actual.configuration.network) !==
          JSON.stringify(current.configuration.network) ||
        actual.configuration.builder.admissionAuthority !==
          current.configuration.builder.admissionAuthority
      ) {
        throw new OperatorAuthorityError(
          "CHANGE_PREVIEW_MISMATCH",
          "The prepared authority edit changed unrelated permissions",
          { changeId: change.id },
        );
      }
      if (creationPolicyRequest) {
        const policyId = await requestedCreationPolicyId(change.id);
        const policy = actual.operatorCreationPolicies?.find((p) =>
          p.id === policyId
        );
        if (
          !policy || policy.revision !== 1 || !policy.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          policy.systemId !== current.identity.systemId ||
          policy.parentPolicyElementId !== undefined ||
          policy.children.length !== 0 || policy.maxDelegationDepth !== 0 ||
          policy.maxChildren !== creationPolicyRequest.maxChildren ||
          policy.mode !== creationPolicyRequest.mode ||
          canonical(policy.networkHosts) !==
            canonical(creationPolicyRequest.networkHosts)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled creation authority differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      if (policyRequest) {
        const policy = actual.operatorAuthorityPolicies?.find((p) =>
          p.id === policyRequest.policyId
        );
        if (
          !policy ||
          policy.revision !== policyRequest.expectedPolicyRevision + 1 ||
          policy.enabled !== policyRequest.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          canonical(policy.recipients) !==
            canonical(policyRequest.recipients) ||
          policy.recipientExecutionSpaceId !==
            policyRequest.recipientExecutionSpaceId ||
          canonical(policy.acts) !== canonical(policyRequest.acts) ||
          canonical(policy.networkHosts) !==
            canonical(policyRequest.networkHosts) ||
          canonical(policy.toolIds) !== canonical(policyRequest.toolIds) ||
          policy.maxDelegationDepth !== policyRequest.maxDelegationDepth
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled operator authority differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      if (toolPolicyRequest) {
        const policy = actual.toolAdmissionPolicies?.find((p) =>
          p.id === toolPolicyRequest.policyId
        );
        if (
          !policy ||
          policy.revision !== toolPolicyRequest.expectedPolicyRevision + 1 ||
          policy.enabled !== toolPolicyRequest.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          canonical(policy.recipients) !==
            canonical(toolPolicyRequest.recipients) ||
          policy.recipientExecutionSpaceId !==
            toolPolicyRequest.recipientExecutionSpaceId ||
          canonical(policy.toolKinds) !==
            canonical(toolPolicyRequest.toolKinds) ||
          policy.maxDelegationDepth !== toolPolicyRequest.maxDelegationDepth
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled tool admission differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      const created = await validateSourceExecutable(
        candidate,
        current.identity.projectId,
        systemQualifiedName,
      );
      if (change.kind === "operator-creation" && change.operator) {
        const spec = change.operator;
        assertOperatorCreationCapacity(
          discoverConversationUnits(base, current.identity.projectId).length,
          discoverConversationUnits(candidate, current.identity.projectId)
            .length,
        );
        if (
          !exactChildCreationGrant(
            created,
            spec.creationGrant,
            creationPolicy?.elementId,
          )
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The native child creation grant differs from its explicit transmission",
          );
        }
      }
      if (teamCreation) {
        const spec = change.operator!;
        if (
          !isTeamOperatorSpec(spec) || created.caseTypes?.length ||
          created.operator?.instruction !== spec.instruction ||
          !matchesTeamProvision(created, spec.provision)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The native teammate differs from its exact approved rights and shared Request contract",
          );
        }
        if (creationPolicy) {
          const updatedPolicy = actual.operatorCreationPolicies?.find((
            policy,
          ) => policy.id === creationPolicy.id);
          if (
            !updatedPolicy ||
            updatedPolicy.children.length !==
              creationPolicy.children.length + 1 ||
            !updatedPolicy.children.includes(created.identity.systemId)
          ) {
            throw new OperatorAuthorityError(
              "CHANGE_PREVIEW_MISMATCH",
              "The native creation did not consume exactly one child slot",
            );
          }
        }
      }
    };
    await verify(
      compiledRevision ??
        await this.#compilePrepared(prepared.sources, base.version),
    );
    return {
      ...prepared,
      verify,
    };
  }

  async previewApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
  ): Promise<PreparedChangeDiff> {
    return (await this.prepareApprovedChangeAt(
      identity,
      await this.repository.current(),
      change,
      expectedDigest,
    )).diff;
  }

  /** Pure exact-revision preparation. It never reads HEAD or publishes sources. */
  async prepareApprovedChangeAt(
    identity: ModelIdentity,
    revision: SourceRevision,
    change: PendingChange,
    expectedDigest: string,
  ): Promise<{ diff: PreparedChangeDiff; sources: Sources }> {
    const base = structuredClone(revision);
    const prepared = await this.#prepareApprovedChange(
      identity,
      base,
      change,
      expectedDigest,
      true,
    );
    // The native compiler also rejects structurally invalid legacy/scalar candidates before display.
    const candidate = "verify" in prepared
      ? undefined
      : await this.#compilePrepared(prepared.sources, base.version);
    if (candidate) await this.#executable(candidate);
    const preview = {
      title: change.kind === "operator-creation"
        ? `Create operator: ${change.name}`
        : change.reason,
      author: change.requestedBy ?? identity.builderId,
      base: {
        repositoryVersion: base.version,
        modelDigest: expectedDigest,
        sourceDigest: await modelSourceDigest(base.sources),
      },
      sourceDigest: await modelSourceDigest(prepared.sources),
      ...compareModelSources(base.sources, prepared.sources),
    };
    // Budget the actual prepared receipt before the proposal is persisted or a
    // person is asked to approve it. Publication still checks the exact trailer.
    const current = await this.#executable(base);
    const budget = changePublication({
      ...change,
      diff: preview,
      status: "approved",
      decidedAt: "2000-01-01T00:00:00.000Z",
      authorityExercise: change.kind === "operator-creation" &&
          change.operator && isTeamOperatorSpec(change.operator)
        ? creationPreviewExercise(current, change, this.#scopeFor(current))
        : exerciseOwnerAuthority(current, "mandate-change"),
    }, current.version);
    budget.edits = prepared.edits;
    assertPublicationSize(budget, APPROVAL_RECEIPT_RESERVE_BYTES);
    return { diff: preview, sources: structuredClone(prepared.sources) };
  }

  async #operationJournal(
    base: SourceRevision,
    candidate: SourceRevision,
    prepared: {
      edits: import("../../../domain/model/editing/host-edit.ts").HostEdit[];
      idMap?: readonly (readonly [string, string])[];
    },
  ) {
    const introducedNames = prepared.edits.flatMap((edit) =>
      edit.op === "insertMember"
        ? (edit.introduced ?? []).map((member) => member.qualifiedName)
        : []
    );
    const nativeIds = candidate.elements.filter((element) =>
      introducedNames.includes(String(element.qualifiedName))
    ).map((element) => String(element["@id"]));
    const inventory = await incarnationInventory(candidate, {
      nativeIds,
      qualifiedNames: introducedNames,
    });
    const introducedIds = new Map(
      inventory.incarnations.map((
        entry,
      ) => [entry.qualifiedName, {
        nativeId: entry.nativeId,
        preimageDigest: entry.preimageDigest,
      }]),
    );
    return buildOperationJournal({
      base: parseModelRevisionRef({
        repositoryId: this.#writer!.repositoryId,
        version: base.version,
      }),
      baseSourceDigest: await modelSourceDigest(base.sources),
      edits: prepared.edits,
      idMap: prepared.idMap,
      introducedIds,
    });
  }

  async applyApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
    originalPublication: ChangePublication,
  ): Promise<ExecutableModel> {
    assertPublicationMatches(change, originalPublication);
    const publication = this.#writer
      ? structuredClone(originalPublication)
      : originalPublication;
    if (this.#writer) {
      const resumed = await this.#writer.resume(change.id, originalPublication);
      if (resumed) {
        this.#verifyStable(identity, resumed);
        return await this.#executable(resumed);
      }
    }
    let verifyPrepared:
      | ((candidate: SourceRevision) => Promise<void>)
      | undefined;
    let captured: {
      edits: import("../../../domain/model/editing/host-edit.ts").HostEdit[];
      idMap?: readonly (readonly [string, string])[];
    } | undefined;
    const prepare = async (revision: SourceRevision) => {
      try {
        if (
          originalPublication.approvedSourceBase && (
            revision.version !==
              originalPublication.approvedSourceBase.repositoryVersion ||
            await modelSourceDigest(revision.sources) !==
              originalPublication.approvedSourceBase.sourceDigest ||
            expectedDigest !==
              originalPublication.approvedSourceBase.modelDigest
          )
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The source base differs from the exact displayed approval",
            { changeId: change.id },
          );
        } else if (
          !this.#writer &&
          !originalPublication.approvedSourceBase &&
          originalPublication.adoptedPin?.repositoryVersion !== undefined &&
          revision.version !==
            originalPublication.adoptedPin.repositoryVersion
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The adopted source pin moved after the displayed approval; reopen the change on the current pin",
            { changeId: change.id },
          );
        }
        const prepared = await this.#prepareApprovedChange(
          identity,
          revision,
          change,
          expectedDigest,
        );
        captured = prepared;
        const actualDiff = change.diff
          ? compareModelSources(revision.sources, prepared.sources)
          : undefined;
        if (
          change.diff && actualDiff &&
          (canonical(change.diff.files) !== canonical(actualDiff.files) ||
            change.diff.patch !== actualDiff.patch)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "Sources differ from the displayed proposal",
            { changeId: change.id },
          );
        }
        if ("verify" in prepared) {
          publication.edits = prepared.edits;
          verifyPrepared = prepared.verify;
        } else if ("expected" in prepared) {
          publication.edits = prepared.edits;
          verifyPrepared = async (candidate) => {
            await verifyEdits(candidate, prepared.edits, { base: revision });
            await assertReinsertedMembers(
              this.#tooling,
              candidate,
              prepared.removedMembers,
            );
            const actual = await this.#executable(candidate);
            const expected = prepared.expected;
            if (
              actual.configuration.id !== expected.configurationId ||
              actual.configuration.revision !==
                expected.configurationRevision ||
              actual.configuration.builder.mandateRevision !==
                expected.mandateRevision ||
              JSON.stringify(actual.configuration.network!.allowedHosts) !==
                JSON.stringify(expected.allowedHosts) ||
              actual.configuration.builder.admissionAuthority !==
                expected.admissionAuthority ||
              actual.policy.urlSelectionMode !== expected.urlSelectionMode ||
              expected.reviewer && (
                  actual.configuration.reviewer?.id !==
                    expected.reviewer.id ||
                  actual.configuration.reviewer?.name !==
                    expected.reviewer.name ||
                  !actual.identity.reviewerId ||
                  !actual.flows.promotion?.nodes.some((node) =>
                    node.mechanism === "review_candidate" &&
                    node.performerId === actual.identity.reviewerId
                  )
                )
            ) {
              throw new HostEditError("READ_BACK_MISMATCH", {
                opIndex: -1,
                op: "setFeatureValue",
                target: hostEditTarget(prepared.edits[0]!),
              }, "Compiled executable differs from the approved host change");
            }
          };
        }
        return prepared.sources;
      } catch (error) {
        throw publicationFailure(error, {
          changeId: change.id,
          systemId: identity.systemId,
        }, "refuse");
      }
    };
    const execute = async () => {
      if (!this.#writer) {
        return await this.repository.updateSystemSources(
          prepare,
          `ase:approved-change:${change.id}`,
          { publication, verify: (candidate) => verifyPrepared?.(candidate) },
        );
      }
      const approvedVersion = publicationSourceVersion(originalPublication);
      assert(approvedVersion, "Approved source base is required");
      const base = await this.repository.at(approvedVersion);
      const sources = await prepare(base);
      const candidate = await this.#compilePrepared(sources, base.version);
      await verifyPrepared?.(candidate);
      const pin = {
        ...(await this.#executable(base)).version,
        repositoryVersion: base.version,
      };
      const dossier = await buildApprovedChangeCommand({
        repositoryId: this.#writer.repositoryId,
        change,
        pin,
        journal: await this.#operationJournal(base, candidate, captured!),
        recipeDigest: await this.#writer.recipeDigest(),
        approval: originalPublication,
      });
      return await this.#writer.publish(dossier);
    };
    const updated = await execute().catch((error) => {
      throw publicationFailure(error, {
        changeId: change.id,
        systemId: identity.systemId,
      }, "retry");
    });
    await assertPublishedEdits(updated, publication, identity.systemId);
    return await this.#executable(updated);
  }

  /** Compatibility verification only: runtime expectations never rewrite sources. */
  async syncConfiguration(
    identity: ModelIdentity,
    configuration: SystemConfiguration,
  ): Promise<ModelIdentity> {
    const executable = await this.readExecutableModel(identity);
    const actual = executable.configuration;
    const shape = (value: SystemConfiguration) => ({
      id: value.id,
      revision: value.revision,
      envelope: value.envelope,
      network: value.network,
      builder: value.builder,
      reviewer: value.reviewer,
    });
    assert(
      JSON.stringify(shape(actual)) === JSON.stringify(shape(configuration)),
      "Runtime configuration differs from admitted SysML; apply an exact approved source change",
    );
    return executable.identity;
  }

  async #binding(
    revision: SourceRevision,
    identity: ModelIdentity,
    candidate: Candidate,
    element: Element,
    active = false,
  ): Promise<ModelBinding> {
    assert(
      element["@type"] === "PartUsage" &&
        reference(element.owner) === identity.catalogId,
      "Candidate does not belong to the bound catalog",
    );
    const type = one(
      revision,
      "AssemblyLiveBuilder::ToolCandidate",
      "PartDefinition",
    );
    assert(
      references(element.type).includes(id(type)),
      "Candidate has the wrong model type",
    );
    const executable = await this.#executable(revision);
    const entry = executable.catalog.find((entry) =>
      entry.nativeId === id(element)
    );
    const contract = executable.contracts.find((contract) =>
      contract.nativeId === entry?.contractId
    );
    assert(
      entry && contract && contract.kind === candidate.kind,
      "Candidate has no matching native contract binding",
    );
    for (
      const [name, expected] of [["name", candidate.name], [
        "kind",
        candidate.kind,
      ], [
        "digest",
        candidate.digest,
      ], ["candidateId", candidate.id]] as const
    ) {
      assert(
        literal(revision, owned(revision, id(element), name)).value ===
          expected,
        `Candidate ${name} read-back mismatch`,
      );
    }
    if (active) {
      assert(
        entry.status === "active",
        "Candidate activation read-back mismatch",
      );
    }
    if (candidate.requiredAuthority) {
      assert(
        literal(revision, owned(revision, id(element), "requiredAuthority"))
          .value === candidate.requiredAuthority,
        "Candidate required authority mismatch",
      );
    }
    if (candidate.proposedConfigurationRevision !== undefined) {
      assert(
        literal(revision, owned(revision, id(element), "configurationRevision"))
          .value === String(candidate.proposedConfigurationRevision),
        "Candidate configuration revision mismatch",
      );
    }
    const qualified = String(element.qualifiedName);
    return {
      elementId: id(element),
      graphPath: qualified.split("::").slice(1).join("."),
    };
  }

  async findCandidate(
    identity: ModelIdentity,
    candidate: Candidate,
  ): Promise<ModelBinding | null> {
    const revision = await this.currentRevision(identity);
    const name = await candidateName(candidate);
    const found = revision.elements.filter((element) =>
      element.declaredName === name &&
      reference(element.owner) === identity.catalogId
    );
    assert(found.length <= 1, "Ambiguous candidate identity");
    return found[0]
      ? this.#binding(revision, identity, candidate, found[0])
      : null;
  }

  async activateCandidate(
    identity: ModelIdentity,
    candidate: Candidate,
    admittedModelDigest: string,
  ): Promise<ModelBinding> {
    const name = await candidateName(candidate);
    const qualifiedName = `${this.#systemQualifiedName}::catalog::${name}`;
    const context = { candidateId: candidate.id, systemId: identity.systemId };
    const head = await this.currentRevision(identity);
    const current = await this.#executable(head);
    const existing = head.elements.filter((element) =>
      element.qualifiedName === qualifiedName
    );
    requireActivation(
      existing.length <= 1,
      "CANDIDATE_AMBIGUOUS",
      context,
      "Ambiguous candidate identity",
    );
    if (existing[0]) {
      const binding = await this.#binding(
        head,
        identity,
        candidate,
        existing[0],
      );
      if (
        current.catalog.some((entry) =>
          entry.nativeId === binding.elementId && entry.status === "active"
        )
      ) return binding;
    }
    // Tests, review and admission were made under one contract. Whatever the
    // authority, a publication under another digest would claim a proof it does
    // not have. The same pin is checked again under the repository lock.
    requireActivation(
      current.version.digest === admittedModelDigest,
      "ADMITTED_MODEL_CHANGED",
      {
        ...context,
        admittedDigest: admittedModelDigest,
        currentDigest: current.version.digest,
      },
      "The model changed after the candidate was admitted",
    );
    const admission = candidate.admission;
    requireActivation(
      admission,
      "ADMISSION_MISSING",
      context,
      "The candidate has no recorded admission",
    );
    requireActivation(
      candidate.tests?.passed === true,
      "TESTS_NOT_PASSED",
      context,
      "The candidate has no successful test report",
    );
    requireActivation(
      admission.candidateId === candidate.id &&
        admission.candidateDigest === candidate.digest,
      "ADMISSION_CANDIDATE_MISMATCH",
      context,
      "The admission targets another candidate or digest",
    );
    requireActivation(
      admission.configurationRevision === current.configuration.revision,
      "ADMISSION_CONFIGURATION_CHANGED",
      {
        ...context,
        admittedRevision: admission.configurationRevision,
        currentRevision: current.configuration.revision,
      },
      "The configuration changed after the candidate was admitted",
    );
    requireActivation(
      ["human", "builder", "reviewer", "delegate"].includes(
        admission.authority,
      ),
      "ADMISSION_AUTHORITY_INVALID",
      context,
      "The admission names an unknown authority",
    );
    requireActivation(
      admission.actorId && admission.reason.trim() && admission.at,
      "ADMISSION_RECORD_INCOMPLETE",
      context,
      "The admission lacks its actor, reason or date",
    );
    const validateDelegation = (model: ExecutableModel) => {
      if (
        admission.authority !== "delegate" &&
        !admission.authorityExercise?.candidateDelegation &&
        !candidate.admissionDecision?.authorityExercise?.candidateDelegation
      ) return;
      try {
        assertCandidateDelegationReceipt(
          model,
          candidate,
          mainExecutionSpace(model.identity),
        );
      } catch (error) {
        throw new CandidateActivationError(
          "ADMISSION_EXERCISE_MISMATCH",
          context,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    validateDelegation(current);
    const exercise = admission.authorityExercise;
    if (exercise) {
      requireActivation(
        exercise.action === "candidate-admission" &&
          exercise.systemId === identity.systemId,
        "ADMISSION_EXERCISE_MISMATCH",
        context,
        "The authority exercise is not a candidate admission of this system",
      );
      requireActivation(
        exercise.baseModelDigest === admittedModelDigest,
        "ADMITTED_MODEL_CHANGED",
        {
          ...context,
          admittedDigest: admittedModelDigest,
          exerciseDigest: exercise.baseModelDigest,
        },
        "The authority exercise was made under another model digest",
      );
    }
    // A system-scoped stable publication key also prevents a retry from undoing
    // a later explicit removal. No separate candidate store is introduced.
    const key = await executionDigest({
      system: identity.systemId,
      candidate: candidate.id,
      purpose: "candidate-activation",
    });
    const changeId = [
      key.slice(0, 8),
      key.slice(8, 12),
      key.slice(12, 16),
      key.slice(16, 20),
      key.slice(20, 32),
    ].join("-");
    const publication: CandidateActivationPublication = {
      type: "candidate-activation",
      changeId,
      systemId: identity.systemId,
      builderId: identity.builderId,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      admission: structuredClone(admission),
      baseModelDigest: current.version.digest,
      baseRevision: current.configuration.revision,
      adoptedPin: {
        digest: current.version.digest,
        repositoryVersion: current.version.repositoryVersion,
      },
      decidedAt: admission.at,
      edits: [],
    };
    const originalPublication = structuredClone(publication);
    if (this.#writer) {
      const resumed = await this.#writer.resume(changeId, originalPublication);
      if (resumed) {
        const latest = await this.currentRevision(identity);
        return await this.#binding(
          latest,
          identity,
          candidate,
          one(latest, qualifiedName, "PartUsage"),
          true,
        );
      }
    }
    let prepared: Awaited<ReturnType<typeof applyEdits>> | undefined;
    let base: SourceRevision;
    // The repository classifies every error raised here as a receipt refusal.
    // Keep the coded refusal so the caller can still read its code.
    let refusal: CandidateActivationError | undefined;
    const coded = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof CandidateActivationError) refusal = error;
        throw error;
      }
    };
    const verify = (revision: SourceRevision) =>
      coded(async () => {
        if (prepared) await verifyEdits(revision, prepared.edits, { base });
        const element = one(revision, qualifiedName, "PartUsage");
        await this.#binding(revision, identity, candidate, element, true);
        requireActivation(
          (await this.#executable(revision)).version.digest ===
            admittedModelDigest,
          "ACTIVATION_CHANGED_CONTRACT",
          context,
          "Candidate activation changed the execution contract",
        );
      });
    const prepare = (revision: SourceRevision) =>
      coded(async () => {
        this.#verify(identity, revision);
        base = revision;
        const executable = await this.#executable(revision);
        requireActivation(
          executable.version.digest === admittedModelDigest,
          "ADMITTED_MODEL_CHANGED",
          {
            ...context,
            admittedDigest: admittedModelDigest,
            currentDigest: executable.version.digest,
          },
          "The model changed while the activation was being prepared",
        );
        const found = revision.elements.filter((element) =>
          element.qualifiedName === qualifiedName
        );
        requireActivation(
          found.length <= 1,
          "CANDIDATE_AMBIGUOUS",
          context,
          "Ambiguous candidate identity",
        );
        let requests: HostEditRequest[];
        if (found[0]) {
          const binding = await this.#binding(
            revision,
            identity,
            candidate,
            found[0],
          );
          const entry = executable.catalog.find((entry) =>
            entry.nativeId === binding.elementId
          )!;
          if (entry.status === "active") return revision.sources;
          validateDelegation(executable);
          requests = [{
            op: "setFeatureValue",
            target: { qualifiedName: `${qualifiedName}::status` },
            value: "active",
          }];
        } else {
          validateDelegation(executable);
          const contracts = executable.contracts.filter((contract) =>
            contract.kind === candidate.kind
          );
          requireActivation(
            contracts.length === 1,
            "CONTRACT_NOT_UNIQUE",
            { ...context, kind: candidate.kind, count: contracts.length },
            "Expected one admitted candidate contract",
          );
          const contract = revision.elements.find((element) =>
            element["@id"] === contracts[0]!.nativeId &&
            element["@type"] === "ItemUsage" &&
            reference(element.owner) === identity.catalogId
          );
          requireActivation(
            contract,
            "CONTRACT_NOT_OWNED",
            context,
            "Candidate contract is not owned by the bound catalog",
          );
          const path = String(contract.qualifiedName).split("::");
          requireActivation(
            path.length >= 4 && String(contract.qualifiedName).startsWith(
              `${this.#systemQualifiedName}::catalog::`,
            ) &&
              path.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)),
            "CONTRACT_PATH_UNSUPPORTED",
            context,
            "Candidate contract requires a supported absolute native feature path",
          );
          const contractPath = `${path[0]}::${path.slice(1).join(".")}`;
          const values: Array<[string, string]> = [
            ["name", candidate.name],
            ["kind", candidate.kind],
            ["digest", candidate.digest],
            ["candidateId", candidate.id],
          ];
          if (candidate.requiredAuthority) {
            values.push(["requiredAuthority", candidate.requiredAuthority]);
          }
          if (candidate.proposedConfigurationRevision !== undefined) {
            values.push([
              "configurationRevision",
              String(candidate.proposedConfigurationRevision),
            ]);
          }
          const declaration = `part ${name} : ${
            productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder::ToolCandidate",
            )
          } {\n${
            values.map(([key, value]) =>
              `    attribute ${key} : ScalarValues::String = ${
                spelling(value)
              };`
            ).join("\n")
          }\n    bind contract = ${contractPath};\n}`;
          requests = [{
            op: "insertMember",
            owner: { qualifiedName: `${this.#systemQualifiedName}::catalog` },
            text: declaration,
            expect: values.map(([key, value]) => ({
              kind: "literal",
              path: `${name}::${key}`,
              value,
            })),
          }];
        }
        prepared = await applyEdits(this.#tooling, revision, requests, {
          compile: (sources) =>
            this.#compilePrepared(sources, revision.version),
        });
        publication.edits = prepared.edits;
        assertPublicationSize(publication);
        return prepared.sources;
      });
    let revision: SourceRevision;
    try {
      if (this.#writer) {
        const sources = await prepare(head);
        const compiled = await this.#compilePrepared(sources, head.version);
        await verify(compiled);
        const dossier = await buildActivationCommand({
          repositoryId: this.#writer.repositoryId,
          approval: originalPublication,
          candidate,
          journal: await this.#operationJournal(head, compiled, prepared!),
          recipeDigest: await this.#writer.recipeDigest(),
        });
        revision = await this.#writer.publish(dossier);
      } else {
        revision = await this.repository.updateSystemSources(
          prepare,
          `ase:activate-candidate:${identity.builderId}`,
          { publication, verify },
        );
      }
    } catch (error) {
      if (refusal) throw refusal;
      // Two callers can pin different repository heads for the same unchanged
      // contract before either publishes. Recover only an exact active HEAD;
      // a removed or changed occurrence still propagates the receipt refusal.
      if (
        error instanceof ChangePublicationError &&
        error.code === "PUBLICATION_RECEIPT_MISMATCH"
      ) {
        try {
          const latest = await this.currentRevision(identity);
          return await this.#binding(
            latest,
            identity,
            candidate,
            one(latest, qualifiedName, "PartUsage"),
            true,
          );
        } catch { /* Preserve the original publication refusal. */ }
      }
      throw error;
    }
    if (publication.edits.length) {
      await assertPublishedEdits(revision, publication, identity.systemId);
    }
    // The repository may have recovered an immutable publication. Read HEAD too:
    // a subsequent remove or replacement must never be undone by this retry.
    const latest = await this.currentRevision(identity);
    return await this.#binding(
      latest,
      identity,
      candidate,
      one(latest, qualifiedName, "PartUsage"),
      true,
    );
  }

  async graph(identity: ModelIdentity) {
    const revision = await this.currentRevision(identity);
    const graph = projectSourceGraph(
      revision.elements,
      this.#identity(revision),
    );
    // The declaration carries a status only for legacy or non-active entries;
    // its absence means active, exactly as the executable model reads it.
    const type = one(
      revision,
      "AssemblyLiveBuilder::ToolCandidate",
      "PartDefinition",
    );
    const implicit = new Set(
      revision.elements.filter((element) =>
        element["@type"] === "PartUsage" &&
        reference(element.owner) === identity.catalogId &&
        references(element.type).includes(id(type)) &&
        !revision.elements.some((entry) =>
          reference(entry.owner) === id(element) &&
          entry.declaredName === "status"
        )
      ).map((element) => id(element)),
    );
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        implicit.has(node.nativeId) && node.modelStage === undefined
          ? { ...node, modelStage: "active" }
          : node
      ),
      modelRevision: revision.version,
    };
  }
}

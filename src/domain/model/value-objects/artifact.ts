import { sha256Bytes as sha256 } from "../../primitives/sha256-bytes.ts";
import { persistedOrder } from "../../primitives/persisted-order.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { modelSourceDigest } from "./sources.ts";
/** Bumped whenever the semantic IR shape changes; part of recipe R. */
export const IR_VERSION = "0.1";
/** ASE Semantic IR v0.1 materialization. Provider properties stay in an immutable artifact. */
import type {
  CompiledModel,
  CompilerDescriptor,
  JsonObject,
} from "../records/compiled-model.ts";
import type { ModelSources as Sources } from "./sources.ts";
export { sha256Bytes as sha256 } from "../../primitives/sha256-bytes.ts";
function documentId(kind: string, id: string): string {
  const mapped = {
    Element: "ElementV0",
    Relationship: "RelationshipV0",
    Endpoint: "EndpointV0",
    Origin: "OriginV0",
  }[kind] ?? kind;
  return mapped + "/" + id;
}
function refs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry && typeof entry === "object" &&
      typeof (entry as JsonObject)["@id"] === "string"
      ? [(entry as JsonObject)["@id"] as string]
      : []
  );
}
export async function materialize(
  elements: JsonObject[],
  sources: Sources,
  engineVersion: string,
  provider?: CompilerDescriptor,
): Promise<CompiledModel> {
  const idsSeen = new Set<string>();
  for (const element of elements) {
    if (
      typeof element["@id"] !== "string" ||
      typeof element["@type"] !== "string" || idsSeen.has(element["@id"])
    ) {
      throw new Error(
        "Compiler artifact contains missing or duplicate native identities",
      );
    }
    idsSeen.add(element["@id"]);
  }
  const sourcePathDocuments: JsonObject[] = [];
  const sourceSnapshotDocuments: JsonObject[] = [];
  const sourcePathIds = new Map<string, string>();
  const sourceHashes: Record<string, string> = {};
  for (const path of Object.keys(sources).sort()) {
    const bytes = new TextEncoder().encode(sources[path]);
    const hash = await sha256(bytes);
    const pathId = "SourcePathV0/" + await sha256(path);
    const snapshotId = "SourceSnapshotV0/" + await sha256(path + "\0" + hash);
    sourcePathIds.set(path, pathId);
    sourceHashes[path] = hash;
    sourcePathDocuments.push({ "@id": pathId, "@type": "SourcePathV0", path });
    sourceSnapshotDocuments.push({
      "@id": snapshotId,
      "@type": "SourceSnapshotV0",
      source_path: pathId,
      sha256: hash,
      byte_length: bytes.length,
      content: sources[path],
    });
  }
  const sourceDigest = await modelSourceDigest(sources);
  const sourceNameFor = (element: JsonObject): string | undefined => {
    const path = element["sysx:sourceDocument"];
    return typeof path === "string" && Object.hasOwn(sources, path)
      ? path
      : undefined;
  };
  const ids = new Set(
    elements.flatMap((element) =>
      typeof element["@id"] === "string" ? [element["@id"] as string] : []
    ),
  );
  const byId = new Map(
    elements.flatMap((element) =>
      typeof element["@id"] === "string"
        ? [[element["@id"] as string, element] as const]
        : []
    ),
  );
  const relationSpecs: Array<{
    nativeId: string;
    metaclass: string;
    ownerId?: string;
    endpoints: Array<{ role: string; target: string }>;
    predicate?: string;
    isNegated?: boolean;
    isElse?: boolean;
    replacesElement: boolean;
  }> = [];
  for (const element of elements) {
    if (element["toolkit:catalogOnly"] === true) continue;
    const nativeId = element["@id"];
    if (typeof nativeId !== "string") continue;
    const metaclass = String(element["@type"] ?? "Unknown");
    const ownerId = element.owner && typeof element.owner === "object"
      ? (element.owner as JsonObject)["@id"]
      : undefined;
    let sourceIdsForRelation = refs(element.source).filter((id) => ids.has(id));
    let targetIds = refs(element.target).filter((id) => ids.has(id));
    if (
      metaclass === "SuccessionAsUsage" &&
      (!sourceIdsForRelation.length || !targetIds.length)
    ) {
      sourceIdsForRelation = refs(element.sourceFeature).filter((id) =>
        ids.has(id)
      );
      if (!sourceIdsForRelation.length) {
        sourceIdsForRelation = refs(element["sysx:sourceMember"]).filter((id) =>
          ids.has(id)
        );
      }
      targetIds = refs(element.targetFeature).filter((id) => ids.has(id));
    }
    if (
      (!sourceIdsForRelation.length || !targetIds.length) &&
      Array.isArray(element.connectorEnd)
    ) {
      const connectorTargets = refs(element.connectorEnd).flatMap((endId) => {
        const end = byId.get(endId);
        if (!end) return [];
        const subsettingId = end.ownedReferenceSubsetting &&
            typeof end.ownedReferenceSubsetting === "object"
          ? (end.ownedReferenceSubsetting as JsonObject)["@id"]
          : undefined;
        if (typeof subsettingId !== "string") return [];
        const subsetting = byId.get(subsettingId);
        return subsetting
          ? refs(subsetting.target).filter((id) => ids.has(id))
          : [];
      });
      if (connectorTargets.length >= 2) {
        sourceIdsForRelation = [connectorTargets[0]];
        targetIds = connectorTargets.slice(1);
      }
    }
    let endpointSpecs: Array<{ role: string; target: string }> = [];
    if (metaclass === "FeatureValue") {
      endpointSpecs = [
        ...refs(element.featureWithValue).filter((id) => ids.has(id)).map(
          (target) => ({ role: "feature", target }),
        ),
        ...refs(element.value).filter((id) => ids.has(id)).map((target) => ({
          role: "value",
          target,
        })),
      ];
    } else if (metaclass === "ResultExpressionMembership") {
      endpointSpecs = [
        ...refs(element.owningType).filter((id) => ids.has(id)).map(
          (target) => ({ role: "constraint", target }),
        ),
        ...refs(element.memberElement).filter((id) => ids.has(id)).map(
          (target) => ({ role: "resultExpression", target }),
        ),
      ];
    } else if (metaclass === "SatisfyRequirementUsage") {
      endpointSpecs = [
        ...refs(element.subject).filter((id) => ids.has(id)).map((target) => ({
          role: "subject",
          target,
        })),
        ...refs(element.subsets).filter((id) => ids.has(id)).map((target) => ({
          role: "requirement",
          target,
        })),
      ];
    } else if (sourceIdsForRelation.length && targetIds.length) {
      endpointSpecs = [
        ...sourceIdsForRelation.map((target) => ({ role: "source", target })),
        ...targetIds.map((target) => ({ role: "target", target })),
      ];
    }
    if (metaclass === "TransitionUsage" && endpointSpecs.length) {
      endpointSpecs.push(
        ...refs(element.guardExpression).filter((id) => ids.has(id)).map(
          (target) => ({ role: "guard", target }),
        ),
        ...refs(element.triggerAction).filter((id) => ids.has(id)).map(
          (target) => ({ role: "trigger", target }),
        ),
        ...refs(element.succession).filter((id) => ids.has(id)).map(
          (target) => ({ role: "succession", target }),
        ),
      );
    }
    if (endpointSpecs.length >= 2) {
      relationSpecs.push({
        nativeId,
        metaclass,
        ownerId: typeof ownerId === "string" ? ownerId : undefined,
        endpoints: endpointSpecs,
        isNegated: typeof element.isNegated === "boolean"
          ? element.isNegated
          : undefined,
        isElse: typeof element["sysx:isElse"] === "boolean"
          ? element["sysx:isElse"]
          : undefined,
        replacesElement: true,
      });
    }
    const arguments_ = refs(element.argument).filter((id) => ids.has(id));
    if (metaclass === "OperatorExpression" && arguments_.length) {
      relationSpecs.push({
        nativeId: `${nativeId}:arguments`,
        metaclass: "ExpressionArguments",
        ownerId: nativeId,
        endpoints: arguments_.map((target) => ({ role: "argument", target })),
        predicate: typeof element.operator === "string"
          ? element.operator
          : undefined,
        replacesElement: false,
      });
    }
    const referents = refs(element.referent).filter((id) => ids.has(id));
    if (metaclass === "FeatureReferenceExpression" && referents.length) {
      relationSpecs.push({
        nativeId: `${nativeId}:referent`,
        metaclass: "ExpressionReferent",
        ownerId: nativeId,
        endpoints: referents.map((target) => ({ role: "referent", target })),
        predicate: "referent",
        replacesElement: false,
      });
    }
    const targetFeatures = refs(element.targetFeature).filter((id) =>
      ids.has(id)
    );
    const chainArguments = refs(element.argument).filter((id) => ids.has(id));
    if (
      metaclass === "FeatureChainExpression" && chainArguments.length &&
      targetFeatures.length
    ) {
      relationSpecs.push({
        nativeId: `${nativeId}:featureChain`,
        metaclass: "ExpressionFeatureChain",
        ownerId: nativeId,
        endpoints: [
          ...chainArguments.map((target) => ({ role: "argument", target })),
          ...targetFeatures.map((target) => ({
            role: "targetFeature",
            target,
          })),
        ],
        predicate: "featureChain",
        replacesElement: false,
      });
    }
    const payloadParameters = refs(element.payloadParameter).filter((id) =>
      ids.has(id)
    );
    if (metaclass === "AcceptActionUsage" && payloadParameters.length) {
      relationSpecs.push({
        nativeId: `${nativeId}:payload`,
        metaclass: "TriggerPayload",
        ownerId: nativeId,
        endpoints: payloadParameters.map((target) => ({
          role: "payload",
          target,
        })),
        predicate: "payload",
        replacesElement: false,
      });
    }
  }
  const rawOfType = (metaclass: string): JsonObject[] =>
    elements.filter((element) =>
      element["@type"] === metaclass && element["toolkit:catalogOnly"] !== true
    );
  const primarySpecsOfType = (metaclass: string) =>
    relationSpecs.filter((spec) =>
      spec.replacesElement && spec.metaclass === metaclass
    );
  const requireComplete = (metaclass: string): void => {
    const raw = rawOfType(metaclass);
    const extracted = primarySpecsOfType(metaclass);
    if (raw.length !== extracted.length) {
      throw new Error(
        `IR extraction incomplete for ${metaclass}: ${extracted.length}/${raw.length}`,
      );
    }
  };
  for (
    const metaclass of [
      "FeatureTyping",
      "ReferenceSubsetting",
      "FeatureChaining",
      "Redefinition",
      "ConjugatedPortTyping",
      "PortConjugation",
      "Subclassification",
      "BindingConnectorAsUsage",
      "ConnectionUsage",
      "AllocationUsage",
      "TransitionUsage",
      "SatisfyRequirementUsage",
      "FeatureValue",
      "ResultExpressionMembership",
    ]
  ) requireComplete(metaclass);
  for (const spec of primarySpecsOfType("TransitionUsage")) {
    const raw = byId.get(spec.nativeId);
    if (!raw) throw new Error(`Missing raw transition: ${spec.nativeId}`);
    const roles = spec.endpoints.map((endpoint) => endpoint.role);
    const expectedSources = refs(raw.source).length;
    const expectedTargets = refs(raw.target).length;
    const expectedGuards = refs(raw.guardExpression).length;
    const expectedTriggers = refs(raw.triggerAction).length;
    const expectedSuccessions = refs(raw.succession).length;
    if (
      expectedSources !== 1 ||
      roles.filter((role) => role === "source").length !== expectedSources ||
      expectedTargets !== 1 ||
      roles.filter((role) => role === "target").length !== expectedTargets ||
      expectedSuccessions !== 1 ||
      roles.filter((role) => role === "succession").length !==
        expectedSuccessions ||
      expectedGuards > 1 ||
      roles.filter((role) => role === "guard").length !== expectedGuards ||
      expectedTriggers > 1 ||
      roles.filter((role) => role === "trigger").length !== expectedTriggers
    ) throw new Error(`Invalid transition endpoints: ${spec.nativeId}`);
  }
  for (const spec of primarySpecsOfType("SatisfyRequirementUsage")) {
    const raw = byId.get(spec.nativeId);
    if (!raw) throw new Error(`Missing raw satisfaction: ${spec.nativeId}`);
    const roles = spec.endpoints.map((endpoint) => endpoint.role);
    const expectedSubjects = refs(raw.subject).length;
    const expectedRequirements = refs(raw.subsets).length;
    if (
      expectedSubjects !== 1 ||
      roles.filter((role) => role === "subject").length !== expectedSubjects ||
      expectedRequirements !== 1 ||
      roles.filter((role) => role === "requirement").length !==
        expectedRequirements
    ) throw new Error(`Invalid satisfaction endpoints: ${spec.nativeId}`);
  }
  for (
    const [metaclass, left, right] of [
      ["FeatureValue", "feature", "value"],
      ["ResultExpressionMembership", "constraint", "resultExpression"],
    ] as const
  ) {
    for (const spec of primarySpecsOfType(metaclass)) {
      const raw = byId.get(spec.nativeId);
      if (!raw) throw new Error(`Missing raw ${metaclass}: ${spec.nativeId}`);
      const roles = spec.endpoints.map((endpoint) => endpoint.role);
      const [leftField, rightField] = metaclass === "FeatureValue"
        ? ["featureWithValue", "value"]
        : ["owningType", "memberElement"];
      const expectedLeft = refs(raw[leftField]).length;
      const expectedRight = refs(raw[rightField]).length;
      if (
        expectedLeft !== 1 ||
        roles.filter((role) => role === left).length !== expectedLeft ||
        expectedRight !== 1 ||
        roles.filter((role) => role === right).length !== expectedRight
      ) throw new Error(`Invalid ${metaclass} endpoints: ${spec.nativeId}`);
    }
  }
  const syntheticCounts = new Map([
    ["ExpressionArguments", rawOfType("OperatorExpression").length],
    ["ExpressionReferent", rawOfType("FeatureReferenceExpression").length],
    ["ExpressionFeatureChain", rawOfType("FeatureChainExpression").length],
    ["TriggerPayload", rawOfType("AcceptActionUsage").length],
  ]);
  for (const [metaclass, expected] of syntheticCounts) {
    const extracted = relationSpecs.filter((spec) =>
      !spec.replacesElement && spec.metaclass === metaclass
    );
    if (
      extracted.length !== expected ||
      extracted.some((spec) => !spec.endpoints.length)
    ) {
      throw new Error(
        `IR extraction incomplete for ${metaclass}: ${extracted.length}/${expected}`,
      );
    }
  }
  for (
    const spec of relationSpecs.filter((candidate) =>
      candidate.metaclass === "ExpressionArguments"
    )
  ) {
    const raw = spec.ownerId ? byId.get(spec.ownerId) : undefined;
    const expectedArguments = raw ? refs(raw.argument).length : 0;
    const actualArguments = spec.endpoints.filter((endpoint) =>
      endpoint.role === "argument"
    ).length;
    if (expectedArguments < 1 || actualArguments !== expectedArguments) {
      throw new Error(`Invalid expression arguments: ${spec.nativeId}`);
    }
  }
  for (
    const spec of relationSpecs.filter((candidate) =>
      candidate.metaclass === "ExpressionFeatureChain"
    )
  ) {
    const raw = spec.ownerId ? byId.get(spec.ownerId) : undefined;
    const expectedArguments = raw ? refs(raw.argument).length : 0;
    const expectedTargetFeatures = raw ? refs(raw.targetFeature).length : 0;
    const roles = spec.endpoints.map((endpoint) => endpoint.role);
    if (
      expectedArguments !== 1 ||
      roles.filter((role) => role === "argument").length !==
        expectedArguments ||
      expectedTargetFeatures !== 1 ||
      roles.filter((role) => role === "targetFeature").length !==
        expectedTargetFeatures
    ) throw new Error(`Invalid feature-chain endpoints: ${spec.nativeId}`);
  }
  for (
    const spec of relationSpecs.filter((candidate) =>
      candidate.metaclass === "ExpressionReferent" ||
      candidate.metaclass === "TriggerPayload"
    )
  ) {
    const raw = spec.ownerId ? byId.get(spec.ownerId) : undefined;
    const role = spec.metaclass === "ExpressionReferent"
      ? "referent"
      : "payload";
    const field = spec.metaclass === "ExpressionReferent"
      ? "referent"
      : "payloadParameter";
    const expected = raw ? refs(raw[field]).length : 0;
    const actual = spec.endpoints.filter((endpoint) => endpoint.role === role)
      .length;
    if (
      expected !== 1 || actual !== expected || spec.endpoints.length !== actual
    ) {
      throw new Error(`Invalid unary relation endpoints: ${spec.nativeId}`);
    }
  }
  const transitionSuccessionIds = new Set(
    rawOfType("TransitionUsage").flatMap((transition) =>
      refs(transition.succession)
    ),
  );
  const explicitSuccessionIds = new Set(
    primarySpecsOfType("SuccessionAsUsage").map((spec) => spec.nativeId),
  );
  const unaccountedSuccessions = rawOfType("SuccessionAsUsage").filter(
    (succession) =>
      !explicitSuccessionIds.has(String(succession["@id"])) &&
      !transitionSuccessionIds.has(String(succession["@id"])),
  );
  if (unaccountedSuccessions.length) {
    throw new Error(
      `Unaccounted successions: ${
        unaccountedSuccessions.map((item) => item["@id"]).join(",")
      }`,
    );
  }
  const relationIds = new Set(
    relationSpecs.filter((spec) => spec.replacesElement).map((spec) =>
      spec.nativeId
    ),
  );
  const objectId = (nativeId: string): string =>
    documentId(
      relationIds.has(nativeId) ? "Relationship" : "Element",
      nativeId,
    );
  const elementDocuments = elements.filter((element) =>
    !relationIds.has(element["@id"] as string)
  ).map((element) => {
    const id = element["@id"] as string;
    const ownerId = element.owner && typeof element.owner === "object"
      ? (element.owner as JsonObject)["@id"]
      : undefined;
    const value = element.value;
    return {
      "@id": documentId("Element", id),
      "@type": "ElementV0",
      native_id: id,
      metaclass: String(element["@type"] ?? "Unknown"),
      owner: typeof ownerId === "string" && ids.has(ownerId)
        ? objectId(ownerId)
        : undefined,
      name: typeof element.declaredName === "string"
        ? element.declaredName
        : undefined,
      qualified_name: typeof element.qualifiedName === "string"
        ? element.qualifiedName
        : undefined,
      member_index: typeof element["sysx:memberIndex"] === "number"
        ? element["sysx:memberIndex"]
        : undefined,
      operator: typeof element.operator === "string"
        ? element.operator
        : undefined,
      documentation: typeof element.body === "string" &&
          element["@type"] === "Documentation"
        ? element.body
        : undefined,
      text_value: typeof value === "string" ? value : undefined,
      boolean_value: typeof value === "boolean" ? value : undefined,
      integer_value: typeof value === "number" && Number.isInteger(value)
        ? value
        : undefined,
      real_value: typeof value === "number" && !Number.isInteger(value)
        ? value
        : undefined,
      direction: typeof element.direction === "string"
        ? element.direction
        : undefined,
      is_end: typeof element.isEnd === "boolean" ? element.isEnd : undefined,
      is_reference: typeof element.isReference === "boolean"
        ? element.isReference
        : undefined,
      has_body: typeof element["sysx:hasBody"] === "boolean"
        ? element["sysx:hasBody"]
        : undefined,
      is_else: typeof element["sysx:isElse"] === "boolean"
        ? element["sysx:isElse"]
        : undefined,
      declared_id: typeof element["sysx:declaredId"] === "boolean"
        ? element["sysx:declaredId"]
        : undefined,
    };
  });
  const endpointDocuments: JsonObject[] = [];
  const relationshipDocuments: JsonObject[] = [];
  for (const spec of relationSpecs) {
    const nativeId = spec.nativeId;
    const endpointIds: string[] = [];
    for (let index = 0; index < spec.endpoints.length; index++) {
      const endpoint = spec.endpoints[index];
      const id = documentId("Endpoint", `${nativeId}/${index}`);
      endpointIds.push(id);
      endpointDocuments.push({
        "@id": id,
        "@type": "EndpointV0",
        role: endpoint.role,
        position: index,
        target: objectId(endpoint.target),
      });
    }
    relationshipDocuments.push({
      "@id": documentId("Relationship", nativeId),
      "@type": "RelationshipV0",
      native_id: nativeId,
      metaclass: spec.metaclass,
      owner: typeof spec.ownerId === "string" && ids.has(spec.ownerId)
        ? objectId(spec.ownerId)
        : undefined,
      predicate: spec.predicate,
      is_negated: spec.isNegated,
      is_else: spec.isElse,
      endpoints: endpointIds.toSorted(),
    });
  }
  const originDocuments = elements.flatMap((element) => {
    const id = element["@id"];
    const sourceName = sourceNameFor(element);
    if (typeof id !== "string" || !sourceName) return [];
    return [{
      "@id": documentId("Origin", id),
      "@type": "OriginV0",
      object: objectId(id),
      source_path: sourcePathIds.get(sourceName),
      start_line: typeof element["sysx:sourceLine"] === "number"
        ? element["sysx:sourceLine"]
        : undefined,
      start_column: typeof element["sysx:sourceColumn"] === "number"
        ? element["sysx:sourceColumn"]
        : undefined,
      end_line: typeof element["sysx:sourceEndLine"] === "number"
        ? element["sysx:sourceEndLine"]
        : undefined,
      end_column: typeof element["sysx:sourceEndColumn"] === "number"
        ? element["sysx:sourceEndColumn"]
        : undefined,
      source_text: typeof element["sysx:sourceText"] === "string"
        ? element["sysx:sourceText"]
        : undefined,
    }];
  });
  const semanticDocuments = [
    ...elementDocuments,
    ...endpointDocuments,
    ...relationshipDocuments,
  ];
  // Native IDs admit arbitrary strings; retain legacy en-US ordering at all three
  // digest sites, including prefixed semantic and origin document IDs.
  const semanticDigest = await sha256(canonical(
    semanticDocuments.toSorted((left, right) =>
      persistedOrder(String(left["@id"]), String(right["@id"]))
    ),
  ));
  const provenanceDigest = await sha256(canonical(
    originDocuments.toSorted((left, right) =>
      persistedOrder(String(left["@id"]), String(right["@id"]))
    ),
  ));
  const providerContent = canonical(
    elements.toSorted((left, right) =>
      persistedOrder(String(left["@id"]), String(right["@id"]))
    ),
  );
  const providerHash = await sha256(providerContent);
  const artifact: JsonObject = {
    "@id": `ProviderArtifactV0/${providerHash}`,
    "@type": "ProviderArtifactV0",
    format: provider?.format ?? "ase-native-json-v1",
    sha256: providerHash,
    content: providerContent,
  };
  const build: JsonObject = {
    "@id": `ModelBuildV0/${sourceDigest}`,
    "@type": "ModelBuildV0",
    source_digest: sourceDigest,
    semantic_digest: semanticDigest,
    provenance_digest: provenanceDigest,
    engine: provider?.name ?? "ASE",
    engine_version: engineVersion,
    ir_version: IR_VERSION,
    provider_artifact: artifact["@id"],
    sources: sourceSnapshotDocuments.map((document) => document["@id"]).sort(),
    elements: elementDocuments.map((document) => document["@id"]).sort(),
    relationships: relationshipDocuments.map((document) => document["@id"])
      .sort(),
    origins: originDocuments.map((document) => document["@id"]).sort(),
  };
  return {
    ...(provider ? { provider } : {}),
    sources,
    elements,
    semanticDigest,
    provenanceDigest,
    sourceDigest,
    sourceHashes,
    engineVersion,
    documents: [
      ...sourcePathDocuments,
      ...sourceSnapshotDocuments,
      ...elementDocuments,
      ...endpointDocuments,
      ...relationshipDocuments,
      ...originDocuments,
      artifact,
      build,
    ],
  };
}
